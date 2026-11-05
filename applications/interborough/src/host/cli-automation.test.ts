import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { afterAll, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'interborough-cli-automation-'));
const executable = join(directory, 'interborough');
const scheduleFile = join(directory, 'schedule.json');
const hookFile = join(directory, 'hook.json');
const scheduleUpdateFile = join(directory, 'schedule-update.json');
const goalFile = join(directory, 'goal.json');
const hookUpdateFile = join(directory, 'hook-update.json');
await writeFile(
  scheduleFile,
  JSON.stringify({ agentName: 'agent', spec: '* * * * *', input: 'hello', timeZone: 'UTC' }),
);
await writeFile(
  hookFile,
  JSON.stringify({ events: ['task.completed'], url: 'https://example.test/hook' }),
);
await writeFile(
  scheduleUpdateFile,
  JSON.stringify({ spec: '*/5 * * * *', timeZone: 'America/Denver' }),
);
await writeFile(
  goalFile,
  JSON.stringify({
    idempotencyKey: 'goal-1',
    agentName: 'agent',
    prompt: 'reach the goal',
    identity: { name: 'cli-test', version: '1' },
    validator: { name: 'test', version: '1' },
    bounds: { maximumAttempts: 1, maximumTotalSteps: 10 },
  }),
);
await writeFile(hookUpdateFile, JSON.stringify({ events: ['task.failed'], enabled: false }));
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
    const body = (await request.json()) as { method?: string; params?: Record<string, unknown> };
    requests.push(body);
    const params = body.params ?? {};
    const required =
      body.method === 'bureau.schedules.create'
        ? ['agentName', 'spec', 'input']
        : body.method === 'bureau.goals.create'
          ? ['agentName', 'prompt', 'identity', 'validator', 'bounds']
          : body.method === 'bureau.hooks.create'
            ? ['events']
            : [];
    if (required.some((key) => !(key in params)))
      return Response.json(
        { message: `Missing required field ${required.find((key) => !(key in params))}` },
        { status: 400 },
      );
    if (body.method === 'bureau.schedules.update' && params['scheduleId'] === 'stale')
      return Response.json(
        { message: 'stale', error: { data: { httpStatus: 409 } } },
        { status: 409 },
      );
    if (body.method === 'bureau.hooks.create' || body.method === 'bureau.hooks.secret.replace')
      return Response.json({ result: { id: 'hook-1', signingSecret: 'secret-value' } });
    return Response.json({
      result: {
        ...body.params,
        revision: 2,
        timeZone: 'America/Denver',
        nextFireAt: '2026-11-05T12:00:00.000Z',
      },
    });
  },
});
const environment = { PATH: '', HOME: directory, NODE_ENV: 'production' };
const invoke = (arguments_: string[]) =>
  runWithHangGuard([executable, ...arguments_], { cwd: directory, env: environment });
afterAll(async () => {
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
async function invokeCommands(commands: string[][]): Promise<void> {
  const url = `http://127.0.0.1:${server.port}`;
  for (const command of commands) {
    const result = await invoke([...command, '--url', url]);
    expect(result.exitCode).toBe(0);
  }
}

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled automation commands forward schedules', async () => {
  await invokeCommands([
    ['schedules', 'list'],
    ['schedules', 'get', 'schedule-1'],
    ['schedules', 'create', '--file', scheduleFile],
    ['schedules', 'update', 'schedule-1', '--file', scheduleUpdateFile, '--if-revision', '1'],
    ['schedules', 'pause', 'schedule-1', '--if-revision', '2'],
    ['schedules', 'resume', 'schedule-1', '--if-revision', '3'],
    ['schedules', 'run', 'schedule-1'],
    [
      'schedules',
      'skip-next',
      'schedule-1',
      '--occurrence',
      '2026-11-05T12:00:00.000Z',
      '--if-revision',
      '2',
    ],
  ]);
  expect(requests.map(({ method }) => method).slice(-8)).toEqual([
    'bureau.schedules.list',
    'bureau.schedules.get',
    'bureau.schedules.create',
    'bureau.schedules.update',
    'bureau.schedules.pause',
    'bureau.schedules.resume',
    'bureau.schedules.runnow',
    'bureau.schedules.skipnext',
  ]);
  expect(requests.at(-2)?.params).toEqual({ scheduleId: 'schedule-1' });
  expect(requests.at(-1)?.params).toMatchObject({ scheduleId: 'schedule-1', expectedRevision: 2 });
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled automation commands forward goals', async () => {
  await invokeCommands([
    ['goals', 'list'],
    ['goals', 'get', 'goal-1'],
    ['goals', 'create', '--file', goalFile],
    ['goals', 'cancel', 'goal-1', '--if-revision', '2'],
  ]);
  expect(requests.map(({ method }) => method).slice(-4)).toEqual([
    'bureau.goals.list',
    'bureau.goals.get',
    'bureau.goals.create',
    'bureau.goals.cancel',
  ]);
  expect(requests.at(-1)?.params).toMatchObject({ goalRunId: 'goal-1', expectedRevision: 2 });
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled automation commands forward hooks', async () => {
  await invokeCommands([
    ['hooks', 'list'],
    ['hooks', 'get', 'hook-1'],
    ['hooks', 'create', '--file', hookFile],
    ['hooks', 'update', 'hook-1', '--file', hookUpdateFile, '--if-revision', '1'],
    ['hooks', 'replace-secret', 'hook-1', '--if-revision', '2'],
    ['hooks', 'delete', 'hook-1'],
    ['hooks', 'test', 'hook-1'],
    ['hooks', 'deliveries', 'hook-1'],
  ]);
  expect(requests.map(({ method }) => method).slice(-8)).toEqual([
    'bureau.hooks.list',
    'bureau.hooks.get',
    'bureau.hooks.create',
    'bureau.hooks.update',
    'bureau.hooks.secret.replace',
    'bureau.hooks.delete',
    'bureau.hooks.test',
    'bureau.hooks.deliveries',
  ]);
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled mutations fail closed without retrying and reject owner impersonation', async () => {
  const url = `http://127.0.0.1:${server.port}`;
  const before = requests.length;
  const stale = await invoke([
    'schedules',
    'update',
    'stale',
    '--file',
    scheduleUpdateFile,
    '--if-revision',
    '1',
    '--url',
    url,
  ]);
  expect(stale.exitCode).toBe(4);
  expect(
    requests.slice(before).filter(({ method }) => method === 'bureau.schedules.update'),
  ).toHaveLength(1);
  const impersonation = await invoke([
    'hooks',
    'create',
    '--file',
    hookFile,
    '--owner',
    'someone',
    '--url',
    url,
  ]);
  expect(impersonation.exitCode).toBe(2);
  expect(
    requests.slice(before).filter(({ method }) => method === 'bureau.hooks.create'),
  ).toHaveLength(0);
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled hook output redacts a generated secret unless explicitly written', async () => {
  const url = `http://127.0.0.1:${server.port}`;
  const secretOutput = join(directory, 'secret.txt');
  const result = await invoke([
    'hooks',
    'create',
    '--file',
    hookFile,
    '--secret-output',
    secretOutput,
    '--url',
    url,
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).not.toContain('secret-value');
  expect(await Bun.file(secretOutput).text()).toBe('secret-value\n');
  const secretStatus = await stat(secretOutput);
  expect(secretStatus.mode & 0o777).toBe(0o600);
  await chmod(secretOutput, 0o600);
  const refused = await invoke([
    'hooks',
    'create',
    '--file',
    hookFile,
    '--secret-output',
    secretOutput,
    '--url',
    url,
  ]);
  expect(refused.exitCode).not.toBe(0);
});
