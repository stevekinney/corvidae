import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCliDispatches } from './cli-dispatch.test-support.ts';

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
await writeFile(
  hookUpdateFile,
  JSON.stringify({ url: 'https://example.test/updated', events: ['task.failed'], enabled: false }),
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

const dispatches: string[] = [];
const requests: Array<{ method?: string; params?: Record<string, unknown> }> = [];
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { method?: string; params?: Record<string, unknown> };
    requests.push(body);
    dispatches.push(body.method ?? `${request.method} ${new URL(request.url).pathname}`);
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
    if (body.method === 'bureau.schedules.skipnext' && params['occurrence'] === 'conflict')
      return Response.json(
        { message: 'occurrence is no longer next', error: { data: { httpStatus: 409 } } },
        { status: 409 },
      );
    if (body.method === 'bureau.hooks.create' || body.method === 'bureau.hooks.secret.replace')
      return Response.json({ result: { id: 'hook-1', signingSecret: 'secret-value' } });
    if (body.method === 'bureau.schedules.pause')
      return Response.json({ result: { outcome: 'paused', status: 'paused', revision: 3 } });
    if (body.method === 'bureau.schedules.resume')
      return Response.json({ result: { outcome: 'resumed', status: 'active', revision: 4 } });
    if (body.method === 'bureau.goals.cancel')
      return Response.json({ result: { outcome: 'canceled', status: 'canceled', revision: 3 } });
    if (body.method === 'bureau.schedules.create' || body.method === 'bureau.schedules.update')
      return Response.json({
        result: {
          ...params,
          id: 'schedule-1',
          timeZone: 'America/Denver',
          nextFireAt: '2026-11-05T12:00:00.000Z',
        },
      });
    if (body.method === 'bureau.goals.create')
      return Response.json({
        result: {
          outcome: 'created',
          goalRunId: 'goal-1',
          idempotencyKey: params['idempotencyKey'],
        },
      });
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
const invoke = async (arguments_: string[]) => {
  const start = dispatches.length;
  const result = await runWithHangGuard([executable, ...arguments_], {
    cwd: directory,
    env: environment,
  });
  assertCliDispatches(arguments_, dispatches.slice(start));
  return result;
};
afterAll(async () => {
  server.stop(true);
  await rm(directory, { recursive: true, force: true });
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
async function invokeCommands(
  commands: string[][],
): Promise<Array<Awaited<ReturnType<typeof invoke>>>> {
  const url = `http://127.0.0.1:${server.port}`;
  const results: Array<Awaited<ReturnType<typeof invoke>>> = [];
  for (const command of commands) {
    const result = await invoke([...command, '--url', url]);
    expect(result.exitCode).toBe(0);
    results.push(result);
  }
  return results;
}

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled automation commands forward schedules', async () => {
  const outputs = await invokeCommands([
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
  const scheduleRequests = requests.slice(-8);
  expect(scheduleRequests[2]?.params).toMatchObject({
    agentName: 'agent',
    spec: '* * * * *',
    input: 'hello',
    timeZone: 'UTC',
  });
  expect(scheduleRequests[3]?.params).toEqual({
    scheduleId: 'schedule-1',
    spec: '*/5 * * * *',
    timeZone: 'America/Denver',
    expectedRevision: 1,
  });
  expect(scheduleRequests[4]?.params).toEqual({ scheduleId: 'schedule-1', expectedRevision: 2 });
  expect(scheduleRequests[5]?.params).toEqual({ scheduleId: 'schedule-1', expectedRevision: 3 });
  expect(scheduleRequests[7]?.params).toEqual({
    scheduleId: 'schedule-1',
    occurrence: '2026-11-05T12:00:00.000Z',
    expectedRevision: 2,
  });
  expect(outputs[2]?.stdout.toString()).toContain('America/Denver');
  expect(outputs[2]?.stdout.toString()).toContain('2026-11-05T12:00:00.000Z');
  expect(outputs[3]?.stdout.toString()).toContain('America/Denver');
  expect(outputs[3]?.stdout.toString()).toContain('2026-11-05T12:00:00.000Z');
  expect(outputs[4]?.stdout.toString()).toContain('paused');
  expect(outputs[5]?.stdout.toString()).toContain('resumed');
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled automation commands forward goals', async () => {
  const outputs = await invokeCommands([
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
  expect(requests.at(-2)?.params).toMatchObject({
    idempotencyKey: 'goal-1',
    agentName: 'agent',
    prompt: 'reach the goal',
    identity: { name: 'cli-test', version: '1' },
    validator: { name: 'test', version: '1' },
    bounds: { maximumAttempts: 1, maximumTotalSteps: 10 },
  });
  expect(outputs[2]?.stdout.toString()).toContain('goal-1');
  expect(outputs[3]?.stdout.toString()).toContain('canceled');
});

// spawn-free: compiled subprocesses are the behavior under test and use the hang guard.
test('compiled automation commands forward hooks', async () => {
  const outputs = await invokeCommands([
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
  const hookRequests = requests.slice(-8);
  expect(hookRequests[2]?.params).toMatchObject({
    events: ['task.completed'],
    url: 'https://example.test/hook',
  });
  expect(hookRequests[3]?.params).toMatchObject({
    hookId: 'hook-1',
    url: 'https://example.test/updated',
    expectedRevision: 1,
  });
  expect(hookRequests[4]?.params).toEqual({ hookId: 'hook-1', expectedRevision: 2 });
  expect(outputs[4]?.stdout.toString()).not.toContain('secret-value');
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
  const skipBefore = requests.length;
  const skipConflict = await invoke([
    'schedules',
    'skip-next',
    'schedule-1',
    '--occurrence',
    'conflict',
    '--if-revision',
    '2',
    '--url',
    url,
  ]);
  expect(skipConflict.exitCode).toBe(4);
  expect(
    requests.slice(skipBefore).filter(({ method }) => method === 'bureau.schedules.skipnext'),
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
  expect(result.stdout.toString()).not.toContain('secret-value');
  expect(result.stderr.toString()).not.toContain('secret-value');
  expect(await Bun.file(secretOutput).text()).toBe('secret-value\n');
  const secretStatus = await stat(secretOutput);
  expect(secretStatus.mode & 0o777).toBe(0o600);
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

  const replacementOutput = join(directory, 'replacement-secret.txt');
  const replacement = await invoke([
    'hooks',
    'replace-secret',
    'hook-1',
    '--if-revision',
    '2',
    '--secret-output',
    replacementOutput,
    '--url',
    url,
  ]);
  expect(replacement.exitCode).toBe(0);
  expect(replacement.stdout.toString()).not.toContain('secret-value');
  expect(replacement.stderr.toString()).not.toContain('secret-value');
  expect(await Bun.file(replacementOutput).text()).toBe('secret-value\n');
  const replacementStatus = await stat(replacementOutput);
  expect(replacementStatus.mode & 0o777).toBe(0o600);
  const replacementBytes = await Bun.file(replacementOutput).bytes();
  const replacementRefused = await invoke([
    'hooks',
    'replace-secret',
    'hook-1',
    '--if-revision',
    '2',
    '--secret-output',
    replacementOutput,
    '--url',
    url,
  ]);
  expect(replacementRefused.exitCode).not.toBe(0);
  expect(await Bun.file(replacementOutput).bytes()).toEqual(replacementBytes);
});
