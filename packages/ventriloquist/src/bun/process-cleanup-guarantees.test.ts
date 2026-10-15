import { describe, expect, test } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing';

import { createDeferred } from '../session/fixtures/deferred.ts';
import { flush, utf8 } from '../session/session.test-support.ts';
import {
  hostFor,
  registerSessionCleanup,
  runHosted,
  trackHostedProcess,
} from './bun-process.test-support.ts';
import { shellProfile } from './fixtures/bun-pipe-stdin.ts';
import type { OutputMode } from './fixtures/terminal-output.ts';
import { createPipeProcess } from './pipe-process.ts';
import type { ProcessStartFailure } from './process-start-failure.ts';
import type { ProcessExit, SpawnedProcess, SpawnProcess } from './process-types.ts';
import { createPtyProcess } from './pty-process.ts';

registerSessionCleanup();

const MODES: OutputMode[] = ['pipe', 'pty'];
const PTY_DIMENSIONS = { columns: 80, rows: 24 };

/** Wait for `condition`, failing after about five seconds; a condition is a state, never a guess at timing. */
async function eventually(condition: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 1000 && !condition(); attempt += 1) await Bun.sleep(5);
  return condition();
}

/** A spawn that starts the real process and lets a test hand back a variation of it. */
function spawnWith(
  alter: (child: ReturnType<typeof Bun.spawn>, options: Record<string, unknown>) => SpawnedProcess,
): SpawnProcess {
  return (command, options) => alter(Bun.spawn(command, options as never), options);
}

/** A process that reports through the real one but takes the parts a test replaces. */
function derive(
  child: ReturnType<typeof Bun.spawn>,
  replaced: Partial<SpawnedProcess>,
): SpawnedProcess {
  return {
    pid: child.pid,
    exited: child.exited,
    get signalCode() {
      return child.signalCode;
    },
    kill: (signal) => child.kill(signal as NodeJS.Signals | number | undefined),
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    terminal: child.terminal,
    stdio: child.stdio,
    ...replaced,
  };
}

describe('a pipe process releases the pipes it reads', () => {
  test('when its output ends on its own', async () => {
    let captured: ReturnType<typeof Bun.spawn> | undefined;
    const hosted = trackHostedProcess(
      createPipeProcess({
        profile: shellProfile('printf done'),
        spawn: spawnWith((child) => {
          captured = child;
          return derive(child, {});
        }),
      }),
    );
    await hosted.backend.start();
    const stdout = captured?.stdout as ReadableStream<Uint8Array>;
    const stderr = captured?.stderr as ReadableStream<Uint8Array>;
    expect(await eventually(() => !stdout.locked && !stderr.locked)).toBe(true);
  });

  test('when cleanup ends it', async () => {
    let captured: ReturnType<typeof Bun.spawn> | undefined;
    const hosted = trackHostedProcess(
      createPipeProcess({
        profile: shellProfile('sleep 7919'),
        terminationGraceMilliseconds: 100,
        spawn: spawnWith((child) => {
          captured = child;
          return derive(child, {});
        }),
      }),
    );
    await hosted.backend.start();
    const stdout = captured?.stdout as ReadableStream<Uint8Array>;
    const stderr = captured?.stderr as ReadableStream<Uint8Array>;
    expect(await hosted.backend.cleanup()).toBe('complete');
    expect([stdout.locked, stderr.locked]).toEqual([false, false]);
    expect(await hosted.backend.cleanup()).toBe('complete');
  });
});

describe('a pipe process whose stdin cannot be closed', () => {
  test('is still signaled, so the cleanup deadline can never be spent waiting on its input', async () => {
    const stuck = createDeferred<number>();
    let captured: ReturnType<typeof Bun.spawn> | undefined;
    const hosted = trackHostedProcess(
      createPipeProcess({
        profile: shellProfile('sleep 7919'),
        acceptsInput: true,
        terminationGraceMilliseconds: 100,
        spawn: spawnWith((child) => {
          captured = child;
          return derive(child, {
            stdin: { write: () => 0, flush: () => 0, end: () => stuck.promise },
          });
        }),
      }),
    );
    await hosted.backend.start();
    const cleanup = hosted.backend.cleanup();
    try {
      const outcome = await Promise.race([
        captured?.exited.then(() => 'ended'),
        Bun.sleep(5000).then(() => 'still running'),
      ]);
      expect(outcome).toBe('ended');
    } finally {
      stuck.resolve(0);
      captured?.kill('SIGKILL');
    }
    expect(await cleanup).toBe('complete');
  });
});

/** A terminal stand-in the test drives: it records what is written and reports the buffer flushed on command. */
function drivenTerminal() {
  const writes: Uint8Array[] = [];
  let callbacks: { drain(terminal: unknown): void } | undefined;
  const spawn = spawnWith((child, spawnOptions) => {
    callbacks = spawnOptions['terminal'] as { drain(terminal: unknown): void };
    const real = child.terminal as { close(): void };
    return derive(child, {
      terminal: {
        write: (bytes: Uint8Array) => {
          writes.push(bytes);
          return bytes.length;
        },
        resize: () => undefined,
        close: () => real.close(),
      },
    });
  });
  return { spawn, writes, drain: () => callbacks?.drain(undefined) };
}

describe('PTY input', () => {
  test('a write stays unsettled until the terminal reports its buffer flushed', async () => {
    const { spawn, writes, drain } = drivenTerminal();
    const hosted = trackHostedProcess(
      createPtyProcess({
        profile: shellProfile('sleep 7919'),
        dimensions: PTY_DIMENSIONS,
        terminationGraceMilliseconds: 100,
        spawn,
      }),
    );
    await hosted.backend.start();
    const settled: string[] = [];
    const first = hosted.backend.write(utf8('one')).then(() => settled.push('one'));
    const second = hosted.backend.write(utf8('two')).then(() => settled.push('two'));
    await flush();
    expect(writes).toHaveLength(2);
    expect(settled).toEqual([]);
    drain();
    await Promise.all([first, second]);
    expect(settled).toEqual(['one', 'two']);
    const third = hosted.backend.write(utf8('three')).then(() => settled.push('three'));
    await flush();
    expect(settled).toEqual(['one', 'two']);
    drain();
    await third;
  });

  test('the session input budget keeps counting bytes the terminal has not flushed', async () => {
    const { spawn, writes, drain } = drivenTerminal();
    const hosted = hostFor('pty', shellProfile('sleep 7919'), { spawn });
    const run = runHosted(hosted, { budgets: { inputQueueBytes: 8 } });
    await run.started;
    expect(run.attachment.write(utf8('12345678'))).toMatchObject({ disposition: 'accepted' });
    await flush();
    expect(writes).toHaveLength(1);
    expect(run.attachment.write(utf8('9'))).toMatchObject({
      disposition: 'failed',
      reason: 'input-overflow',
    });
    drain();
    await flush();
    expect(run.attachment.write(utf8('9'))).toMatchObject({ disposition: 'accepted' });
    await flush();
    // Closing the session with that write unflushed leaves it neither done nor failed.
    await run.session.dispose();
    expect(run.recorder.ofType('operationResult')).toMatchObject([
      { disposition: 'unknown', reason: 'closed-before-acknowledgement' },
    ]);
  });
});

describe.each(MODES)('a %s process whose unread output overflows', (mode) => {
  test('is ended even though nothing is attached to read it', async () => {
    const hosted = trackHostedProcess(
      hostFor(mode, shellProfile('yes'), { maximumBufferedOutputBytes: 1 }),
    );
    const exit = createDeferred<ProcessExit>();
    void hosted.reportExitTo({
      start: () => hosted.backend.start(),
      reportProcessExit: (exitCode, signal) => {
        exit.resolve({ exitCode, signal });
        return true;
      },
    });
    const outcome = await Promise.race([
      exit.promise,
      Bun.sleep(5000).then(() => 'still running' as const),
    ]);
    // However it ended, by the signal or by the pipe closing under it, it ended on its own account.
    expect(outcome).not.toBe('still running');
  });
});

describe('a PTY that Bun returned without the release channel', () => {
  test('is reaped before the start fails as unsupported-runtime, and its command never ran', async () => {
    let captured: ReturnType<typeof Bun.spawn> | undefined;
    const hosted = trackHostedProcess(
      createPtyProcess({
        profile: shellProfile('sleep 7919'),
        dimensions: PTY_DIMENSIONS,
        terminationGraceMilliseconds: 100,
        spawn: spawnWith((child) => {
          captured = child;
          return derive(child, { stdio: undefined });
        }),
      }),
    );
    const error = await rejectionOf(hosted.backend.start());
    expect((error as ProcessStartFailure).code).toBe('unsupported-runtime');
    expect(hosted.startFailure?.code).toBe('unsupported-runtime');
    expect(captured?.exitCode !== null || captured?.signalCode !== null).toBe(true);
    expect(await hosted.backend.cleanup()).toBe('complete');
  });
});

describe('a PTY that Bun returned without a terminal', () => {
  test('is reaped before the start failure is reported, and is not left to cleanup to discover', async () => {
    const reaped = createDeferred<void>();
    let captured: ReturnType<typeof Bun.spawn> | undefined;
    const hosted = trackHostedProcess(
      createPtyProcess({
        profile: shellProfile('sleep 7919'),
        dimensions: PTY_DIMENSIONS,
        terminationGraceMilliseconds: 100,
        spawn: spawnWith((child) => {
          captured = child;
          // Holds the exit back, as a child that is slow to die would.
          return derive(child, {
            exited: reaped.promise.then(() => child.exited),
            terminal: undefined,
          });
        }),
      }),
    );
    let reported = false;
    const failure = rejectionOf(hosted.backend.start()).then((error) => {
      reported = true;
      return error as ProcessStartFailure;
    });
    try {
      await Bun.sleep(100);
      expect(reported).toBe(false);
      reaped.resolve();
      const startFailure = await failure;
      expect(startFailure.code).toBe('unsupported-runtime');
      expect(hosted.startFailure?.code).toBe('unsupported-runtime');
      expect(captured?.exitCode !== null || captured?.signalCode !== null).toBe(true);
      expect(await hosted.backend.cleanup()).toBe('complete');
    } finally {
      reaped.resolve();
      captured?.kill('SIGKILL');
      (captured?.terminal as { close(): void } | undefined)?.close();
    }
  });
});
