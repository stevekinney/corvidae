import { runWithHangGuard, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readFirstJsonlRecord } from './cli-jsonl.test-support.ts';
import { HOST_RESTART_ROUTE, RESTART_EXIT_CODE } from './restart.ts';

const directory = mkdtempSync(join(tmpdir(), 'interborough-cli-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const executable = join(directory, 'bin', 'interborough');
const browser = join(directory, 'share', 'interborough', 'browser');
mkdirSync(browser, { recursive: true });
writeFileSync(join(browser, 'index.html'), '<!doctype html><title>Interborough</title>');
writeFileSync(join(directory, '.env'), 'INTERBOROUGH_PORT=invalid-dotenv-value\n');
const version = '1.2.3-test.4';
const build = await runWithHangGuard([
  process.execPath,
  'build',
  '--compile',
  '--no-compile-autoload-dotenv',
  '--no-compile-autoload-bunfig',
  '--compile-exec-argv=--no-install',
  '--define',
  `INTERBOROUGH_RELEASE_VERSION=${JSON.stringify(version)}`,
  '--loader',
  '.md:text',
  '--outfile',
  executable,
  join(import.meta.dir, 'cli.ts'),
]);
if (build.exitCode !== 0) throw new Error(build.stderr.toString());

const environment = { PATH: '', HOME: directory, NODE_ENV: 'production' };
const invoke = (arguments_: string[], env: Record<string, string> = {}) =>
  runWithHangGuard([executable, ...arguments_], {
    cwd: directory,
    env: { ...environment, ...env },
  });

async function runRealPty(arguments_: string[]) {
  let outputText = '';
  const decoder = new TextDecoder();
  const process_ = spawnWithHangGuard([executable, ...arguments_], {
    cwd: directory,
    env: environment,
    terminal: {
      cols: 80,
      rows: 24,
      data: (_terminal, data) => {
        outputText += decoder.decode(data);
      },
    },
  });
  return {
    process: process_,
    terminal: process_.terminal,
    output: () => outputText,
    exited: process_.exited,
  };
}

const productionRequests: Request[] = [];
const uploadChunks: Buffer[] = [];
const uploadedChatBodies: Record<string, unknown>[] = [];
const compiledStreamHandshakes: string[] = [];
const compiledRunHandshakes: string[] = [];
const compiledRunFirstRecord = Promise.withResolvers<void>();
const compiledRunCancelCalls: string[] = [];
const compiledRunRequests: Array<{ method: string; params?: Record<string, unknown> }> = [];
const productionServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    productionRequests.push(request.clone());
    const pathname = new URL(request.url).pathname;
    if (pathname === '/bureau/jsonrpc') {
      const body = (await request.json()) as {
        method?: string;
        params?: Record<string, unknown>;
      };
      if (typeof body.method === 'string')
        compiledRunRequests.push({
          method: body.method,
          ...(body.params === undefined ? {} : { params: body.params }),
        });
      if (body.method === 'bureau.tasks.cancel' || body.method === 'weft.workflows.cancel') {
        compiledRunCancelCalls.push(body.method);
        return Response.json({
          result: { ...body.params, receipt: 'cancel-requested', status: 'cancel-requested' },
        });
      }
      if (body.method === 'bureau.tasks.list')
        return Response.json({
          result: {
            tasks: [{ id: 'compiled-run', status: 'running' }],
            nextPageToken: 'compiled-next',
          },
        });
      if (body.method === 'bureau.workflows.runs.list')
        return Response.json({
          result: { runs: [{ id: 'compiled-run', status: 'running' }], nextOffset: 1 },
        });
      if (
        body.method === 'bureau.tasks.get' ||
        body.method === 'bureau.tasks.inspect' ||
        body.method === 'bureau.workflows.runs.get'
      )
        return Response.json({ result: { id: 'compiled-run', status: 'running' } });
      if (body.method === 'bureau.assets.uploads.create')
        return Response.json({ result: { uploadId: 'compiled-upload' } });
      if (body.method === 'bureau.assets.uploads.append') {
        const chunk = body.params?.['chunk'];
        if (typeof chunk !== 'string')
          return Response.json({ message: 'Missing upload chunk' }, { status: 400 });
        uploadChunks.push(Buffer.from(chunk, 'base64'));
        return Response.json({ result: { uploadId: 'compiled-upload' } });
      }
      if (body.method === 'bureau.assets.uploads.complete')
        return Response.json({ result: { assetId: 'compiled-asset' } });
      if (body.method === 'bureau.assets.uploads.abort') return Response.json({ result: {} });
      if (body.method === 'bureau.plugins.contributions')
        return Response.json({
          result: {
            providers: [
              {
                plugin: 'openai',
                name: 'openai',
                configuration: {
                  type: 'object',
                  properties: { baseURL: { type: 'string', format: 'uri' } },
                },
              },
            ],
          },
        });
      return Response.json({ jsonrpc: '2.0', id: 'production', result: body.params });
    }
    if (pathname === '/bureau/v1/subscriptions/bureau.tasks.events') {
      const taskId = new URL(request.url).searchParams.get('taskId');
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const writer = stream.writable.getWriter();
      const encoder = new TextEncoder();
      const send = (id: string, event: Record<string, unknown>) =>
        writer.write(encoder.encode(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`));
      compiledRunHandshakes.push(`task:${taskId ?? 'unknown'}`);
      void (async () => {
        if (taskId === 'compiled-run') {
          await send('compiled-1', { kind: 'task.status', status: 'running' });
          await compiledRunFirstRecord.promise;
          await send('compiled-2', { kind: 'task.status', status: 'completed' });
          await writer.close();
        } else if (taskId === 'compiled-eof') {
          await send('compiled-eof', { kind: 'task.status', status: 'running' });
          await writer.close();
        } else if (taskId === 'compiled-failed') {
          await send('compiled-failed', { kind: 'task.status', status: 'failed' });
          await writer.close();
        } else if (taskId === 'compiled-pending') {
          await send('compiled-pending', { kind: 'task.status', status: 'input-required' });
          await writer.close();
        } else {
          await send('compiled-open', { kind: 'task.status', status: 'running' });
          await writer.closed.catch(() => undefined);
        }
      })();
      return new Response(stream.readable, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (pathname.startsWith('/bureau/ag-ui/')) {
      const input =
        request.method === 'POST' ? ((await request.json()) as Record<string, unknown>) : {};
      if (Array.isArray(input['messages'])) uploadedChatBodies.push(input);
      const message =
        Array.isArray(input['messages']) && typeof input['messages'][0] === 'object'
          ? (() => {
              const content = (input['messages'][0] as Record<string, unknown>)['content'];
              return typeof content === 'string' ? content : JSON.stringify(content ?? '');
            })()
          : '';
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const writer = stream.writable.getWriter();
      const encoder = new TextEncoder();
      const send = async (event: Record<string, unknown>, id?: string) => {
        const prefix = id === undefined ? '' : `id: ${id}\n`;
        await writer.write(encoder.encode(`${prefix}data: ${JSON.stringify(event)}\n\n`));
      };
      if (message === 'terminal hello') {
        compiledStreamHandshakes.push('terminal-started');
        void (async () => {
          await send({ type: 'RUN_STARTED', threadId: 'thread-terminal', runId: 'run-terminal' });
          await send({ type: 'TEXT_MESSAGE_CONTENT', delta: 'terminal text' });
          await send({ type: 'RUN_FINISHED', outcome: { type: 'success', interrupts: [] } });
          await writer.close();
        })();
        return new Response(stream.readable, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (message.startsWith('hello')) {
        compiledStreamHandshakes.push('sigint-started');
        void (async () => {
          await writer.write(
            encoder.encode(
              'data: {"type":"RUN_STARTED","threadId":"thread-sigint","runId":"run-sigint"}\n\n',
            ),
          );
          await writer.write(
            encoder.encode('data: {"type":"TEXT_MESSAGE_CONTENT","delta":"stream-ready"}\n\n'),
          );
          await writer.closed.catch(() => undefined);
        })();
        return new Response(stream.readable, { headers: { 'content-type': 'text/event-stream' } });
      }
      void (async () => {
        if (message.includes('interrupt')) {
          compiledStreamHandshakes.push('interrupt-started');
          await send({ type: 'RUN_STARTED', threadId: 'thread-compiled', runId: 'run-compiled' });
          await send({
            type: 'RUN_FINISHED',
            outcome: { type: 'interrupt', interrupts: [{ id: 'interrupt-compiled' }] },
          });
        } else if (
          message.includes('events') ||
          request.headers.get('last-event-id') === 'cursor-attach'
        ) {
          await send(
            { type: 'RUN_STARTED', threadId: 'thread-events', runId: 'run-events' },
            'durable-start',
          );
          await send({
            type: 'MESSAGES_SNAPSHOT',
            messages: [{ role: 'assistant', content: 'snapshot' }],
          });
          await send({ type: 'TEXT_MESSAGE_CONTENT', delta: 'same' });
          await send({ type: 'TEXT_MESSAGE_CONTENT', delta: 'same' });
          await send({ type: 'TEXT_MESSAGE_CONTENT', delta: 'durable' }, 'durable-text');
          await send({ type: 'TEXT_MESSAGE_CONTENT', delta: 'durable' }, 'durable-text');
          await send({ type: 'REASONING_MESSAGE_CONTENT', delta: 'private-reasoning' });
          await send({
            type: 'TOOL_CALL_START',
            toolCallId: 'private-tool',
            toolCallName: 'lookup',
            args: { secret: 'private-args' },
          });
          await send({ type: 'RUN_FINISHED', outcome: { type: 'success', interrupts: [] } });
        } else if (message.includes('binary-upload')) {
          await send({ type: 'RUN_STARTED', threadId: 'thread-upload', runId: 'run-upload' });
          await send({ type: 'RUN_FINISHED', outcome: { type: 'success', interrupts: [] } });
        } else {
          await send({ type: 'RUN_STARTED', threadId: 'thread-sigint', runId: 'run-sigint' });
        }
        try {
          await writer.close();
        } catch {
          // SIGINT intentionally closes the client side of this fixture stream.
        }
      })();
      return new Response(stream.readable, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (request.headers.get('authorization') !== 'Bearer production-secret')
      return Response.json({ message: 'Forbidden' }, { status: 403 });
    if (new URL(request.url).pathname === '/host/status')
      return Response.json({
        deploymentId: 'production-deployment',
        incarnationId: 'production-incarnation',
        diagnostics: { providers: [] },
      });
    if (new URL(request.url).pathname === '/host/providers' && request.method === 'GET')
      return Response.json({ configurationRevision: 'compiled-r1', providers: [], models: [] });
    if (new URL(request.url).pathname === '/host/plugins' && request.method === 'GET')
      return Response.json({ configurationRevision: 'compiled-p1' });
    if (new URL(request.url).pathname === '/host/plugins' && request.method === 'GET')
      return Response.json({
        configurationRevision: 'compiled-p1',
        plugins: [
          {
            name: 'openai',
            contributions: { providers: ['openai'] },
            configurationSchema: { properties: { baseURL: { type: 'string' } } },
          },
        ],
      });
    if (new URL(request.url).pathname.startsWith('/host/plugins/') && request.method === 'PUT')
      return Response.json({ plugin: 'openai', restartRequired: false });
    if (new URL(request.url).pathname === '/host/providers/openai' && request.method === 'PUT')
      return Response.json({ providers: [], catalogRevision: 2 });
    if (new URL(request.url).pathname === '/openrpc.json')
      return Response.json({ methods: [{ name: 'weft.alerts.list' }] });
    const body = (await request.json()) as { params?: unknown };
    return Response.json({ jsonrpc: '2.0', id: 'production', result: body.params });
  },
});
afterAll(() => productionServer.stop(true));

const untouched = join(directory, 'untouched');
const informationEnvironment = { INTERBOROUGH_HOME: untouched, INTERBOROUGH_PORT: 'bad' };
const help = await invoke(['--help'], informationEnvironment);
const startHelp = await invoke(['start', '--help'], informationEnvironment);
const release = await invoke(['--version'], informationEnvironment);
const startRelease = await invoke(['start', '--version'], informationEnvironment);
const createdHome = existsSync(untouched) || existsSync(join(directory, '.interborough'));
const productionConnection = await invoke(
  [
    'connection',
    'add',
    'production',
    '--url',
    `http://127.0.0.1:${productionServer.port}`,
    '--credential-reference',
    'INTERBOROUGH_TOKEN',
  ],
  { INTERBOROUGH_TOKEN: 'production-secret' },
);
const productionStatus = await invoke(['status', '--connection', 'production'], {
  INTERBOROUGH_TOKEN: 'production-secret',
});
const compiledConfigurationList = await invoke(
  ['providers', 'list', '--connection', 'production'],
  {
    INTERBOROUGH_TOKEN: 'production-secret',
  },
);
const compiledConfigurationInput = join(directory, 'provider-configuration.json');
writeFileSync(
  compiledConfigurationInput,
  JSON.stringify({
    apiKey: 'compiled-provider-secret',
    configuration: { baseURL: 'https://api.invalid' },
  }),
);
const compiledConfigurationMutation = await invoke(
  [
    'providers',
    'connect',
    'openai',
    '--connection',
    'production',
    '--input-file',
    compiledConfigurationInput,
  ],
  { INTERBOROUGH_TOKEN: 'production-secret' },
);
const compiledUnknownProvider = await invoke(
  [
    'providers',
    'connect',
    'typo',
    '--connection',
    'production',
    '--input-file',
    compiledConfigurationInput,
  ],
  { INTERBOROUGH_TOKEN: 'production-secret' },
);
const compiledInvalidConfigurationInput = join(directory, 'invalid-provider-configuration.json');
writeFileSync(
  compiledInvalidConfigurationInput,
  JSON.stringify({ apiKey: 'compiled-provider-secret', configuration: { baseURL: 'not a uri' } }),
);
const compiledInvalidConfiguration = await invoke(
  [
    'providers',
    'connect',
    'openai',
    '--connection',
    'production',
    '--input-file',
    compiledInvalidConfigurationInput,
  ],
  { INTERBOROUGH_TOKEN: 'production-secret' },
);
const compiledInlineSecret = await invoke(
  [
    'providers',
    'connect',
    'openai',
    '--connection',
    'production',
    '--input',
    '{"apiKey":"argv-secret"}',
  ],
  { INTERBOROUGH_TOKEN: 'production-secret' },
);
const productionCall = spawnWithHangGuard(
  [
    executable,
    'api',
    'call',
    'weft.alerts.list',
    '--yes',
    '--connection',
    'production',
    '--input',
    '-',
  ],
  {
    cwd: directory,
    env: { ...environment, INTERBOROUGH_TOKEN: 'production-secret' },
    stdin: 'pipe',
  },
);
productionCall.stdin.write('{"revision":"r1","idempotencyKey":"i1"}');
productionCall.stdin.end();
const [productionCallStdout, productionCallStderr, productionCallExitCode] = await Promise.all([
  new Response(productionCall.stdout).text(),
  new Response(productionCall.stderr).text(),
  productionCall.exited,
]);
const sigintCall = spawnWithHangGuard(
  [
    executable,
    'chat',
    '--agent',
    'demo',
    '--message',
    'hello',
    '--url',
    `http://127.0.0.1:${productionServer.port}`,
  ],
  { cwd: directory, env: environment, stdout: 'pipe', stderr: 'pipe' },
);
await waitUntil(() => compiledStreamHandshakes.includes('sigint-started'), {
  message: 'compiled chat to connect to the AG-UI stream',
  yieldTurn: () => Bun.sleep(10),
});
const sigintStdoutReader = sigintCall.stdout.getReader();
const sigintStdoutDecoder = new TextDecoder();
let sigintStdout = '';
let sigintStreamReady = false;
while (!sigintStreamReady) {
  const next = await sigintStdoutReader.read();
  if (next.done) break;
  sigintStdout += sigintStdoutDecoder.decode(next.value, { stream: true });
  sigintStreamReady = sigintStdout.includes('stream-ready');
}
if (!sigintStreamReady)
  throw new Error('compiled chat did not render stream readiness before SIGINT');
sigintCall.kill('SIGINT');
while (true) {
  const next = await sigintStdoutReader.read();
  if (next.done) break;
  sigintStdout += sigintStdoutDecoder.decode(next.value, { stream: true });
}
sigintStdout += sigintStdoutDecoder.decode();
sigintStdoutReader.releaseLock();
const [sigintStderr, sigintExitCode] = await Promise.all([
  new Response(sigintCall.stderr).text(),
  sigintCall.exited,
]);
const initialPtyRequestCount = productionRequests.length;
const initialPty = await runRealPty([
  'chat',
  '--agent',
  'demo',
  '--url',
  `http://127.0.0.1:${productionServer.port}`,
]);
initialPty.terminal?.write('terminal hello\n');
const initialPtyExitCode = await initialPty.exited;
const initialPtyRequestSeen = productionRequests.length > initialPtyRequestCount;
const initialPtyOutput = initialPty.output();
const noInputPty = await runRealPty([
  'chat',
  '--agent',
  'demo',
  '--message',
  'interrupt-no-input',
  '--no-input',
  '--url',
  `http://127.0.0.1:${productionServer.port}`,
]);
await waitUntil(
  () => compiledStreamHandshakes.filter((item) => item === 'interrupt-started').length >= 1,
  {
    message: 'compiled TTY no-input stream to start',
    yieldTurn: () => Bun.sleep(10),
  },
);
const noInputPtyExitCode = await noInputPty.exited;
noInputPty.terminal?.close();
const noInputPtyOutput = noInputPty.output();
const promptPty = await runRealPty([
  'chat',
  '--agent',
  'demo',
  '--message',
  'interrupt-prompt',
  '--url',
  `http://127.0.0.1:${productionServer.port}`,
]);
await waitUntil(
  () => compiledStreamHandshakes.filter((item) => item === 'interrupt-started').length >= 2,
  {
    message: 'compiled TTY prompt stream to start',
    yieldTurn: () => Bun.sleep(10),
  },
);
await waitUntil(() => promptPty.output().includes('Input required:'), {
  message: 'compiled TTY prompt to render',
  yieldTurn: () => Bun.sleep(10),
});
promptPty.terminal?.write('\u0003');
const promptPtyExitCode = await promptPty.exited;
promptPty.terminal?.close();
const promptPtyOutput = promptPty.output();
const compiledNonTtyPending = await invoke([
  'chat',
  '--agent',
  'demo',
  '--message',
  'interrupt-nontty',
  '--url',
  `http://127.0.0.1:${productionServer.port}`,
]);
const compiledEventsJson = await invoke([
  'chat',
  '--agent',
  'demo',
  '--message',
  'events',
  '--output',
  'json',
  '--url',
  `http://127.0.0.1:${productionServer.port}`,
]);
const compiledEventsJsonl = await invoke([
  'chat',
  '--agent',
  'demo',
  '--message',
  'events',
  '--output',
  'jsonl',
  '--url',
  `http://127.0.0.1:${productionServer.port}`,
]);
const compiledCursorAttach = await invoke([
  'chat',
  '--agent',
  'demo',
  '--thread',
  'thread-events',
  '--cursor',
  'cursor-attach',
  '--output',
  'json',
  '--url',
  `http://127.0.0.1:${productionServer.port}`,
]);
const binaryPath = join(directory, 'binary-upload.bin');
const binary = Buffer.alloc(256 * 1024 + 17);
for (let index = 0; index < binary.length; index += 1) binary[index] = (index * 37) % 256;
writeFileSync(binaryPath, binary);
const compiledUpload = await invoke([
  'chat',
  '--agent',
  'demo',
  '--message',
  'binary-upload',
  '--attachment',
  binaryPath,
  '--url',
  `http://127.0.0.1:${productionServer.port}`,
]);

const compiledRunStream = spawnWithHangGuard(
  [
    executable,
    'runs',
    'watch',
    '--kind',
    'task',
    'compiled-run',
    '--output',
    'jsonl',
    '--url',
    `http://127.0.0.1:${productionServer.port}`,
  ],
  { cwd: directory, env: environment, stdout: 'pipe', stderr: 'pipe' },
);
const compiledRunReader = compiledRunStream.stdout.getReader();
const compiledRunFirst = await readFirstJsonlRecord(compiledRunReader, (record) => {
  if (typeof record !== 'object' || record === null) return false;
  const value = record as { id?: unknown; event?: { kind?: unknown; status?: unknown } };
  return (
    value.id === 'task:compiled-run' &&
    value.event?.kind === 'task.status' &&
    value.event.status === 'running'
  );
});
compiledRunFirstRecord.resolve();
const compiledRunFirstChunk = {
  done: false,
  value: new TextEncoder().encode(`${compiledRunFirst.text}\n`),
};
const compiledRunSecondChunk = await compiledRunReader.read();
await compiledRunReader.cancel();
const compiledRunStreamExit = await compiledRunStream.exited;

const compiledRunSigint = spawnWithHangGuard(
  [
    executable,
    'runs',
    'watch',
    '--kind',
    'task',
    'compiled-open',
    '--url',
    `http://127.0.0.1:${productionServer.port}`,
  ],
  { cwd: directory, env: environment, stdout: 'pipe', stderr: 'pipe' },
);
await waitUntil(() => compiledRunHandshakes.includes('task:compiled-open'), {
  message: 'compiled task run watch to connect',
  yieldTurn: () => Bun.sleep(10),
});
const compiledRunSigintReader = compiledRunSigint.stdout.getReader();
const compiledRunSigintDecoder = new TextDecoder();
let compiledRunSigintStdout = '';
let compiledRunSigintFirstRecord = false;
while (!compiledRunSigintFirstRecord) {
  const next = await compiledRunSigintReader.read();
  if (next.done) break;
  compiledRunSigintStdout += compiledRunSigintDecoder.decode(next.value, { stream: true });
  const completeLines = compiledRunSigintStdout.split(/\r?\n/).slice(0, -1);
  for (const line of completeLines) {
    try {
      const record = JSON.parse(line) as {
        id?: unknown;
        event?: { kind?: unknown; status?: unknown };
      };
      if (
        record.id === 'task:compiled-open' &&
        record.event?.kind === 'task.status' &&
        record.event.status === 'running'
      ) {
        compiledRunSigintFirstRecord = true;
        break;
      }
    } catch {
      // Ignore an incomplete or unrelated line until the expected record arrives.
    }
  }
}
if (!compiledRunSigintFirstRecord)
  throw new Error('compiled task run watch did not emit its first stdout record');
compiledRunSigint.kill('SIGINT');
for (;;) {
  const next = await compiledRunSigintReader.read();
  if (next.done) break;
  compiledRunSigintStdout += compiledRunSigintDecoder.decode(next.value, { stream: true });
}
compiledRunSigintStdout += compiledRunSigintDecoder.decode();
compiledRunSigintReader.releaseLock();
const [compiledRunSigintStderr, compiledRunSigintExit] = await Promise.all([
  new Response(compiledRunSigint.stderr).text(),
  compiledRunSigint.exited,
]);
const compiledRunCancelCountAfterSigint = compiledRunCancelCalls.length;

const compiledRunTimeout = await invoke([
  'runs',
  'watch',
  '--kind',
  'task',
  'compiled-open',
  '--timeout',
  '50',
  '--url',
  `http://127.0.0.1:${productionServer.port}`,
]);
const compiledRunCancelCountAfterTimeout = compiledRunCancelCalls.length;
const compiledRunEof = await invoke([
  'runs',
  'watch',
  '--kind',
  'task',
  'compiled-eof',
  '--url',
  `http://127.0.0.1:${productionServer.port}`,
]);
const compiledRunFailed = await invoke([
  'runs',
  'watch',
  '--kind',
  'task',
  'compiled-failed',
  '--url',
  `http://127.0.0.1:${productionServer.port}`,
]);
const compiledRunPending = await invoke([
  'runs',
  'watch',
  '--kind',
  'task',
  'compiled-pending',
  '--url',
  `http://127.0.0.1:${productionServer.port}`,
]);
const compiledRunTaskList = await invoke([
  'runs',
  'list',
  '--kind',
  'task',
  '--cursor',
  'compiled-next',
  '--status',
  'running',
  '--output',
  'json',
  '--url',
  `http://127.0.0.1:${productionServer.port}`,
]);
const compiledRunWorkflowList = await invoke([
  'runs',
  'list',
  '--kind',
  'workflow',
  '--cursor',
  '2',
  '--output',
  'json',
  '--url',
  `http://127.0.0.1:${productionServer.port}`,
]);

test('compiled runs watch emits incremental terminal records before stream close', () => {
  const decoder = new TextDecoder();
  const first = decoder.decode(compiledRunFirstChunk.value);
  const second = decoder.decode(compiledRunSecondChunk.value);
  expect(compiledRunFirstChunk.done).toBe(false);
  expect(first).toContain('running');
  expect(second).toContain('completed');
  expect(compiledRunStreamExit).toBe(0);
});

test('compiled run observation detaches on SIGINT and timeout without cancellation', () => {
  expect(compiledRunSigintExit).toBe(130);
  expect(compiledRunSigintStdout).toContain('compiled-open');
  expect(compiledRunSigintStderr).toContain('no cancellation');
  expect(compiledRunTimeout.exitCode).toBe(130);
  expect(compiledRunTimeout.stderr.toString()).toContain('no cancellation');
  expect(compiledRunCancelCountAfterSigint).toBe(0);
  expect(compiledRunCancelCountAfterTimeout).toBe(0);
});

test('compiled run terminal and EOF outcomes are fail-closed and resumable', () => {
  expect(compiledRunEof.exitCode).toBe(1);
  expect(compiledRunEof.stderr.toString()).toContain('task:compiled-eof');
  expect(compiledRunFailed.exitCode).toBe(1);
  expect(compiledRunPending.exitCode).toBe(5);
  expect(compiledRunPending.stderr.toString()).toContain('task:compiled-pending');
});

test('compiled run list forwards kind, cursor, status, and both list methods', () => {
  const taskRequest = compiledRunRequests.find(
    (request) =>
      request.method === 'bureau.tasks.list' && request.params?.['pageToken'] === 'compiled-next',
  );
  const workflowRequest = compiledRunRequests.find(
    (request) =>
      request.method === 'bureau.workflows.runs.list' && request.params?.['offset'] === 2,
  );
  expect(compiledRunTaskList.exitCode).toBe(0);
  expect(compiledRunWorkflowList.exitCode).toBe(0);
  expect(taskRequest?.params).toMatchObject({ pageToken: 'compiled-next', status: 'running' });
  expect(workflowRequest?.params).toMatchObject({ offset: 2 });
  expect(JSON.parse(compiledRunTaskList.stdout.toString()).data.tasks[0].id).toBe(
    'task:compiled-run',
  );
  expect(JSON.parse(compiledRunWorkflowList.stdout.toString()).data.runs[0].id).toBe(
    'workflow:compiled-run',
  );
});

test('compiled help and version write stdout without validating or creating a home', () => {
  for (const result of [help, startHelp]) {
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('Usage: interborough start');
    expect(result.stderr.toString()).toBe('');
  }
  for (const result of [release, startRelease]) {
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(`${version}\n`);
    expect(result.stderr.toString()).toBe('');
  }
  expect(createdHome).toBe(false);
});

test('compiled commands use the production environment and preserve piped JSON parameters', () => {
  expect(productionConnection.exitCode).toBe(0);
  expect(productionStatus.exitCode).toBe(0);
  expect(productionStatus.stdout.toString()).toContain('production-deployment');
  expect(productionCallExitCode).toBe(0);
  expect(productionCallStderr).toBe('');
  expect(JSON.parse(productionCallStdout)).toEqual({ revision: 'r1', idempotencyKey: 'i1' });
  expect(productionRequests[0]?.headers.get('authorization')).toBe('Bearer production-secret');
});

test('compiled chat detaches on SIGINT and reports resumable identifiers', () => {
  expect(sigintExitCode).toBe(130);
  expect(`${sigintStdout}${sigintStderr}`).toMatch(/thread-[\w-]+/);
  expect(`${sigintStdout}${sigintStderr}`).toMatch(/run-[\w-]+/);
});

test('compiled PTY accepts initial user text without terminal EOF', () => {
  expect(initialPtyRequestSeen).toBe(true);
  expect(initialPtyExitCode).toBe(0);
  expect(initialPtyOutput).toContain('terminal text');
});

test('compiled TTY --no-input exits 5 without prompting', () => {
  expect(noInputPtyExitCode).toBe(5);
  expect(noInputPtyOutput).not.toContain('Input required:');
  expect(noInputPtyOutput).toContain('thread-compiled');
});

test('compiled PTY prompt SIGINT detaches with identifiers and no resubmission', () => {
  expect(promptPtyExitCode).toBe(130);
  expect(promptPtyOutput).toContain('Input required:');
  expect(promptPtyOutput).toContain('thread-compiled');
  expect(promptPtyOutput).toContain('run-compiled');
  expect(
    uploadedChatBodies.filter((body) => JSON.stringify(body).includes('interrupt-prompt')),
  ).toHaveLength(1);
});

test('compiled non-TTY pending input exits 5 with resumable identifiers', () => {
  expect(compiledNonTtyPending.exitCode).toBe(5);
  expect(compiledNonTtyPending.stdout.toString()).toContain('thread-compiled');
  expect(compiledNonTtyPending.stdout.toString()).toContain('interrupt-compiled');
});

test('compiled structured output preserves idless deltas, dedupes durable events, snapshots, and redacts private frames', () => {
  const json = JSON.parse(compiledEventsJson.stdout.toString()) as {
    data: { text: string; events: unknown[] };
  };
  expect(compiledEventsJson.exitCode).toBe(0);
  expect(json.data.text).toBe('snapshotsamesamedurable');
  expect(json.data.events).toContainEqual({ kind: 'snapshot', text: 'snapshot' });
  expect(JSON.stringify(json)).not.toContain('private-reasoning');
  expect(JSON.stringify(json)).not.toContain('private-args');
  expect(compiledEventsJsonl.exitCode).toBe(0);
  expect(compiledEventsJsonl.stdout.toString()).toContain('"kind":"snapshot"');
  expect(compiledEventsJsonl.stdout.toString().match(/"delta":"durable"/g)).toHaveLength(1);
  expect(compiledCursorAttach.exitCode).toBe(0);
  expect(JSON.parse(compiledCursorAttach.stdout.toString()).data.resynced).toBe(true);
});

test('compiled binary upload preserves every non-UTF8 byte in bounded chunks and completes a provider part', () => {
  expect(compiledUpload.exitCode).toBe(0);
  expect(uploadChunks).toHaveLength(2);
  expect(Buffer.concat(uploadChunks)).toEqual(binary);
  const body = uploadedChatBodies.find((candidate) =>
    JSON.stringify(candidate).includes('compiled-asset'),
  );
  expect(body).toBeDefined();
  expect(JSON.stringify(body)).toContain('"provider":"bureau"');
  expect(JSON.stringify(body)).toContain('"value":"compiled-asset"');
});

test('compiled binary routes configuration commands through the authenticated host', () => {
  expect(compiledConfigurationList.exitCode).toBe(0);
  expect(compiledConfigurationList.stdout.toString()).toContain('configurationRevision');
  expect(
    productionRequests.some(
      (request) => new URL(request.url).pathname === '/host/providers' && request.method === 'GET',
    ),
  ).toBe(true);
});

test('compiled binary performs revisioned provider configuration and rejects argv secrets', () => {
  expect(compiledConfigurationMutation.exitCode).toBe(0);
  expect(compiledUnknownProvider.exitCode).toBe(2);
  expect(compiledInvalidConfiguration.exitCode).toBe(2);
  expect(compiledInlineSecret.exitCode).toBe(2);
  expect(compiledConfigurationMutation.stdout.toString()).not.toContain('compiled-provider-secret');
  expect(compiledInlineSecret.stderr.toString()).toContain('never --input');
  expect(
    productionRequests.filter(
      (request) =>
        new URL(request.url).pathname === '/host/providers/openai' && request.method === 'PUT',
    ),
  ).toHaveLength(1);
  expect(
    productionRequests.filter(
      (request) =>
        new URL(request.url).pathname === '/host/plugins/openai' && request.method === 'PUT',
    ),
  ).toHaveLength(1);
  expect(
    productionRequests.some(
      (request) =>
        new URL(request.url).pathname === '/host/providers/openai' && request.method === 'PUT',
    ),
  ).toBe(true);
});

const invalidOptions = [
  ['--unknown'],
  ['--port'],
  ['--port', '--help'],
  ['--port', '0', '--port=1'],
  ['--port='],
  ['--port', '0x10'],
  ['--port', '65536'],
  ['--home='],
  ['--home', '.env'],
  ['--home', '.env/child'],
  ['--a2a-public-origin', 'http://agents.example.com'],
  ['--a2a-public-origin', 'https://agents.example.com/path'],
  ['extra'],
];
const invalidResults = [];
for (const options of invalidOptions) {
  invalidResults.push({ options, result: await invoke(['start', ...options]) });
}

test.each(invalidResults)('rejects $options before starting the host', ({ result }) => {
  expect(result.exitCode).toBe(2);
  expect(result.stdout.toString()).toBe('');
  expect(result.stderr.toString()).not.toBe('');
});

async function exerciseStart() {
  const running = spawnWithHangGuard([executable, 'start', '--port=0', '--home', 'relative-home'], {
    cwd: directory,
    env: { ...environment, INTERBOROUGH_PORT: 'bad', INTERBOROUGH_HOME: '.env' },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  let output = '';
  const read = (async () => {
    for await (const chunk of running.stdout.pipeThrough(new TextDecoderStream())) output += chunk;
  })();
  const urls = () =>
    Array.from(
      output.matchAll(/^Interborough is listening on (http:\/\/127\.0\.0\.1:\d+)$/gm),
      (match) => match[1],
    );
  const waitForUrl = (count: number) =>
    waitUntil(() => urls().length === count, {
      message: 'the standalone host to report its listening URL',
      yieldTurn: () => Bun.sleep(25),
    });
  let evidence;
  try {
    await waitForUrl(1);
    const first = urls()[0];
    if (first === undefined) throw new Error('Missing startup URL.');
    const beforeStatus = await fetch(new URL('/host/status', first));
    const beforeIdentity = await beforeStatus.json();
    const homeCreated = existsSync(join(directory, 'relative-home'));
    const restart = await fetch(new URL(HOST_RESTART_ROUTE, first), { method: 'POST' });
    await waitForUrl(2);
    const second = urls()[1];
    if (second === undefined) throw new Error('Missing restarted URL.');
    const afterStatus = await fetch(new URL('/host/status', second));
    const afterIdentity = await afterStatus.json();
    const response = await fetch(second);
    evidence = {
      port: new URL(first).port,
      homeCreated,
      restartStatus: restart.status,
      beforeIdentity,
      afterIdentity,
      html: await response.text(),
    };
  } finally {
    running.kill('SIGTERM');
    await running.exited;
    await read;
  }
  return { ...evidence, exitCode: running.exitCode, output };
}

const started = await exerciseStart();
test('starts itself, resolves the port and relative home flags, restarts and forwards SIGTERM', () => {
  expect(started.port).not.toBe('0');
  expect(started.homeCreated).toBe(true);
  expect(started.restartStatus).toBe(202);
  expect(started.beforeIdentity.deploymentId).toBe(started.afterIdentity.deploymentId);
  expect(started.beforeIdentity.incarnationId).not.toBe(started.afterIdentity.incarnationId);
  expect(started.afterIdentity.diagnostics).toBeDefined();
  expect(JSON.stringify(started.afterIdentity)).not.toContain('secret');
  expect(started.html).toContain('<title>Interborough</title>');
  expect(started.exitCode).toBe(0);
  expect(started.output.match(/Started the host/g)).toHaveLength(2);
});

const startingFixture = join(directory, 'restart-during-start.test.ts');
const hostModule = JSON.stringify(join(import.meta.dir, 'host.ts'));
const serveModule = JSON.stringify(join(import.meta.dir, 'serve.ts'));
writeFileSync(
  startingFixture,
  `import { mock, test } from 'bun:test';
mock.module(${hostModule}, () => ({
  async startHost({ onRestartRequested }) {
    queueMicrotask(() => { void onRestartRequested(); });
    await new Promise((resolve) => setImmediate(resolve));
    return {
      url: new URL('http://127.0.0.1:7234'),
      database: { kind: 'postgres' },
      async close() { console.info('Closed the host after startup.'); },
    };
  },
}));
const { serveHost } = await import(${serveModule});
test('restart requested before startup resolves', async () => {
  await serveHost({}, '.');
  await new Promise((resolve) => setImmediate(resolve));
});
`,
);
const earlyRestart = await runWithHangGuard([process.execPath, 'test', startingFixture], {
  cwd: directory,
});

test('a restart received during startup closes the host before requesting a relaunch', () => {
  expect(earlyRestart.exitCode).toBe(RESTART_EXIT_CODE);
  expect(earlyRestart.stdout.toString()).toContain('Closed the host after startup.');
});
