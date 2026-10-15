import { describe, expect, test } from 'bun:test';

import { rejectionOf, SCENARIO_HANG_GUARD_MILLISECONDS } from '@lostgradient/testing';

import { createDeferred } from '../session/fixtures/deferred.ts';
import type { ByteReader } from '../session/session-types.ts';
import { flush } from '../session/session.test-support.ts';
import { OutputOverflowError } from './bounded-byte-feed.ts';
import {
  bytesOnChannel,
  hostFor,
  runHosted,
  scenarioTest,
  settleScenarios,
  textOf,
  trackHostedProcess,
} from './bun-process.test-support.ts';
import { PIPE_STDIN_FIXTURES, shellProfile } from './fixtures/bun-pipe-stdin.ts';
import { PTY_FIXTURES } from './fixtures/bun-pty.ts';
import { createPipeProcess } from './pipe-process.ts';
import { ProcessStartFailure } from './process-start-failure.ts';
import type { HostedProcess, SpawnedProcess, SpawnProcess } from './process-types.ts';
import { createPtyProcess } from './pty-process.ts';

/** The reader the session would take on one of the process's output sources. */
function readerOf(hosted: HostedProcess, index = 0): ByteReader {
  const source = hosted.sources[index];
  if (source?.kind !== 'stream') throw new Error('expected a stream source');
  return source.stream.getReader();
}

const PIPE_OPTIONS = { profile: shellProfile('true') };
const PTY_OPTIONS = { profile: shellProfile('true'), dimensions: { columns: 80, rows: 24 } };

/** A spawn that records the call and then spawns for real, letting a test alter the process it returns. */
function recordingSpawn(
  alter: (child: SpawnedProcess, options: Record<string, unknown>) => SpawnedProcess = (child) =>
    child,
) {
  const calls: { command: string[]; options: Record<string, unknown> }[] = [];
  const spawn: SpawnProcess = (command, options) => {
    calls.push({ command, options });
    return alter(
      Bun.spawn(command, { ...(options as object), timeout: SCENARIO_HANG_GUARD_MILLISECONDS }),
      options,
    );
  };
  return { spawn, calls };
}

const spawnSpy = (() => {
  const calls: unknown[] = [];
  return {
    calls,
    options: {
      spawn: ((command: string[]) => {
        calls.push(command);
        throw new Error('must not be called');
      }) as SpawnProcess,
    },
  };
})();

describe('refusing a process before it exists', () => {
  // spawn-free: construction validates the profile and throws before any spawn; the backend is never started.
  test('a malformed profile is a caller error, not a start failure', () => {
    const profile = { ...shellProfile('true'), workingDirectory: 'relative' };
    expect(() => createPipeProcess({ profile })).toThrow(TypeError);
    expect(() => createPtyProcess({ ...PTY_OPTIONS, profile })).toThrow(TypeError);
  });

  // spawn-free: construction validates the geometry and throws before any spawn; the backend is never started.
  test('geometry a PTY cannot start from is refused', () => {
    expect(() =>
      createPtyProcess({ ...PTY_OPTIONS, dimensions: { columns: 0, rows: 24 } }),
    ).toThrow(RangeError);
  });

  // spawn-free: construction validates the setting and throws before any spawn; nothing is started.
  test.each([
    ['terminationGraceMilliseconds', 0],
    ['terminationGraceMilliseconds', 30_001],
    ['observationWindowMilliseconds', 249],
    ['observationWindowMilliseconds', 30_001],
    ['maximumBufferedOutputBytes', 0],
    ['maximumBufferedOutputBytes', 1.5],
  ])('%s of %j is outside its range', (name, value) => {
    expect(() => createPipeProcess({ ...PIPE_OPTIONS, [name]: value })).toThrow(RangeError);
  });

  scenarioTest('nothing is spawned until the session starts the backend', async () => {
    const { spawn, calls } = recordingSpawn();
    const pipe = trackHostedProcess(createPipeProcess({ ...PIPE_OPTIONS, spawn }));
    const pty = trackHostedProcess(createPtyProcess({ ...PTY_OPTIONS, spawn }));
    expect(calls).toEqual([]);
    await pipe.backend.start();
    await pty.backend.start();
    expect(calls).toHaveLength(2);
    expect(pipe.startFailure).toBeUndefined();
  });

  scenarioTest(
    'a profile is spawned as given: no shell, no inherited environment, its own working directory',
    async () => {
      const { spawn, calls } = recordingSpawn();
      const profile = {
        ...shellProfile('true'),
        workingDirectory: '/tmp',
        environment: { ONLY: '1' },
      };
      const hosted = trackHostedProcess(createPipeProcess({ profile, spawn }));
      await hosted.backend.start();
      expect(calls[0]?.command).toEqual(['sh', '-c', 'true', 'sh']);
      expect(calls[0]?.options).toMatchObject({ cwd: '/tmp', env: { ONLY: '1' }, detached: true });
    },
  );
});

describe('an unsupported runtime', () => {
  const windows = { platform: 'win32', architecture: 'x64' };

  test.each([
    ['pipe', () => createPipeProcess({ ...PIPE_OPTIONS, host: windows, ...spawnSpy.options })],
    ['pty', () => createPtyProcess({ ...PTY_OPTIONS, host: windows, ...spawnSpy.options })],
  ])(
    'rejects a %s with unsupported-runtime, spawns nothing and falls back to nothing',
    async (_mode, create) => {
      spawnSpy.calls.length = 0;
      const hosted = create();
      const failure = await rejectionOf(hosted.backend.start());
      expect(failure).toBeInstanceOf(ProcessStartFailure);
      expect((failure as ProcessStartFailure).code).toBe('unsupported-runtime');
      expect((failure as ProcessStartFailure).message).toContain('win32/x64');
      expect(hosted.startFailure).toBe(failure as ProcessStartFailure);
      expect(spawnSpy.calls).toEqual([]);
      expect(await hosted.backend.cleanup()).toBe('complete');
    },
  );

  scenarioTest(
    'a Bun that returns no terminal is ended and reported, and never becomes a pipe',
    async () => {
      const killed: unknown[] = [];
      const { spawn, calls } = recordingSpawn((child) => ({
        pid: child.pid,
        exited: child.exited,
        signalCode: child.signalCode,
        kill: (signal) => {
          killed.push(signal);
          child.kill(signal);
        },
      }));
      const hosted = trackHostedProcess(createPtyProcess({ ...PTY_OPTIONS, spawn }));
      const failure = await rejectionOf(hosted.backend.start());
      expect((failure as ProcessStartFailure).code).toBe('unsupported-runtime');
      expect(killed).toEqual(['SIGKILL']);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.options).toHaveProperty('terminal');
      expect(calls[0]?.options).not.toHaveProperty('stdout');
    },
  );
});

describe('using a process before it is open, or after it is released', () => {
  scenarioTest('a pipe refuses input it has no channel for', async () => {
    const hosted = trackHostedProcess(createPipeProcess({ profile: shellProfile('sleep 7919') }));
    expect(
      ((await rejectionOf(hosted.backend.write(Uint8Array.of(1)))) as Error).message,
    ).toContain('no open input');
    await hosted.backend.start();
    expect(
      ((await rejectionOf(hosted.backend.write(Uint8Array.of(1)))) as Error).message,
    ).toContain('no open input');
  });

  scenarioTest('a pipe refuses input once it has been cleaned up', async () => {
    const hosted = trackHostedProcess(
      createPipeProcess({
        profile: shellProfile('sleep 7919'),
        acceptsInput: true,
        terminationGraceMilliseconds: 100,
      }),
    );
    await hosted.backend.start();
    await hosted.backend.write(Uint8Array.of(10));
    expect(await hosted.backend.cleanup()).toBe('complete');
    expect(
      ((await rejectionOf(hosted.backend.write(Uint8Array.of(1)))) as Error).message,
    ).toContain('no open input');
  });

  scenarioTest(
    'a PTY refuses input and a resize before it starts and after it is cleaned up',
    async () => {
      const hosted = trackHostedProcess(
        createPtyProcess({
          ...PTY_OPTIONS,
          profile: shellProfile('sleep 7919'),
          terminationGraceMilliseconds: 100,
        }),
      );
      for (let round = 0; round < 2; round += 1) {
        expect(
          ((await rejectionOf(hosted.backend.write(Uint8Array.of(1)))) as Error).message,
        ).toContain('no open terminal');
        expect(((await rejectionOf(hosted.backend.resize?.(80, 24))) as Error).message).toContain(
          'no open terminal',
        );
        if (round === 0) {
          await hosted.backend.start();
          expect(await hosted.backend.cleanup()).toBe('complete');
        }
      }
    },
  );
});

describe('cleanup that cannot finish every step', () => {
  scenarioTest(
    'a pipe whose input cannot be closed is incomplete, though its process is ended',
    async () => {
      const { spawn } = recordingSpawn((child) => ({
        pid: child.pid,
        exited: child.exited,
        get signalCode() {
          return child.signalCode;
        },
        kill: (signal) => child.kill(signal),
        stdin: {
          write: () => 0,
          flush: () => 0,
          end: () => Promise.reject(new Error('end failed')),
        },
        stdout: child.stdout,
        stderr: child.stderr,
      }));
      const hosted = trackHostedProcess(
        createPipeProcess({
          profile: shellProfile('sleep 7919'),
          acceptsInput: true,
          terminationGraceMilliseconds: 100,
          spawn,
        }),
      );
      await hosted.backend.start();
      expect(await hosted.backend.cleanup()).toBe('incomplete');
    },
  );

  scenarioTest('a pipe whose output cannot be released is incomplete', async () => {
    const unreleasable = (stream: unknown) => ({
      getReader: () => {
        const reader = (stream as ReadableStream<Uint8Array>).getReader();
        return {
          // A read that never ends, so the pump cannot finish on its own and release the pipe.
          read: () => new Promise<never>(() => undefined),
          cancel: () => Promise.reject(new Error('cancel failed')),
          releaseLock: () => reader.releaseLock(),
        };
      },
    });
    const { spawn } = recordingSpawn((child) => ({
      pid: child.pid,
      exited: child.exited,
      get signalCode() {
        return child.signalCode;
      },
      kill: (signal) => child.kill(signal),
      stdout: unreleasable(child.stdout),
      stderr: child.stderr,
    }));
    const hosted = trackHostedProcess(
      createPipeProcess({
        profile: shellProfile('sleep 7919'),
        terminationGraceMilliseconds: 100,
        spawn,
      }),
    );
    await hosted.backend.start();
    expect(((await rejectionOf(readerOf(hosted).cancel?.())) as Error).message).toBe(
      'cancel failed',
    );
    expect(await hosted.backend.cleanup()).toBe('incomplete');
  });

  scenarioTest(
    'a PTY whose terminal cannot be closed is incomplete, though its process is ended',
    async () => {
      const { spawn } = recordingSpawn((child) => {
        const terminal = child.terminal as { close(): void };
        return {
          pid: child.pid,
          exited: child.exited,
          get signalCode() {
            return child.signalCode;
          },
          kill: (signal) => child.kill(signal),
          stdio: child.stdio,
          terminal: {
            write: () => 0,
            resize: () => undefined,
            close: () => {
              terminal.close();
              throw new Error('close failed');
            },
          },
        };
      });
      const hosted = trackHostedProcess(
        createPtyProcess({
          ...PTY_OPTIONS,
          profile: shellProfile('sleep 7919'),
          terminationGraceMilliseconds: 100,
          spawn,
        }),
      );
      await hosted.backend.start();
      expect(await hosted.backend.cleanup()).toBe('incomplete');
    },
  );
});

describe('a pipe that fails while it is read', () => {
  scenarioTest(
    'fails that output source with the error, leaving the other channel and the process alone',
    async () => {
      const failure = new Error('read failed');
      const { spawn } = recordingSpawn((child) => ({
        pid: child.pid,
        exited: child.exited,
        get signalCode() {
          return child.signalCode;
        },
        kill: (signal) => child.kill(signal),
        stdout: {
          getReader: () => ({
            read: () => Promise.reject(failure),
            cancel: () => Promise.resolve(),
            releaseLock: () => undefined,
          }),
        },
        stderr: child.stderr,
      }));
      const hosted = trackHostedProcess(
        createPipeProcess({
          profile: shellProfile('sleep 7919'),
          terminationGraceMilliseconds: 100,
          spawn,
        }),
      );
      await hosted.backend.start();
      expect(await rejectionOf(readerOf(hosted).read())).toBe(failure);
    },
  );
});

describe('output the consumer has not read', () => {
  for (const [mode, create] of [
    [
      'pipe',
      () =>
        createPipeProcess({
          profile: shellProfile("printf 'abcdefghij'"),
          maximumBufferedOutputBytes: 4,
        }),
    ],
    [
      'pty',
      () =>
        createPtyProcess({
          ...PTY_OPTIONS,
          profile: shellProfile("printf 'abcdefghij'"),
          maximumBufferedOutputBytes: 4,
        }),
    ],
  ] as const) {
    scenarioTest(
      `past the bound fails the ${mode} source visibly instead of dropping it silently`,
      async () => {
        const hosted = trackHostedProcess(create());
        await hosted.backend.start();
        await hosted.reportExitTo({
          start: () => Promise.resolve(),
          reportProcessExit: () => true,
        });
        await flush();
        expect(await rejectionOf(readerOf(hosted).read())).toBeInstanceOf(OutputOverflowError);
      },
    );
  }
});

describe('the end of the terminal stream', () => {
  scenarioTest(
    'a terminal that closes with an error status fails the output source, not the process',
    async () => {
      const { spawn, calls } = recordingSpawn();
      const run = runHosted(
        trackHostedProcess(
          createPtyProcess({
            ...PTY_OPTIONS,
            profile: shellProfile('sleep 7919'),
            terminationGraceMilliseconds: 100,
            spawn,
          }),
        ),
      );
      await run.started;
      const terminal = calls[0]?.options['terminal'] as {
        exit(terminal: unknown, status: number): void;
      };
      const closed = createDeferred();
      void run.session.closed.then(() => closed.resolve());
      terminal.exit(undefined, 1);
      await closed.promise;
      const summary = await run.session.closed;
      expect(summary.cause).toBe('source-failed');
      expect(run.recorder.ofType('sourceComplete')).toEqual([]);
    },
  );
});

describe('writing input and reading it back', () => {
  scenarioTest(
    'input reaches the process exactly as written, with nothing added or echoed by the pipe',
    async () => {
      const fixture = PIPE_STDIN_FIXTURES.untilEndOfInput;
      const hosted = hostFor('pipe', fixture.profile, { acceptsInput: true });
      const run = runHosted(hosted);
      await run.waitForOutput('stdout', fixture.ready);
      run.attachment.write(new TextEncoder().encode(fixture.input));
      await flush();
      expect(textOf(bytesOnChannel(run.recorder, 'stdout'))).toBe('ready.');
      run.attachment.stop();
      await run.session.closed;
    },
  );

  scenarioTest('a PTY is a terminal and a pipe is not', async () => {
    const pty = runHosted(hostFor('pty', PTY_FIXTURES.terminalProbe.profile));
    await pty.session.closed;
    expect(textOf(bytesOnChannel(pty.recorder, 'pty'))).toBe(PTY_FIXTURES.terminalProbe.output);
    const pipe = runHosted(hostFor('pipe', PIPE_STDIN_FIXTURES.terminalProbe.profile));
    await pipe.session.closed;
    expect(textOf(bytesOnChannel(pipe.recorder, 'stdout'))).toBe('notty');
  });
});

await settleScenarios();
