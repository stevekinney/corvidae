import { link, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { request, requestBytes, type CliTarget } from './cli-client-transport.ts';
import type { CliClientDependencies, CliCommandResult, Parsed } from './cli-client.ts';

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function option(parsed: Parsed, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

async function rpc(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
  method: string,
  params: RecordValue,
) {
  const response = await request(target, '/bureau/jsonrpc', parsed, dependencies, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `cli-${crypto.randomUUID()}`, method, params }),
  });
  const body = record(response.data);
  return Object.hasOwn(body, 'result') ? { ...response, data: body['result'] } : response;
}

function inputPath(parsed: Parsed): string {
  const path = option(parsed, 'file') ?? parsed.arguments[1];
  if (path === undefined || path === '')
    throw Object.assign(new Error('assets upload requires --file.'), { usage: true });
  return path;
}

async function upload(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const bytes = await readFile(inputPath(parsed));
  const createdResponse = await rpc(target, parsed, dependencies, 'bureau.assets.uploads.create', {
    declaredByteLength: bytes.byteLength,
    ...(option(parsed, 'media-type') === undefined
      ? {}
      : { declaredMediaType: option(parsed, 'media-type') }),
  });
  const created = record(createdResponse.data);
  const uploadId = typeof created['uploadId'] === 'string' ? created['uploadId'] : undefined;
  if (uploadId === undefined) throw new Error('The host returned no asset upload identifier.');
  try {
    const chunkSize = 256 * 1024;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize)
      await rpc(target, parsed, dependencies, 'bureau.assets.uploads.append', {
        uploadId,
        chunk: Buffer.from(
          bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)),
        ).toString('base64'),
      });
    return await rpc(target, parsed, dependencies, 'bureau.assets.uploads.complete', { uploadId });
  } catch (error) {
    try {
      await rpc(target, parsed, dependencies, 'bureau.assets.uploads.abort', { uploadId });
    } catch {
      /* preserve original mutation result */
    }
    throw error;
  }
}

async function download(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const assetId = parsed.arguments[1];
  const outputFile = option(parsed, 'output-file');
  if (assetId === undefined || assetId === '')
    throw Object.assign(new Error('assets download requires an asset identifier.'), {
      usage: true,
    });
  if (outputFile === undefined)
    throw Object.assign(new Error('assets download requires --output-file.'), { usage: true });
  if (parsed.output === 'json' && outputFile === '-')
    throw Object.assign(new Error('--output-file - cannot be combined with --output json.'), {
      usage: true,
    });
  const descriptorResponse = await rpc(target, parsed, dependencies, 'bureau.assets.get', {
    assetId,
  });
  const descriptor = record(descriptorResponse.data);
  if (descriptor['state'] !== 'available')
    throw new Error('The asset is not available for download.');
  const response = await requestBytes(
    target,
    `/assets/${encodeURIComponent(assetId)}/content`,
    parsed,
    dependencies,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (typeof descriptor['byteLength'] === 'number' && descriptor['byteLength'] !== bytes.byteLength)
    throw new Error('The downloaded asset length does not match its descriptor.');
  if (typeof descriptor['digest'] === 'string') {
    const digest = `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
    if (digest !== descriptor['digest'])
      throw new Error('The downloaded asset digest does not match its descriptor.');
  }
  if (outputFile === '-')
    return { data: { byteLength: bytes.byteLength }, metadata: { binaryStdout: bytes } };
  const parent = dirname(outputFile);
  const temporary = join(parent, `.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    if (parsed.options.get('overwrite') === true) await rename(temporary, outputFile);
    else {
      try {
        await link(temporary, outputFile);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
          throw new Error(`Refusing to overwrite existing file: ${outputFile}`, { cause: error });
        throw error;
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return { data: { outputFile, byteLength: bytes.byteLength } };
}

/** Execute caller-scoped asset upload and download commands. */
export function executeAssets(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const action = parsed.arguments[0] ?? 'upload';
  if (action === 'upload') return upload(target, parsed, dependencies);
  if (action === 'download') return download(target, parsed, dependencies);
  throw Object.assign(new Error('Usage: assets upload|download.'), { usage: true });
}
