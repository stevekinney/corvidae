import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'interborough-cli-definitions-'));
const executable = join(directory, 'interborough');
const definitionFile = join(directory, 'definition.json');
const workflowFile = join(directory, 'workflow.json');
await writeFile(definitionFile, JSON.stringify({ model: 'anthropic/test', instructions: 'hello' }));
await writeFile(workflowFile, JSON.stringify({ title: 'test', steps: [] }));

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

const requests: Array<{ method?: string; params?: Record<string, unknown> }> = [];
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/bureau/jsonrpc') {
      const body = (await request.json()) as {
        method?: string;
        params?: Record<string, unknown>;
      };
      requests.push(body);
      const id = body.params?.['id'];
      if (id === 'stale')
        return Response.json({ error: { message: 'stale', data: { httpStatus: 409 } } });
      if (id === 'denied')
        return Response.json({ error: { message: 'denied', data: { httpStatus: 403 } } });
      if (id === 'uncertain') return new Response('{"jsonrpc":"2.0"', { status: 200 });
      if (body.method === 'bureau.workflows.start')
        return Response.json({
          result: { runId: 'run-1', workflow: 'test', workflowVersion: '1' },
        });
      return Response.json({ result: body.params ?? {} });
    }
    if (pathname === '/v1/workflows/run-1/events/sse') {
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      const writer = stream.writable.getWriter();
      void writer
        .write(
          new TextEncoder().encode(
            'id: event-1\ndata: {"kind":"workflow:completed","status":"completed"}\n\n',
          ),
        )
        .then(() => writer.close());
      return new Response(stream.readable, { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({});
  },
});

const environment = { PATH: '', HOME: directory, NODE_ENV: 'production' };
const invoke = (arguments_: string[]) =>
  runWithHangGuard([executable, ...arguments_], {
    cwd: directory,
    env: { ...environment },
  });

afterAll(async () => {
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled definitions commands map every route to Bureau operations', async () => {
  const commands = [
    ['agents', 'list'],
    ['agents', 'get', 'test'],
    ['agents', 'create', 'test', '--file', definitionFile],
    ['agents', 'update', 'test', '--file', definitionFile, '--if-revision', 'hash-1'],
    ['agents', 'delete', 'test', '--if-revision', 'hash-1'],
    ['agents', 'duplicate', 'plugin:test'],
    ['agents', 'models'],
    ['agents', 'versions', 'list', 'test'],
    ['agents', 'versions', 'restore', 'test', '3', '--if-revision', 'hash-1'],
    ['agents', 'try', '--file', definitionFile, '--message', 'hello'],
    ['workflows', 'list'],
    ['workflows', 'get', 'test'],
    ['workflows', 'create', 'test', '--file', workflowFile],
    ['workflows', 'update', 'test', '--file', workflowFile, '--if-revision', 'hash-1'],
    ['workflows', 'validate', 'test', '--file', workflowFile],
    ['workflows', 'start', 'test', '--input-file', workflowFile],
    ['workflows', 'start', 'test', '--input-file', workflowFile, '--wait'],
    ['workflows', 'signal', 'ready', '--input-file', workflowFile, '--signal-id', 'sig-1'],
    ['workflows', 'history', 'test'],
  ];
  for (const command of commands.slice(0, 4)) {
    const result = await invoke([...command, '--url', `http://127.0.0.1:${server.port}`]);
    expect(result.exitCode).toBe(0);
  }
  expect(requests.map((request) => request.method)).toEqual(
    [
      'bureau.agents.definitions.list',
      'bureau.agents.definitions.get',
      'bureau.agents.definitions.create',
      'bureau.agents.definitions.update',
      'bureau.agents.definitions.delete',
      'bureau.agents.definitions.duplicate',
      'bureau.agents.catalog',
      'bureau.agents.versions.list',
      'bureau.agents.versions.restore',
    ].slice(0, 4),
  );
  expect(requests[3]?.params).toMatchObject({ id: 'test', expectedHash: 'hash-1' });
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled definitions commands cover delete, duplicate, and models', async () => {
  const commands = [
    ['agents', 'delete', 'test', '--if-revision', 'hash-1'],
    ['agents', 'duplicate', 'plugin:test'],
    ['agents', 'models'],
  ];
  for (const command of commands) {
    const result = await invoke([...command, '--url', `http://127.0.0.1:${server.port}`]);
    expect(result.exitCode).toBe(0);
  }
  expect(requests.map((request) => request.method).slice(-3)).toEqual([
    'bureau.agents.definitions.delete',
    'bureau.agents.definitions.duplicate',
    'bureau.agents.catalog',
  ]);
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled definitions commands cover versions and transient try', async () => {
  const commands = [
    ['agents', 'versions', 'list', 'test'],
    ['agents', 'versions', 'restore', 'test', '3', '--if-revision', 'hash-1'],
    ['agents', 'try', '--file', definitionFile, '--message', 'hello'],
  ];
  for (const command of commands) {
    const result = await invoke([...command, '--url', `http://127.0.0.1:${server.port}`]);
    expect(result.exitCode).toBe(0);
  }
  expect(
    requests.some(
      (request) =>
        request.method === 'bureau.agents.versions.restore' && request.params?.['revision'] === 3,
    ),
  ).toBe(true);
  expect(
    requests.some(
      (request) =>
        request.method === 'bureau.agents.try' && request.params?.['message'] === 'hello',
    ),
  ).toBe(true);
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled workflow commands cover validation, start observation, signal, and history', async () => {
  const commands = [
    ['workflows', 'list'],
    ['workflows', 'get', 'test'],
    ['workflows', 'create', 'test', '--file', workflowFile],
    ['workflows', 'update', 'test', '--file', workflowFile, '--if-revision', 'hash-1'],
    ['workflows', 'validate', 'test', '--file', workflowFile],
    ['workflows', 'start', 'test', '--input-file', workflowFile],
    ['workflows', 'start', 'test', '--input-file', workflowFile, '--wait'],
    ['workflows', 'signal', 'ready', '--input-file', workflowFile, '--signal-id', 'sig-1'],
    ['workflows', 'history', 'test'],
  ];
  for (const command of commands) {
    const result = await invoke([...command, '--url', `http://127.0.0.1:${server.port}`]);
    expect(result.exitCode).toBe(0);
  }
  expect(requests.map((request) => request.method).slice(-9)).toEqual([
    'bureau.workflows.list',
    'bureau.workflows.get',
    'bureau.workflows.create',
    'bureau.workflows.update',
    'bureau.workflows.validate',
    'bureau.workflows.start',
    'bureau.workflows.start',
    'bureau.workflows.signal',
    'bureau.workflows.history',
  ]);
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled definitions commands fail closed and do not retry mutations', async () => {
  const before = requests.length;
  const stale = await invoke([
    'agents',
    'update',
    'stale',
    '--file',
    definitionFile,
    '--if-revision',
    'hash-1',
    '--url',
    `http://127.0.0.1:${server.port}`,
  ]);
  expect(stale.exitCode).toBe(4);
  const denied = await invoke([
    'agents',
    'delete',
    'denied',
    '--if-revision',
    'hash-1',
    '--url',
    `http://127.0.0.1:${server.port}`,
  ]);
  expect(denied.exitCode).toBe(3);
  const uncertain = await invoke([
    'agents',
    'create',
    'uncertain',
    '--file',
    definitionFile,
    '--url',
    `http://127.0.0.1:${server.port}`,
  ]);
  expect(uncertain.exitCode).toBe(7);
  expect(requests.length - before).toBe(3);
  const invalid = await invoke([
    'agents',
    'update',
    'test',
    '--file',
    definitionFile,
    '--url',
    `http://127.0.0.1:${server.port}`,
  ]);
  expect(invalid.exitCode).toBe(2);
  expect(requests.length - before).toBe(3);
});
