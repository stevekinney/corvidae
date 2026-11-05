import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { afterAll, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'interborough-cli-automation-'));
const executable = join(directory, 'interborough');
const scheduleFile = join(directory, 'schedule.json');
const hookFile = join(directory, 'hook.json');
await writeFile(
  scheduleFile,
  JSON.stringify({ agentName: 'agent', spec: '* * * * *', input: 'hello', timeZone: 'UTC' }),
);
await writeFile(
  hookFile,
  JSON.stringify({ events: ['task.completed'], url: 'https://example.test/hook' }),
);
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
    if (body.method === 'bureau.hooks.create')
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
test('compiled automation commands forward schedules and goals', async () => {
  await invokeCommands([
    ['schedules', 'create', '--file', scheduleFile],
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
    ['goals', 'create', '--file', scheduleFile],
    ['goals', 'cancel', 'goal-1', '--if-revision', '2'],
  ]);
  expect(requests.map(({ method }) => method).slice(-5)).toEqual([
    'bureau.schedules.create',
    'bureau.schedules.runnow',
    'bureau.schedules.skipnext',
    'bureau.goals.create',
    'bureau.goals.cancel',
  ]);
  expect(requests[1]?.params).toEqual({ scheduleId: 'schedule-1' });
  expect(requests[2]?.params).toMatchObject({ scheduleId: 'schedule-1', expectedRevision: 2 });
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled automation commands forward hooks', async () => {
  await invokeCommands([
    ['hooks', 'create', '--file', hookFile],
    ['hooks', 'get', 'hook-1'],
    ['hooks', 'deliveries', 'hook-1'],
  ]);
  expect(requests.map(({ method }) => method).slice(-3)).toEqual([
    'bureau.hooks.create',
    'bureau.hooks.get',
    'bureau.hooks.deliveries',
  ]);
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
