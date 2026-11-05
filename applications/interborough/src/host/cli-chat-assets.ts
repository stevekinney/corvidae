import { readFile } from 'node:fs/promises';

import { request, type CliTarget } from './cli-client-transport.ts';
import type { CliClientDependencies, Parsed } from './cli-client.ts';

function resultOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

async function call(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await request(target, '/jsonrpc', parsed, dependencies, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
  });
  const body = resultOf(response.data);
  return resultOf(body['result']);
}

/** Uploads an attachment as raw bytes through Bureau's managed asset lifecycle. */
export async function uploadAttachment(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
  path: string,
): Promise<Record<string, unknown>> {
  const bytes = await readFile(path);
  const created = await call(target, parsed, dependencies, 'bureau.assets.uploads.create', {
    declaredByteLength: bytes.byteLength,
    declaredMediaType: 'application/octet-stream',
  });
  const uploadId = typeof created['uploadId'] === 'string' ? created['uploadId'] : undefined;
  if (uploadId === undefined) throw new Error('The host returned no asset upload identifier.');
  try {
    await call(target, parsed, dependencies, 'bureau.assets.uploads.append', {
      uploadId,
      chunk: Buffer.from(bytes).toString('base64'),
    });
    return await call(target, parsed, dependencies, 'bureau.assets.uploads.complete', { uploadId });
  } catch (error) {
    try {
      await call(target, parsed, dependencies, 'bureau.assets.uploads.abort', { uploadId });
    } catch {
      // The original mutation error is the actionable result; abort is best-effort cleanup.
    }
    throw error;
  }
}
