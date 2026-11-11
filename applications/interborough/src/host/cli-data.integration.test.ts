import {
  createGovernedMemory,
  createInMemoryMemoryRecordStorage,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMemoryVectorStore,
  createMockEmbedder,
  createTestEmbedders,
} from '@lostgradient/memory';
import { createAgent } from '@lostgradient/operative';
import { runWithHangGuard, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { principalFromApiKey } from '@lostgradient/weft';
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCliDispatches } from './cli-dispatch.test-support.ts';

import { MemoryStorage } from '@lostgradient/storage';
import { createMemoryAssetStorage } from '../../../../packages/bureau/src/assets/storage.ts';
import { createBureau } from '../../../../packages/bureau/src/create-bureau.ts';
import { BUREAU_SCOPES } from '../../../../packages/bureau/src/http/bureau-scopes.ts';
import { createBureauHandler } from '../../../../packages/bureau/src/http/create-bureau-handler.ts';

const directory = await mkdtemp(join(tmpdir(), 'interborough-cli-data-'));
const executable = join(directory, 'interborough');
const inputFile = join(directory, 'input.bin');
const outputFile = join(directory, 'output.bin');
const bytes = new Uint8Array(600_000);
for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = index % 251;
await writeFile(inputFile, bytes);
const build = await runWithHangGuard([
  process.execPath,
  'build',
  '--compile',
  '--no-compile-autoload-dotenv',
  '--no-compile-autoload-bunfig',
  '--compile-exec-argv=--no-install',
  '--outfile',
  executable,
  join(import.meta.dir, 'cli.ts'),
]);
if (build.exitCode !== 0) throw new Error(build.stderr.toString());

const dispatches: string[] = [];
const requests: Array<{ method?: string; params?: Record<string, unknown> }> = [];
let failAppend = false;
let failMemoryWrite = false;
let holdAppend = false;
let releaseAppend: (() => void) | undefined;
const appendAdmitted = Promise.withResolvers<void>();
const uploadedChunks: Uint8Array[] = [];
const observedKeys: string[] = [];
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/bureau/assets/asset-1/content') {
      dispatches.push(`${request.method} ${url.pathname}`);
      return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
    }
    if (url.pathname.endsWith('/content'))
      return Response.json({ message: 'obsolete route' }, { status: 404 });
    const body = (await request.json()) as { method?: string; params?: Record<string, unknown> };
    requests.push(body);
    dispatches.push(body.method ?? `${request.method} ${new URL(request.url).pathname}`);
    const params = body.params ?? {};
    const method = body.method;
    if (
      failMemoryWrite &&
      (method === 'bureau.memory.remember' || method === 'bureau.memory.correct')
    )
      return new Response('{"jsonrpc":"2.0"', { status: 200 });
    if (method?.startsWith('bureau.memory.')) {
      if (params['agentId'] === 'other-agent')
        return Response.json({ message: 'Not found' }, { status: 404 });
      if (method === 'bureau.memory.list')
        return Response.json({ result: { memories: [], nextOffset: null } });
      if (method === 'bureau.memory.search') return Response.json({ result: { hits: [] } });
      if (method === 'bureau.memory.export')
        return Response.json({
          result: {
            exportId: 'export-1',
            fileName: 'memory.json',
            memories: [
              {
                id: 'm-1',
                content: 'one',
                memoryClass: 'semantic',
                kind: 'fact',
                source: 'operator',
                writer: 'person',
                trust: 'verified',
                createdAt: '2026-01-01T00:00:00.000Z',
                sessionId: null,
                history: [],
              },
              {
                id: 'm-2',
                content: 'two',
                memoryClass: 'semantic',
                kind: 'fact',
                source: 'operator',
                writer: 'person',
                trust: 'verified',
                createdAt: '2026-01-02T00:00:00.000Z',
                sessionId: null,
                history: [
                  {
                    id: 'm-0',
                    content: 'old two',
                    kind: 'fact',
                    writer: 'agent',
                    trust: 'untrusted',
                    writtenAt: '2025-12-01T00:00:00.000Z',
                    correctedAt: '2026-01-02T00:00:00.000Z',
                  },
                ],
              },
              {
                id: 'm-3',
                content: 'three',
                memoryClass: 'semantic',
                kind: 'fact',
                source: 'operator',
                writer: 'person',
                trust: 'verified',
                createdAt: '2026-01-03T00:00:00.000Z',
                sessionId: null,
                history: [],
              },
            ],
          },
        });
      return Response.json({
        result:
          method === 'bureau.memory.forget'
            ? {
                id: params['id'],
                deletion: 'exempt',
                receipt: {
                  deletionId: 'deletion-1',
                  scope: 'source',
                  trigger: 'request',
                  record: {
                    id: String(params['id']),
                    collection: String(params['agentId']),
                    memoryClass: 'semantic',
                  },
                  requestedAt: '2026-01-01T00:00:00.000Z',
                  boundMilliseconds: 1000,
                  awaitingHoldRelease: true,
                  open: true,
                  updatedAt: '2026-01-01T00:00:00.000Z',
                  targets: [{ target: 'source-evidence', lane: 'synchronous', status: 'exempt' }],
                },
              }
            : { memory: { id: 'memory-1', content: 'distinct', kind: 'fact' } },
      });
    }
    if (method === 'bureau.assets.uploads.create')
      return Response.json({ result: { uploadId: 'upload-1' } });
    if (method === 'bureau.assets.uploads.abort') {
      releaseAppend?.();
      return Response.json({ result: { uploadId: params['uploadId'], aborted: true } });
    }
    if (method === 'bureau.assets.uploads.append' && failAppend)
      return Response.json({ message: 'append failed' }, { status: 500 });
    if (method === 'bureau.assets.uploads.append')
      uploadedChunks.push(Uint8Array.from(Buffer.from(String(params['chunk']), 'base64')));
    if (method === 'bureau.assets.uploads.append' && holdAppend) {
      appendAdmitted.resolve();
      await new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
    }
    if (method === 'bureau.assets.uploads.append')
      return Response.json({
        result: { uploadId: params['uploadId'], receivedBytes: bytes.byteLength },
      });
    if (method === 'bureau.assets.uploads.complete')
      return Response.json({ result: { assetId: 'asset-1', state: 'available' } });
    if (method === 'bureau.assets.get')
      return Response.json({
        result: {
          assetId: 'asset-1',
          state: 'available',
          byteLength: bytes.byteLength,
          digest: `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`,
        },
      });
    return Response.json({ result: {} });
  },
});
const realBureauStorage = new MemoryStorage();
const realBureau = await createBureau({
  id: 'cli-owner-witness',
  agents: { 'agent-a': createAgent({ generate: async () => ({ content: 'ok', toolCalls: [] }) }) },
  storage: realBureauStorage,
  assets: { storage: createMemoryAssetStorage() },
  memory: createGovernedMemory({
    storage: createInMemoryMemoryRecordStorage(),
    ledger: createMemoryGovernanceLedger(realBureauStorage),
    ...createTestEmbedders(createMockEmbedder(64), 64),
    vectors: createMemoryVectorStore(realBureauStorage),
    policy: createMemoryGovernancePolicy({ revision: 'cli-owner-witness' }),
  }),
});
const realHandler = createBureauHandler(realBureau, {
  authentication: {
    resolveApiKeyPrincipal: async (key) => {
      observedKeys.push(key);
      return key === 'ALICE_KEY' || key === 'BOB_KEY'
        ? principalFromApiKey({
            subject: key === 'ALICE_KEY' ? 'alice' : 'bob',
            scopes: [...BUREAU_SCOPES],
          })
        : null;
    },
  },
});
const realServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/bureau/')) return new Response('Not found', { status: 404 });
    url.pathname = url.pathname.slice('/bureau'.length) || '/';
    return realHandler(new Request(url, request));
  },
});
async function realRpc(
  key: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${realServer.port}/bureau/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
  });
  const body = (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
  if (body.result === undefined)
    throw new Error(`Real Bureau ${method} failed: ${JSON.stringify(body.error)}`);
  return body.result;
}
const bobMemory = await realRpc('BOB_KEY', 'bureau.memory.remember', {
  agentId: 'agent-a',
  content: 'bob-only-memory',
});
const bobMemoryId = (bobMemory['memory'] as { id: string }).id;
const aliceMemory = await realRpc('ALICE_KEY', 'bureau.memory.remember', {
  agentId: 'agent-a',
  content: 'alice-only-memory',
});
const aliceMemoryId = (aliceMemory['memory'] as { id: string }).id;
const bobUpload = await realRpc('BOB_KEY', 'bureau.assets.uploads.create', {
  declaredByteLength: bytes.byteLength,
  declaredMediaType: 'application/octet-stream',
});
const bobUploadId = String(bobUpload['uploadId']);
for (let offset = 0; offset < bytes.byteLength; offset += 256 * 1024)
  await realRpc('BOB_KEY', 'bureau.assets.uploads.append', {
    uploadId: bobUploadId,
    chunk: Buffer.from(
      bytes.subarray(offset, Math.min(offset + 256 * 1024, bytes.byteLength)),
    ).toString('base64'),
  });
const bobAsset = await realRpc('BOB_KEY', 'bureau.assets.uploads.complete', {
  uploadId: bobUploadId,
});
const bobAssetId = String(bobAsset['assetId']);
const invoke = async (arguments_: string[], variables: Record<string, string> = {}) => {
  const start = dispatches.length;
  const result = await runWithHangGuard([executable, ...arguments_], {
    cwd: directory,
    env: { PATH: '', HOME: directory, ...variables },
  });
  assertCliDispatches(arguments_, dispatches.slice(start));
  return result;
};
async function invokeWithInterrupt(
  arguments_: string[],
): Promise<{ exitCode: number | null; stdout: Buffer; stderr: Buffer }> {
  const child = spawnWithHangGuard([executable, ...arguments_], {
    cwd: directory,
    env: { PATH: '', HOME: directory },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new Response(child.stdout).arrayBuffer();
  const stderr = new Response(child.stderr).arrayBuffer();
  await appendAdmitted.promise;
  child.kill('SIGINT');
  const [out, error] = await Promise.all([stdout, stderr, child.exited]);
  return { exitCode: child.exitCode, stdout: Buffer.from(out), stderr: Buffer.from(error) };
}
const url = `http://127.0.0.1:${server.port}`;
afterAll(async () => {
  server.stop(true);
  realServer.stop(true);
  await realBureau.dispose();
  await rm(directory, { recursive: true, force: true });
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled memory commands preserve exact schemas and machine output', async () => {
  const listed = await invoke([
    'memory',
    'list',
    '--agent',
    'agent-a',
    '--limit',
    '2',
    '--offset',
    '4',
    '--output',
    'json',
    '--url',
    url,
  ]);
  expect(listed.exitCode).toBe(0);
  expect(requests.at(-1)).toMatchObject({
    method: 'bureau.memory.list',
    params: { agentId: 'agent-a', limit: 2, offset: 4 },
  });
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled memory search and get preserve their exact schemas', async () => {
  const searched = await invoke([
    'memory',
    'search',
    'distinct',
    '--agent',
    'agent-a',
    '--limit',
    '5',
    '--url',
    url,
  ]);
  expect(searched.exitCode).toBe(0);
  expect(requests.at(-1)).toMatchObject({
    method: 'bureau.memory.search',
    params: { agentId: 'agent-a', query: 'distinct', limit: 5 },
  });
  const retrieved = await invoke(['memory', 'get', 'memory-1', '--agent', 'agent-a', '--url', url]);
  expect(retrieved.exitCode).toBe(0);
  expect(requests.at(-1)).toMatchObject({
    method: 'bureau.memory.get',
    params: { agentId: 'agent-a', id: 'memory-1' },
  });
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled memory mutations preserve write safety and export pagination', async () => {
  const remembered = await invoke([
    'memory',
    'remember',
    '--agent',
    'agent-a',
    '--content',
    'distinct',
    '--kind',
    'fact',
    '--url',
    url,
  ]);
  expect(remembered.exitCode).toBe(0);
  expect(requests.at(-1)).toMatchObject({
    method: 'bureau.memory.remember',
    params: { agentId: 'agent-a', content: 'distinct', kind: 'fact' },
  });
  const positionalRemember = await invoke([
    'memory',
    'remember',
    'positional content',
    '--agent',
    'agent-a',
    '--url',
    url,
  ]);
  expect(positionalRemember.exitCode).toBe(0);
  expect(requests.at(-1)).toMatchObject({
    method: 'bureau.memory.remember',
    params: { agentId: 'agent-a', content: 'positional content' },
  });
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled memory corrections preserve their exact schema', async () => {
  const corrected = await invoke([
    'memory',
    'correct',
    'memory-1',
    '--agent',
    'agent-a',
    '--content',
    'corrected distinct',
    '--url',
    url,
  ]);
  expect(corrected.exitCode).toBe(0);
  expect(requests.at(-1)).toMatchObject({
    method: 'bureau.memory.correct',
    params: { agentId: 'agent-a', id: 'memory-1', content: 'corrected distinct' },
  });
  const positionalCorrect = await invoke([
    'memory',
    'correct',
    'memory-1',
    'positional correction',
    '--agent',
    'agent-a',
    '--url',
    url,
  ]);
  expect(positionalCorrect.exitCode).toBe(0);
  expect(requests.at(-1)).toMatchObject({
    method: 'bureau.memory.correct',
    params: { agentId: 'agent-a', id: 'memory-1', content: 'positional correction' },
  });
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled memory export and deletion preserve pagination and denial', async () => {
  const exported = await invoke([
    'memory',
    'export',
    '--agent',
    'agent-a',
    '--limit',
    '2',
    '--offset',
    '1',
    '--output',
    'json',
    '--url',
    url,
  ]);
  expect(exported.exitCode).toBe(0);
  expect(JSON.parse(exported.stdout.toString())).toMatchObject({
    data: {
      exportId: 'export-1',
      fileName: 'memory.json',
      memories: [{ id: 'm-2', source: 'operator', history: [{ id: 'm-0' }] }, { id: 'm-3' }],
    },
    metadata: { cursor: null, page: { limit: 2, offset: 1 } },
  });
  const forgotten = await invoke([
    'memory',
    'forget',
    'memory-1',
    '--agent',
    'agent-a',
    '--yes',
    '--output',
    'json',
    '--url',
    url,
  ]);
  expect(forgotten.exitCode).toBe(0);
  expect(JSON.parse(forgotten.stdout.toString()).data.deletion).toBe('exempt');
  expect(JSON.parse(forgotten.stdout.toString()).data.receipt.awaitingHoldRelease).toBe(true);
  const denied = await invoke([
    'memory',
    'get',
    'memory-1',
    '--agent',
    'other-agent',
    '--url',
    url,
  ]);
  expect(denied.exitCode).toBe(1);
  failMemoryWrite = true;
  const uncertain = await invoke([
    'memory',
    'remember',
    '--agent',
    'agent-a',
    '--content',
    'may have been admitted',
    '--url',
    url,
  ]);
  expect(uncertain.exitCode).toBe(7);
  expect(requests.at(-1)?.method).toBe('bureau.memory.remember');
  failMemoryWrite = false;
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled upload and download preserve bytes and refuse implicit overwrite', async () => {
  const uploaded = await invoke(['assets', 'upload', '--file', inputFile, '--url', url]);
  expect(uploaded.exitCode).toBe(0);
  expect(requests.some((request) => request.method === 'bureau.assets.uploads.create')).toBe(true);
  expect(requests.some((request) => request.method === 'bureau.assets.uploads.complete')).toBe(
    true,
  );
  expect(
    requests.filter((request) => request.method === 'bureau.assets.uploads.append').length,
  ).toBeGreaterThan(1);
  expect(uploadedChunks.every((chunk) => chunk.byteLength <= 256 * 1024)).toBe(true);
  expect(Buffer.concat(uploadedChunks.map((chunk) => Buffer.from(chunk)))).toEqual(
    Buffer.from(bytes),
  );
  failAppend = true;
  const interrupted = await invoke(['assets', 'upload', '--file', inputFile, '--url', url]);
  expect(interrupted.exitCode).toBe(7);
  expect(requests.at(-1)?.method).toBe('bureau.assets.uploads.abort');
  failAppend = false;
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled download preserves bytes, paths, and output framing', async () => {
  const downloaded = await invoke([
    'assets',
    'download',
    'asset-1',
    '--output-file',
    outputFile,
    '--url',
    url,
  ]);
  expect(downloaded.exitCode).toBe(0);
  expect(await readFile(outputFile)).toEqual(Buffer.from(bytes));
  const sentinel = Buffer.from('do-not-overwrite');
  await writeFile(outputFile, sentinel);
  const refused = await invoke([
    'assets',
    'download',
    'asset-1',
    '--output-file',
    outputFile,
    '--url',
    url,
  ]);
  expect(refused.exitCode).toBe(1);
  expect(await readFile(outputFile)).toEqual(sentinel);
  const overwritten = await invoke([
    'assets',
    'download',
    'asset-1',
    '--output-file',
    outputFile,
    '--overwrite',
    '--url',
    url,
  ]);
  expect(overwritten.exitCode).toBe(0);
  const binary = await invoke([
    'assets',
    'download',
    'asset-1',
    '--output-file',
    '-',
    '--url',
    url,
  ]);
  expect(binary.exitCode).toBe(0);
  expect(binary.stdout).toEqual(Buffer.from(bytes));
  expect(binary.stderr).toEqual(Buffer.from([]));
  const binaryJsonConflict = await invoke([
    'assets',
    'download',
    'asset-1',
    '--output-file',
    '-',
    '--output',
    'json',
    '--url',
    url,
  ]);
  expect(binaryJsonConflict.exitCode).toBe(2);
});

// spawn-free: the compiled child receives SIGINT after the server admits an upload append.
test('compiled SIGINT aborts an admitted upload session', async () => {
  holdAppend = true;
  const interrupted = await invokeWithInterrupt([
    'assets',
    'upload',
    '--file',
    inputFile,
    '--url',
    url,
  ]);
  holdAppend = false;
  expect(interrupted.exitCode).toBe(130);
  expect(requests.at(-1)?.method).toBe('bureau.assets.uploads.abort');
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled loopback credentials cannot read another owner', async () => {
  const realUrl = `http://127.0.0.1:${realServer.port}`;
  const alice = await invoke(
    ['connection', 'add', 'alice', '--url', realUrl, '--credential-reference', 'ALICE_KEY'],
    { ALICE_KEY: 'ALICE_KEY', BOB_KEY: 'BOB_KEY' },
  );
  expect(alice.exitCode).toBe(0);
  const bob = await invoke(
    ['connection', 'add', 'bob', '--url', realUrl, '--credential-reference', 'BOB_KEY'],
    { ALICE_KEY: 'ALICE_KEY', BOB_KEY: 'BOB_KEY' },
  );
  expect(bob.exitCode).toBe(0);
  const bobSelf = await invoke(
    ['memory', 'get', bobMemoryId, '--agent', 'agent-a', '--connection', 'bob'],
    { ALICE_KEY: 'ALICE_KEY', BOB_KEY: 'BOB_KEY' },
  );
  expect(bobSelf.exitCode).toBe(0);
  expect(bobSelf.stdout.toString()).toContain('bob-only-memory');
  const aliceSelf = await invoke(
    ['memory', 'get', aliceMemoryId, '--agent', 'agent-a', '--connection', 'alice'],
    { ALICE_KEY: 'ALICE_KEY', BOB_KEY: 'BOB_KEY' },
  );
  expect(aliceSelf.exitCode).toBe(0);
  expect(aliceSelf.stdout.toString()).toContain('alice-only-memory');
  const bobAssetPath = join(directory, 'bob-self.bin');
  const bobAssetSelf = await invoke(
    ['assets', 'download', bobAssetId, '--output-file', bobAssetPath, '--connection', 'bob'],
    { ALICE_KEY: 'ALICE_KEY', BOB_KEY: 'BOB_KEY' },
  );
  expect(bobAssetSelf.exitCode).toBe(0);
  expect(await readFile(bobAssetPath)).toEqual(Buffer.from(bytes));
  const deniedMemory = await invoke(
    ['memory', 'get', bobMemoryId, '--agent', 'agent-a', '--connection', 'alice'],
    { ALICE_KEY: 'ALICE_KEY', BOB_KEY: 'BOB_KEY' },
  );
  expect(deniedMemory.exitCode).toBe(1);
  expect(deniedMemory.stderr).not.toContain('bob-only-memory');
  const deniedAsset = await invoke(
    [
      'assets',
      'download',
      bobAssetId,
      '--output-file',
      join(directory, 'denied.bin'),
      '--connection',
      'alice',
    ],
    { ALICE_KEY: 'ALICE_KEY', BOB_KEY: 'BOB_KEY' },
  );
  expect(deniedAsset.exitCode).toBe(1);
  expect(await Bun.file(join(directory, 'denied.bin')).exists()).toBe(false);
  expect(observedKeys).toContain('ALICE_KEY');
  expect(observedKeys).toContain('BOB_KEY');
});
