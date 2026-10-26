import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';

import { rejectionOf } from '@lostgradient/testing';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';

import { awakeTurns } from '@lostgradient/testing/wait-until';
import { trackRealTimers } from '../conformance/conformance.test-support.ts';
import type { ByteReader } from '../session/session-types.ts';
import { flush } from '../session/session.test-support.ts';
import {
  bytesOnChannel,
  hostFor,
  runHosted,
  scenario,
  scenarioResult,
  settleScenarios,
  textOf,
  trackHostedProcess,
} from './bun-process.test-support.ts';
import { PIPE_STDIN_FIXTURES, shellProfile } from './fixtures/bun-pipe-stdin.ts';
import { PTY_FIXTURES } from './fixtures/bun-pty.ts';
import { loadPipeDevice, type PipeDevice } from './pipe-device.ts';
import { createPipeProcess } from './pipe-process.ts';
import { ProcessStartFailure } from './process-start-failure.ts';
import type { HostedProcess, SpawnedProcess, SpawnProcess } from './process-types.ts';
import { loadPtyDevice, type PtyDevice, type PtyPair } from './pty-device.ts';
import type { MasterMessage } from './pty-master-loop.ts';
import type { MasterWorker } from './pty-master.ts';
import { createPtyProcess } from './pty-process.ts';

/** The reader the session would take on one of the process's output sources. */
function readerOf(hosted: HostedProcess, index = 0): ByteReader {
  const source = hosted.sources[index];
  if (source?.kind !== 'stream') throw new Error('expected a stream source');
  return source.stream.getReader();
}

const PIPE_OPTIONS = { profile: shellProfile('true') };
const PTY_OPTIONS = { profile: shellProfile('true'), dimensions: { columns: 80, rows: 24 } };

/** A profile and dimensions the test owns, mutated in every field once the process exists. */
function mutable() {
  const profile = {
    executable: 'sh',
    argumentList: ['-c', 'true', 'sh'],
    workingDirectory: '/tmp',
    environment: { PATH: '/usr/bin:/bin', KEPT: '1' } as Record<string, string>,
  };
  const dimensions = { columns: 90, rows: 33 };
  const mutate = () => {
    profile.executable = '/nonexistent/changed';
    profile.argumentList[1] = 'exit 9';
    profile.argumentList.push('extra');
    profile.workingDirectory = '/nonexistent';
    profile.environment['KEPT'] = '2';
    profile.environment['ADDED'] = '1';
    dimensions.columns = 1;
    dimensions.rows = 1;
  };
  return { profile, dimensions, mutate };
}

const mustNotLoad = () => {
  throw new Error('must not be loaded');
};

const refuse = (message: string) => () => {
  throw new Error(message);
};

/** A spawn that records the call and then spawns for real, letting a test alter the process it returns. */
function recordingSpawn(
  alter: (child: SpawnedProcess, options: Record<string, unknown>) => SpawnedProcess = (child) =>
    child,
) {
  const calls: { command: string[]; options: Record<string, unknown> }[] = [];
  const spawn: SpawnProcess = (command, options) => {
    calls.push({ command, options });
    return alter(spawnWithHangGuard(command, { ...(options as object) }), options);
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

/** The real device, recording what the host asked of it, with a hook to make single calls fail. */
function recordingDevice(overrides: Partial<PtyDevice> = {}) {
  const real = loadPtyDevice();
  const opened: PtyPair[] = [];
  const closed: number[] = [];
  const sizes: [number, number][] = [];
  const device: PtyDevice = {
    open: () => {
      const pair = real.open();
      opened.push(pair);
      return pair;
    },
    openSlave: (path) => real.openSlave(path),
    setWindowSize: (pair, columns, rows) => {
      sizes.push([columns, rows]);
      real.setWindowSize(pair, columns, rows);
    },
    close: (descriptor) => {
      closed.push(descriptor);
      real.close(descriptor);
    },
    ...overrides,
  };
  return { loadDevice: () => device, device, opened, closed, sizes };
}

const scenario1 = scenario('nothing is spawned until the session starts the backend', async () => {
  const { spawn, calls } = recordingSpawn();
  const pipe = trackHostedProcess(createPipeProcess({ ...PIPE_OPTIONS, spawn }));
  const pty = trackHostedProcess(createPtyProcess({ ...PTY_OPTIONS, spawn }));
  expect(calls).toEqual([]);
  await pipe.backend.start();
  await pty.backend.start();
  expect(calls).toHaveLength(2);
  expect(pipe.startFailure).toBeUndefined();
});

const scenario2 = scenario(
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
  ])('%s of %j is outside its range', (name, value) => {
    expect(() => createPipeProcess({ ...PIPE_OPTIONS, [name]: value })).toThrow(RangeError);
  });

  scenarioResult('nothing is spawned until the session starts the backend', scenario1);

  scenarioResult(
    'a profile is spawned as given: no shell, no inherited environment, its own working directory',
    scenario2,
  );
});

const scenario3 = scenario('a pipe runs the command that was validated', async () => {
  const { profile, mutate } = mutable();
  const { spawn, calls } = recordingSpawn();
  const hosted = trackHostedProcess(createPipeProcess({ profile, spawn }));
  mutate();
  await hosted.backend.start();
  expect(calls[0]?.command).toEqual(['sh', '-c', 'true', 'sh']);
  expect(calls[0]?.options).toMatchObject({
    cwd: '/tmp',
    env: { PATH: '/usr/bin:/bin', KEPT: '1' },
  });
  expect(calls[0]?.options['env']).not.toHaveProperty('ADDED');
});

const scenario4 = scenario('a PTY runs the command and geometry that were validated', async () => {
  const { profile, dimensions, mutate } = mutable();
  const { spawn, calls } = recordingSpawn();
  const recording = recordingDevice();
  const hosted = trackHostedProcess(
    createPtyProcess({ profile, dimensions, spawn, loadDevice: recording.loadDevice }),
  );
  mutate();
  await hosted.backend.start();
  // After the gate: shell, -c, script, argument zero, the terminal's path, then the command that was validated.
  expect(calls[0]?.command.slice(5)).toEqual(['sh', '-c', 'true', 'sh']);
  expect(calls[0]?.command[4]).toBe(recording.opened[0]?.slavePath as string);
  expect(calls[0]?.options).toMatchObject({
    cwd: '/tmp',
    env: { PATH: '/usr/bin:/bin', KEPT: '1' },
    detached: true,
  });
  expect(calls[0]?.options['env']).not.toHaveProperty('ADDED');
  expect(recording.sizes).toEqual([[90, 33]]);
});

describe('a profile changed after construction', () => {
  scenarioResult('a pipe runs the command that was validated', scenario3);

  scenarioResult('a PTY runs the command and geometry that were validated', scenario4);
});

const scenario5 = scenario(
  'a host that cannot bind libc or compile the helper is unsupported, and never becomes a pipe',
  async () => {
    const { spawn, calls } = recordingSpawn();
    const hosted = trackHostedProcess(
      createPtyProcess({ ...PTY_OPTIONS, spawn, loadDevice: mustNotLoad }),
    );
    const failure = await rejectionOf(hosted.backend.start());
    expect((failure as ProcessStartFailure).code).toBe('unsupported-runtime');
    expect(((failure as ProcessStartFailure).cause as Error).message).toBe('must not be loaded');
    expect(calls).toEqual([]);
    expect(await hosted.backend.cleanup()).toBe('complete');
  },
);

describe('an unsupported runtime', () => {
  const windows = { platform: 'win32', architecture: 'x64' };

  test.each([
    ['pipe', () => createPipeProcess({ ...PIPE_OPTIONS, host: windows, ...spawnSpy.options })],
    [
      'pty',
      () =>
        createPtyProcess({
          ...PTY_OPTIONS,
          host: windows,
          loadDevice: mustNotLoad,
          ...spawnSpy.options,
        }),
    ],
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

  scenarioResult(
    'a host that cannot bind libc or compile the helper is unsupported, and never becomes a pipe',
    scenario5,
  );
});

const scenario6 = scenario(
  'one the device cannot open fails the start as spawn-failed, spawning nothing',
  async () => {
    const { spawn, calls } = recordingSpawn();
    const recording = recordingDevice({ open: refuse('no ptmx') });
    const hosted = trackHostedProcess(
      createPtyProcess({ ...PTY_OPTIONS, spawn, loadDevice: recording.loadDevice }),
    );
    const failure = await rejectionOf(hosted.backend.start());
    expect((failure as ProcessStartFailure).code).toBe('spawn-failed');
    expect(calls).toEqual([]);
    expect(recording.closed).toEqual([]);
  },
);

const scenario7 = scenario(
  'a slave that cannot be opened closes the master and spawns nothing',
  async () => {
    const { spawn, calls } = recordingSpawn();
    const recording = recordingDevice({ openSlave: refuse('no slave') });
    const hosted = trackHostedProcess(
      createPtyProcess({ ...PTY_OPTIONS, spawn, loadDevice: recording.loadDevice }),
    );
    const failure = await rejectionOf(hosted.backend.start());
    expect((failure as ProcessStartFailure).code).toBe('spawn-failed');
    expect(calls).toEqual([]);
    expect(recording.closed).toEqual([recording.opened[0]?.masterFd as number]);
  },
);

const scenario8 = scenario(
  'a size that cannot be set closes both ends and spawns nothing',
  async () => {
    const { spawn, calls } = recordingSpawn();
    const recording = recordingDevice({ setWindowSize: refuse('no winsize') });
    const hosted = trackHostedProcess(
      createPtyProcess({ ...PTY_OPTIONS, spawn, loadDevice: recording.loadDevice }),
    );
    const failure = await rejectionOf(hosted.backend.start());
    expect((failure as ProcessStartFailure).code).toBe('spawn-failed');
    expect(calls).toEqual([]);
    expect(recording.closed).toHaveLength(2);
    expect(recording.closed).toContain(recording.opened[0]?.masterFd as number);
  },
);

const scenario9 = scenario('a refused spawn closes both ends and is spawn-failed', async () => {
  const recording = recordingDevice();
  const hosted = trackHostedProcess(
    createPtyProcess({
      ...PTY_OPTIONS,
      loadDevice: recording.loadDevice,
      spawn: () => {
        throw new Error('EACCES');
      },
    }),
  );
  const failure = await rejectionOf(hosted.backend.start());
  expect((failure as ProcessStartFailure).code).toBe('spawn-failed');
  expect(recording.closed).toHaveLength(2);
  expect(recording.closed).toContain(recording.opened[0]?.masterFd as number);
});

const scenario10 = scenario(
  'a Bun that cannot start the reader thread is ended, reaped and reported as unsupported-runtime',
  async () => {
    const killed: unknown[] = [];
    const { spawn } = recordingSpawn((child) => ({
      pid: child.pid,
      exited: child.exited,
      signalCode: child.signalCode,
      stdio: child.stdio,
      kill: (signal) => {
        killed.push(signal);
        child.kill(signal);
      },
    }));
    const recording = recordingDevice();
    const hosted = trackHostedProcess(
      createPtyProcess({
        ...PTY_OPTIONS,
        profile: shellProfile('sleep 7919'),
        spawn,
        loadDevice: recording.loadDevice,
        createMasterWorker: () => {
          throw new Error('no worker');
        },
      }),
    );
    const failure = await rejectionOf(hosted.backend.start());
    expect((failure as ProcessStartFailure).code).toBe('unsupported-runtime');
    expect(killed).toEqual(['SIGKILL']);
    // The slave closed at the spawn, and the master closed with the failed start.
    expect(recording.closed).toHaveLength(2);
    expect(await hosted.backend.cleanup()).toBe('complete');
  },
);

describe('a pseudo-terminal that cannot be set up', () => {
  scenarioResult(
    'one the device cannot open fails the start as spawn-failed, spawning nothing',
    scenario6,
  );

  scenarioResult('a slave that cannot be opened closes the master and spawns nothing', scenario7);

  scenarioResult('a size that cannot be set closes both ends and spawns nothing', scenario8);

  scenarioResult('a refused spawn closes both ends and is spawn-failed', scenario9);

  scenarioResult(
    'a Bun that cannot start the reader thread is ended, reaped and reported as unsupported-runtime',
    scenario10,
  );
});

const scenario11 = scenario('a pipe refuses input it has no channel for', async () => {
  const hosted = trackHostedProcess(createPipeProcess({ profile: shellProfile('sleep 7919') }));
  expect(((await rejectionOf(hosted.backend.write(Uint8Array.of(1)))) as Error).message).toContain(
    'no open input',
  );
  await hosted.backend.start();
  expect(((await rejectionOf(hosted.backend.write(Uint8Array.of(1)))) as Error).message).toContain(
    'no open input',
  );
});

const scenario12 = scenario('a pipe refuses input once it has been cleaned up', async () => {
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
  expect(((await rejectionOf(hosted.backend.write(Uint8Array.of(1)))) as Error).message).toContain(
    'no open input',
  );
});

const scenario13 = scenario(
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

describe('using a process before it is open, or after it is released', () => {
  scenarioResult('a pipe refuses input it has no channel for', scenario11);

  scenarioResult('a pipe refuses input once it has been cleaned up', scenario12);

  scenarioResult(
    'a PTY refuses input and a resize before it starts and after it is cleaned up',
    scenario13,
  );
});

const scenario14 = scenario(
  'a pipe whose input cannot be closed is incomplete, though its process is ended',
  async () => {
    const real = loadPipeDevice();
    let writeEnd: number | undefined;
    const device: PipeDevice = {
      open: () => {
        const pair = real.open();
        writeEnd = pair.writeFd;
        return pair;
      },
      close: (descriptor) => {
        if (descriptor !== writeEnd) return real.close(descriptor);
        // The descriptor is released for real, then the close is reported as failed.
        real.close(descriptor);
        throw new Error('close failed');
      },
    };
    const hosted = trackHostedProcess(
      createPipeProcess({
        profile: shellProfile('sleep 7919'),
        acceptsInput: true,
        terminationGraceMilliseconds: 100,
        loadDevice: () => device,
      }),
    );
    await hosted.backend.start();
    expect(await hosted.backend.cleanup()).toBe('incomplete');
  },
);

const scenario15 = scenario('a pipe whose output cannot be released is incomplete', async () => {
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
  expect(((await rejectionOf(readerOf(hosted).cancel?.())) as Error).message).toBe('cancel failed');
  expect(await hosted.backend.cleanup()).toBe('incomplete');
});

const scenario16 = scenario(
  'a PTY whose master cannot be closed is incomplete, though its process is ended',
  async () => {
    const real = recordingDevice();
    const hosted = trackHostedProcess(
      createPtyProcess({
        ...PTY_OPTIONS,
        profile: shellProfile('sleep 7919'),
        terminationGraceMilliseconds: 100,
        loadDevice: () => ({
          ...real.device,
          close: (descriptor) => {
            real.device.close(descriptor);
            if (descriptor === real.opened[0]?.masterFd) throw new Error('close failed');
          },
        }),
      }),
    );
    await hosted.backend.start();
    expect(await hosted.backend.cleanup()).toBe('incomplete');
  },
);

describe('cleanup that cannot finish every step', () => {
  scenarioResult(
    'a pipe whose input cannot be closed is incomplete, though its process is ended',
    scenario14,
  );

  scenarioResult('a pipe whose output cannot be released is incomplete', scenario15);

  scenarioResult(
    'a PTY whose master cannot be closed is incomplete, though its process is ended',
    scenario16,
  );
});

const scenario17 = scenario(
  'leaves the master open for process teardown and reports cleanup incomplete',
  async () => {
    const real = recordingDevice();
    const hosted = trackHostedProcess(
      createPtyProcess({
        ...PTY_OPTIONS,
        profile: shellProfile('sleep 7919'),
        terminationGraceMilliseconds: 100,
        masterStopTimeoutMilliseconds: 30,
        loadDevice: real.loadDevice,
        createMasterWorker: () => fakeWorker(),
      }),
    );
    await hosted.backend.start();
    const master = real.opened[0]?.masterFd as number;
    expect(await hosted.backend.cleanup()).toBe('incomplete');
    // A thread that may still be reading it must never have the descriptor closed under it.
    expect(real.closed).not.toContain(master);
    real.device.close(master);
  },
);

const scenario18 = scenario(
  'also stops retrying queued input, without closing the descriptor, and leaves it unsettled',
  async () => {
    const real = recordingDevice();
    let attempts = 0;
    const refuse = () => {
      attempts += 1;
      throw Object.assign(new Error('try again'), { code: 'EAGAIN' });
    };
    const timers = trackRealTimers();
    try {
      const hosted = trackHostedProcess(
        createPtyProcess({
          ...PTY_OPTIONS,
          profile: shellProfile('sleep 7919'),
          terminationGraceMilliseconds: 100,
          masterStopTimeoutMilliseconds: 30,
          loadDevice: real.loadDevice,
          createMasterWorker: () => fakeWorker(),
          writeMaster: refuse,
        }),
      );
      await hosted.backend.start();
      const master = real.opened[0]?.masterFd as number;
      let settled = false;
      void hosted.backend.write(Uint8Array.of(1)).then(
        () => (settled = true),
        () => (settled = true),
      );
      expect(attempts).toBe(1);
      expect(await hosted.backend.cleanup()).toBe('incomplete');
      const after = attempts;
      await Bun.sleep(80);
      // The 16 ms retry would have run several times by now against a descriptor still open.
      expect(attempts).toBe(after);
      expect(timers.outstanding()).toBe(0);
      expect(real.closed).not.toContain(master);
      // Never taken, never refused: the session reports it as unknown delivery at close.
      expect(settled).toBe(false);
      real.device.close(master);
    } finally {
      timers.stop();
    }
  },
);

const scenario19 = scenario('a start that fails leaves it open in the same way', async () => {
  const real = recordingDevice();
  const hosted = trackHostedProcess(
    createPtyProcess({
      ...PTY_OPTIONS,
      profile: { ...shellProfile('sleep 7919'), executable: '/nonexistent/definitely-not-here' },
      terminationGraceMilliseconds: 100,
      masterStopTimeoutMilliseconds: 30,
      loadDevice: real.loadDevice,
      createMasterWorker: () => fakeWorker(),
    }),
  );
  const failure = await rejectionOf(hosted.backend.start());
  expect((failure as ProcessStartFailure).code).toBe('spawn-failed');
  const master = real.opened[0]?.masterFd as number;
  expect(real.closed).not.toContain(master);
  real.device.close(master);
});

describe('a PTY whose reader thread does not confirm it stopped', () => {
  scenarioResult(
    'leaves the master open for process teardown and reports cleanup incomplete',
    scenario17,
  );

  scenarioResult(
    'also stops retrying queued input, without closing the descriptor, and leaves it unsettled',
    scenario18,
  );

  scenarioResult('a start that fails leaves it open in the same way', scenario19);
});

const scenario20 = scenario('leaves no descriptor behind', async () => {
  const descriptors = (): number =>
    readdirSync(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd').length;
  // Warm up once so lazy one-time descriptors are not counted.
  const attempt = async () => {
    const hosted = trackHostedProcess(
      createPtyProcess({
        ...PTY_OPTIONS,
        profile: shellProfile('sleep 7919'),
        terminationGraceMilliseconds: 100,
        createMasterWorker: () => {
          throw new Error('no worker');
        },
      }),
    );
    await rejectionOf(hosted.backend.start());
    await hosted.backend.cleanup();
  };
  // Bun closes the pipe of a child it has reported finished a few milliseconds after the fact, with
  // however the pipe was read, and cleanup reads the process table with such a child. So the count
  // is never read in the turn a read returned. The baseline is the lowest count seen once the
  // warm-up has had time to settle, and the final count must come back down to it: a descriptor
  // that is really held never does, however long this waits.
  const lowestOver = async (turns: number): Promise<number> => {
    let lowest = descriptors();
    for (let turn = 0; turn < turns; turn += 1) {
      await Bun.sleep(1);
      lowest = Math.min(lowest, descriptors());
    }
    return lowest;
  };
  await attempt();
  const before = await lowestOver(50);
  for (let round = 0; round < 3; round += 1) await attempt();
  let after = descriptors();
  for await (const _turn of awakeTurns()) {
    if (!(after > before)) break;
    await Bun.sleep(1);
    after = descriptors();
  }
  expect(after).toBeLessThanOrEqual(before);
});

describe('a start that fails after the release channel was opened', () => {
  scenarioResult('leaves no descriptor behind', scenario20);
});

const scenario21 = scenario(
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

describe('a pipe that fails while it is read', () => {
  scenarioResult(
    'fails that output source with the error, leaving the other channel and the process alone',
    scenario21,
  );
});

const DARWIN = { platform: 'darwin', architecture: 'arm64' };
const LINUX = { platform: 'linux', architecture: 'arm64' };

/** A reader thread the test drives: it never reads the terminal, and says whatever the test makes it say. */
function fakeWorker() {
  const listeners = new Map<string, (event: MessageEvent<MasterMessage>) => void>();
  const worker: MasterWorker & { say(message: MasterMessage): void; die(): void } = {
    addEventListener: (type, handler) => {
      listeners.set(type, handler);
    },
    postMessage: () => undefined,
    terminate: () => undefined,
    say: (message) => listeners.get('message')?.({ data: message } as MessageEvent<MasterMessage>),
    die: () => listeners.get('error')?.({} as MessageEvent<MasterMessage>),
  };
  return worker;
}

/** A PTY on `host` whose reader thread the test ends by hand with `message`, while its child keeps running. */
async function endTerminalWith(host: typeof DARWIN, message: MasterMessage) {
  const worker = fakeWorker();
  const run = runHosted(
    trackHostedProcess(
      createPtyProcess({
        ...PTY_OPTIONS,
        profile: shellProfile('sleep 7919'),
        terminationGraceMilliseconds: 100,
        host,
        createMasterWorker: () => worker,
      }),
    ),
  );
  await run.started;
  worker.say(message);
  await flush();
  return run;
}

const scenarios22 = [DARWIN, LINUX].map((host) =>
  scenario(`end of file on ${host.platform} ends the output and the process runs on`, async () => {
    const run = await endTerminalWith(host, { type: 'end', how: 'eof' });
    expect(run.recorder.ofType('sourceComplete')).toEqual([
      { type: 'sourceComplete', channel: 'pty' },
    ]);
    expect(run.session.snapshot.process.kind).toBe('running');
    expect(run.attachment.stop().accepted).toBe(true);
    const awaited1 = await run.session.closed;
    expect(awaited1.cause).toBe('attachment-stop');
  }),
);

const scenario23 = scenario(
  'on Linux EIO is the kernel ending the terminal, so the output ends',
  async () => {
    const run = await endTerminalWith(LINUX, { type: 'end', how: 'eio', code: 'EIO' });
    expect(run.recorder.ofType('sourceComplete')).toEqual([
      { type: 'sourceComplete', channel: 'pty' },
    ]);
    expect(run.session.snapshot.closed).toBe(false);
  },
);

const scenario24 = scenario(
  'on macOS EIO is a failure of the output source, not of the process',
  async () => {
    const run = await endTerminalWith(DARWIN, { type: 'end', how: 'eio', code: 'EIO' });
    const awaited2 = await run.session.closed;
    expect(awaited2.cause).toBe('source-failed');
    expect(run.recorder.ofType('sourceComplete')).toEqual([]);
  },
);

const scenario25 = scenario('any other read error is a failure on both', async () => {
  for (const host of [DARWIN, LINUX]) {
    const run = await endTerminalWith(host, { type: 'end', how: 'error', code: 'EBADF' });
    const awaited3 = await run.session.closed;
    expect(awaited3.cause).toBe('source-failed');
  }
});

const scenario26 = scenario(
  'a reader thread that dies fails the output source and cleanup still completes',
  async () => {
    const worker = fakeWorker();
    const run = runHosted(
      trackHostedProcess(
        createPtyProcess({
          ...PTY_OPTIONS,
          profile: shellProfile('sleep 7919'),
          terminationGraceMilliseconds: 100,
          createMasterWorker: () => worker,
        }),
      ),
    );
    await run.started;
    worker.die();
    const summary = await run.session.closed;
    expect(summary.cause).toBe('source-failed');
    expect(summary.cleanup).toBe('complete');
  },
);

const scenario27 = scenario(
  'a reader stopped by cleanup ends the output without failing it',
  async () => {
    const run = await endTerminalWith(LINUX, { type: 'end', how: 'stopped' });
    expect(run.recorder.ofType('sourceComplete')).toHaveLength(1);
  },
);

describe('the end of the terminal stream', () => {
  for (const started of scenarios22) scenarioResult(started.name, started);

  scenarioResult('on Linux EIO is the kernel ending the terminal, so the output ends', scenario23);

  scenarioResult('on macOS EIO is a failure of the output source, not of the process', scenario24);

  scenarioResult('any other read error is a failure on both', scenario25);

  scenarioResult(
    'a reader thread that dies fails the output source and cleanup still completes',
    scenario26,
  );

  scenarioResult('a reader stopped by cleanup ends the output without failing it', scenario27);
});

const scenario28 = scenario(
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

const scenario29 = scenario('a PTY is a terminal and a pipe is not', async () => {
  const pty = runHosted(hostFor('pty', PTY_FIXTURES.terminalProbe.profile));
  await pty.session.closed;
  expect(textOf(bytesOnChannel(pty.recorder, 'pty'))).toBe(PTY_FIXTURES.terminalProbe.output);
  const pipe = runHosted(hostFor('pipe', PIPE_STDIN_FIXTURES.terminalProbe.profile));
  await pipe.session.closed;
  expect(textOf(bytesOnChannel(pipe.recorder, 'stdout'))).toBe('notty');
});

describe('writing input and reading it back', () => {
  scenarioResult(
    'input reaches the process exactly as written, with nothing added or echoed by the pipe',
    scenario28,
  );

  scenarioResult('a PTY is a terminal and a pipe is not', scenario29);
});

await settleScenarios();
