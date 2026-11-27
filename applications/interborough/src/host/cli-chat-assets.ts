import { readFile } from 'node:fs/promises';

import { catalogCall, type CliTarget } from './cli-client-transport.ts';
import type { CliClientDependencies, Parsed } from './cli-client.ts';

function resultOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

/** Uploads an attachment as raw bytes through Bureau's managed asset lifecycle. */
export async function uploadAttachment(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
  path: string,
): Promise<Record<string, unknown>> {
  const bytes = await readFile(path);
  const created = await catalogCall(target, parsed, dependencies, 'bureau.assets.uploads.create', {
    declaredByteLength: bytes.byteLength,
  });
  const uploadId = resultOf(created.data)['uploadId'];
  if (typeof uploadId !== 'string')
    throw new Error('The host returned no asset upload identifier.');
  try {
    const chunkSize = 256 * 1024;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      await catalogCall(target, parsed, dependencies, 'bureau.assets.uploads.append', {
        uploadId,
        chunk: Buffer.from(
          bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)),
        ).toString('base64'),
      });
    }
    const completed = await catalogCall(
      target,
      parsed,
      dependencies,
      'bureau.assets.uploads.complete',
      { uploadId },
    );
    return resultOf(completed.data);
  } catch (error) {
    try {
      await catalogCall(target, parsed, dependencies, 'bureau.assets.uploads.abort', { uploadId });
    } catch {
      // The original mutation error is the actionable result; abort is best-effort cleanup.
    }
    throw error;
  }
}
