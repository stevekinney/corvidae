/**
 * The supervisor restarts the host on exit code 75 and stops on every other code, forwards the
 * stop signals, and refuses `start` without a build. The host's own restart is in
 * `supervisor.slow.test.ts`; these run the real supervisor around a stand-in child.
 *
 * Every process runs at module scope, under the supervisor's own children or the hang guard, so
 * none is on Bun's per-test clock; the tests assert on what each run recorded.
 */
import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterAll, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hostCommand, supervise, type SupervisorSignals } from './supervisor.ts';

const fixture = join(import.meta.dir, 'supervisor-fixture.test-support.ts');
const supervisorEntry = join(import.meta.dir, 'supervisor.ts');
const packageDirectory = join(import.meta.dir, '..', '..');

const directories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'interborough-supervisor-'));
  directories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const starts = (log: string): number => readFileSync(log, 'utf8').trim().split('\n').length;

const silent = { log: () => undefined, error: () => undefined };

/** Supervise the stand-in host with `behavior` and its arguments, and record how it ended. */
async function superviseFixture(
  behavior: string[],
  options: { prepare?: () => string | undefined } = {},
): Promise<{ code: number; starts: number; logLines: string[]; errorLines: string[] }> {
  const log = join(scratch(), 'starts.log');
  const logLines: string[] = [];
  const errorLines: string[] = [];
  const code = await supervise({
    command: [process.execPath, '--no-install', fixture, log, ...behavior],
    ...(options.prepare === undefined ? {} : { prepare: options.prepare }),
    log: (message) => logLines.push(message),
    error: (message) => errorLines.push(message),
  });
  return { code, starts: existsSync(log) ? starts(log) : 0, logLines, errorLines };
}

/** Supervise a stand-in host that waits for a stop signal, send `signal`, and record how it ended. */
async function superviseUntilSignalled(
  exitCode: string,
  signal: 'SIGINT' | 'SIGTERM',
): Promise<{ code: number; starts: number; listeners: number }> {
  const directory = scratch();
  const log = join(directory, 'starts.log');
  const ready = join(directory, 'ready');
  const signals: SupervisorSignals & EventEmitter = new EventEmitter();
  const running = supervise({
    command: [process.execPath, '--no-install', fixture, log, 'wait', ready, exitCode],
    signals,
    ...silent,
  });
  await waitUntil(() => existsSync(ready), {
    message: 'the child to install its handler',
    yieldTurn: () => Bun.sleep(25),
  });
  signals.emit(signal);
  const code = await running;
  return {
    code,
    starts: starts(log),
    listeners: signals.listenerCount('SIGTERM') + signals.listenerCount('SIGINT'),
  };
}

const restarted = await superviseFixture(['exit', '75', '75', '3']);
const restartedThenClean = await superviseFixture(['exit', '75', '0']);
const exitCodes = [0, 1, 2, 74, 76, 137] as const;
const stopped = new Map<number, Awaited<ReturnType<typeof superviseFixture>>>();
for (const exitCode of exitCodes)
  stopped.set(exitCode, await superviseFixture(['exit', String(exitCode)]));

const refused = await superviseFixture(['exit', '0'], { prepare: () => 'not ready' });
let checks = 0;
const buildWentMissing = await superviseFixture(['exit', '75', '75'], {
  prepare: () => (++checks > 1 ? 'gone' : undefined),
});

const racingRestart = await superviseUntilSignalled('75', 'SIGTERM');
const cleanStop = await superviseUntilSignalled('0', 'SIGTERM');
const unhandled = await superviseUntilSignalled('unhandled', 'SIGTERM');
const failingStop = await superviseUntilSignalled('9', 'SIGINT');

const emptyBuild = scratch();
const missingBuild = await runWithHangGuard([process.execPath, supervisorEntry, 'serve'], {
  cwd: packageDirectory,
  env: { ...process.env, INTERBOROUGH_BUILD_DIRECTORY: emptyBuild },
});
const badArguments = new Map<string, Awaited<ReturnType<typeof runWithHangGuard>>>();
for (const argumentsList of [
  [],
  ['serve', 'extra'],
  ['nonsense'],
  ['dev', '--entry'],
  ['dev', '--plugin'],
  ['dev', '--plugin', ''],
  ['serve', '--plugin', '/somewhere'],
  ['dev', '--entry', '/a', '--entry', '/b'],
]) {
  badArguments.set(
    JSON.stringify(argumentsList),
    await runWithHangGuard([process.execPath, supervisorEntry, ...argumentsList], {
      cwd: packageDirectory,
    }),
  );
}

describe('supervise', () => {
  test('starts the host again on exit code 75 and ends with the first other code', () => {
    expect(restarted).toMatchObject({ code: 3, starts: 3 });
  });

  test.each(exitCodes)('ends with exit code %i without starting it again', (exitCode) => {
    expect(stopped.get(exitCode)).toMatchObject({ code: exitCode, starts: 1 });
  });

  test('reports each start with the child’s process id', () => {
    expect(restartedThenClean.code).toBe(0);
    expect(
      restartedThenClean.logLines.filter((line) =>
        /^Started the host \(process \d+\)\.$/.test(line),
      ),
    ).toHaveLength(2);
  });

  test('starts nothing, and ends with exit code 1, when `prepare` names a problem', () => {
    expect(refused).toMatchObject({ code: 1, starts: 0, errorLines: ['not ready'] });
  });

  test('checks `prepare` before each start, so a build that went missing stops a restart', () => {
    expect(buildWentMissing).toMatchObject({ code: 1, starts: 1, errorLines: ['gone'] });
  });

  test.each([
    ['a restart racing the signal', racingRestart],
    ['a clean stop', cleanStop],
    ['a child no handler stopped', unhandled],
  ])(
    'forwards SIGTERM to the child and ends with 0 for %s, without starting it again',
    (_name, outcome) => {
      expect(outcome).toEqual({ code: 0, starts: 1, listeners: 0 });
    },
  );

  test('ends with the child’s own code when a stop signal reaches a child that exits with an error', () => {
    expect(failingStop).toMatchObject({ code: 9, starts: 1 });
  });
});

describe('hostCommand', () => {
  test('serve runs the production entry, and dev runs the development entry under --watch', () => {
    expect(hostCommand('serve')).toEqual([
      process.execPath,
      '--no-install',
      join(import.meta.dir, 'serve.ts'),
    ]);
    expect(hostCommand('dev')).toEqual([
      process.execPath,
      '--no-install',
      '--watch',
      join(import.meta.dir, 'dev.ts'),
    ]);
    expect(hostCommand('dev', '/elsewhere/entry.ts')).toEqual([
      process.execPath,
      '--no-install',
      '--watch',
      '/elsewhere/entry.ts',
    ]);
  });

  test('dev passes each plugin folder to the entry as --plugin, after the script, and serve takes none', () => {
    expect(hostCommand('dev', undefined, ['/one', '/two'])).toEqual([
      process.execPath,
      '--no-install',
      '--watch',
      join(import.meta.dir, 'dev.ts'),
      '--plugin',
      '/one',
      '--plugin',
      '/two',
    ]);
    expect(hostCommand('serve', undefined, ['/one'])).toEqual([
      process.execPath,
      '--no-install',
      join(import.meta.dir, 'serve.ts'),
    ]);
  });
});

describe('the supervisor command', () => {
  test('`serve` without build/index.html exits 1, starts nothing, and names `bun run build`', () => {
    expect(missingBuild.exitCode).toBe(1);
    expect(missingBuild.stderr.toString()).toContain('bun run build');
    expect(missingBuild.stderr.toString()).toContain(join(emptyBuild, 'index.html'));
    expect(missingBuild.stdout.toString()).not.toContain('Started the host');
  });

  test.each([
    [[]],
    [['serve', 'extra']],
    [['nonsense']],
    [['dev', '--entry']],
    [['dev', '--plugin']],
    [['dev', '--plugin', '']],
    [['serve', '--plugin', '/somewhere']],
    [['dev', '--entry', '/a', '--entry', '/b']],
  ])('refuses the arguments %j with a usage line and exit code 2', (argumentsList) => {
    const result = badArguments.get(JSON.stringify(argumentsList));
    expect(result?.exitCode).toBe(2);
    expect(result?.stderr.toString()).toContain('Usage: bun src/host/supervisor.ts');
  });
});
