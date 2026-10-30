/**
 * The supervisor restarts the host on exit code 75 and stops on every other code, forwards the
 * stop signals, and refuses `start` without a build. The host's own restart is in
 * `supervisor.slow.test.ts`; these run the real supervisor around a stand-in child.
 */
import { runWithHangGuard } from '@lostgradient/testing/hang-guard';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hostCommand, supervise, type SupervisorSignals } from './supervisor.ts';

const fixture = join(import.meta.dir, 'supervisor-fixture.test-support.ts');
const supervisorEntry = join(import.meta.dir, 'supervisor.ts');
const packageDirectory = join(import.meta.dir, '..', '..');

const directories: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-supervisor-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const starts = (log: string): number => readFileSync(log, 'utf8').trim().split('\n').length;

const silent = { log: () => undefined, error: () => undefined };

describe('supervise', () => {
  test('starts the host again on exit code 75 and ends with the first other code', async () => {
    const log = join(await scratch(), 'starts.log');
    const code = await supervise({
      command: [process.execPath, '--no-install', fixture, log, 'exit', '75', '75', '3'],
      ...silent,
    });
    expect(code).toBe(3);
    expect(starts(log)).toBe(3);
  });

  test.each([0, 1, 2, 74, 76, 137])(
    'ends with exit code %i without starting it again',
    async (exitCode) => {
      const log = join(await scratch(), 'starts.log');
      const code = await supervise({
        command: [process.execPath, '--no-install', fixture, log, 'exit', String(exitCode)],
        ...silent,
      });
      expect(code).toBe(exitCode);
      expect(starts(log)).toBe(1);
    },
  );

  test('reports each start with the child’s process id', async () => {
    const log = join(await scratch(), 'starts.log');
    const lines: string[] = [];
    await supervise({
      command: [process.execPath, '--no-install', fixture, log, 'exit', '75', '0'],
      log: (message) => lines.push(message),
      error: () => undefined,
    });
    expect(lines.filter((line) => /^Started the host \(process \d+\)\.$/.test(line))).toHaveLength(
      2,
    );
  });

  test('starts nothing, and ends with exit code 1, when `prepare` names a problem', async () => {
    const log = join(await scratch(), 'starts.log');
    const errors: string[] = [];
    const code = await supervise({
      command: [process.execPath, '--no-install', fixture, log, 'exit', '0'],
      prepare: () => 'not ready',
      log: () => undefined,
      error: (message) => errors.push(message),
    });
    expect({ code, errors, started: existsSync(log) }).toEqual({
      code: 1,
      errors: ['not ready'],
      started: false,
    });
  });

  test('checks `prepare` before each start, so a build that went missing stops a restart', async () => {
    const log = join(await scratch(), 'starts.log');
    let checks = 0;
    const code = await supervise({
      command: [process.execPath, '--no-install', fixture, log, 'exit', '75', '75'],
      prepare: () => (++checks > 1 ? 'gone' : undefined),
      ...silent,
    });
    expect({ code, started: starts(log) }).toEqual({ code: 1, started: 1 });
  });

  test.each([
    ['a restart racing the signal', '75'],
    ['a clean stop', '0'],
    ['a child no handler stopped', 'unhandled'],
  ])(
    'forwards SIGTERM to the child and ends with 0 for %s, without starting it again',
    async (_name, behavior) => {
      const directory = await scratch();
      const log = join(directory, 'starts.log');
      const ready = join(directory, 'ready');
      const signals: SupervisorSignals & EventEmitter = new EventEmitter();
      const running = supervise({
        command: [process.execPath, '--no-install', fixture, log, 'wait', ready, behavior],
        signals,
        ...silent,
      });
      await waitUntil(() => existsSync(ready), {
        message: 'the child to install its handler',
        yieldTurn: () => Bun.sleep(25),
      });
      signals.emit('SIGTERM');
      expect(await running).toBe(0);
      expect(starts(log)).toBe(1);
      expect(signals.listenerCount('SIGTERM') + signals.listenerCount('SIGINT')).toBe(0);
    },
  );

  test('ends with the child’s own code when a stop signal reaches a child that exits with an error', async () => {
    const directory = await scratch();
    const log = join(directory, 'starts.log');
    const ready = join(directory, 'ready');
    const signals: SupervisorSignals & EventEmitter = new EventEmitter();
    const running = supervise({
      command: [process.execPath, '--no-install', fixture, log, 'wait', ready, '9'],
      signals,
      ...silent,
    });
    await waitUntil(() => existsSync(ready), {
      message: 'the child to install its handler',
      yieldTurn: () => Bun.sleep(25),
    });
    signals.emit('SIGINT');
    expect(await running).toBe(9);
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
});

describe('the supervisor command', () => {
  async function run(argumentsList: string[], environment: Record<string, string>) {
    return runWithHangGuard([process.execPath, supervisorEntry, ...argumentsList], {
      cwd: packageDirectory,
      env: { ...process.env, ...environment },
    });
  }

  test('`serve` without build/index.html exits 1, starts nothing, and names `bun run build`', async () => {
    const empty = await scratch();
    const result = await run(['serve'], { INTERBOROUGH_BUILD_DIRECTORY: empty });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('bun run build');
    expect(result.stderr.toString()).toContain(join(empty, 'index.html'));
    expect(result.stdout.toString()).not.toContain('Started the host');
  });

  test.each([[[]], [['serve', 'extra']], [['nonsense']], [['dev', '--entry']]])(
    'refuses the arguments %j with a usage line and exit code 2',
    async (argumentsList) => {
      const result = await run(argumentsList, {});
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain('Usage: bun src/host/supervisor.ts');
    },
  );
});
