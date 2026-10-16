import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rejectionOf } from '@lostgradient/testing';

import { createDeferred } from '../session/fixtures/deferred.ts';
import type { InputHold } from '../session/session-types.ts';
import { scenario, scenarioResult, settleScenarios } from './bun-process.test-support.ts';
import { shellProfile } from './fixtures/bun-pipe-stdin.ts';
import type { DescriptorWrite } from './input-writer.ts';
import { createPipeDevice, loadPipeDevice, type PipeDevice } from './pipe-device.ts';
import { createPipeProcess } from './pipe-process.ts';
import { ProcessStartFailure } from './process-start-failure.ts';

/**
 * The most a pipe holds before a write waits: the kernel's pipe buffer plus the one write in
 * flight, which the session's input budget (64 KiB) bounds. Measured with a child that never reads
 * (60,000-byte writes, counting what is accepted before one waits): 120,000 bytes on macOS and
 * Linux, that is a 64 KiB kernel pipe buffer and the 60,000-byte write that did not fit. Before
 * this, Bun's stdin sink took 540,000 bytes on macOS first.
 */
const KERNEL_PIPE_BUFFER_BYTES = 65_536;
const INPUT_BUDGET_BYTES = 65_536;

function recordHold() {
  const log: string[] = [];
  const hold: InputHold = { held: () => log.push('held'), resumed: () => log.push('resumed') };
  return { log, hold };
}

const settledIn = (promise: Promise<unknown>) =>
  Promise.race([promise.then(() => 'settled'), Bun.sleep(50).then(() => 'unsettled')]);

const eagain = () => Object.assign(new Error('try again'), { code: 'EAGAIN' });

const scratch = mkdtempSync(join(tmpdir(), 'ventriloquist-pipe-input-'));

const scenarioBound = scenario(
  'a child that never reads holds a write after the kernel buffer and one budget, not half a mebibyte',
  async () => {
    const hosted = createPipeProcess({ profile: shellProfile('sleep 7919'), acceptsInput: true });
    await hosted.backend.start();
    let accepted = 0;
    let held = false;
    const hold: InputHold = { held: () => (held = true), resumed: () => undefined };
    while (!held && accepted < 2_000_000) {
      const write = hosted.backend.write(new Uint8Array(60_000).fill(97), hold);
      accepted += 60_000;
      // A write the pipe takes settles at once; one it cannot take reports itself held first.
      await Promise.race([write, Bun.sleep(0)]);
    }
    expect(held).toBe(true);
    expect(accepted).toBeLessThanOrEqual(KERNEL_PIPE_BUFFER_BYTES + INPUT_BUDGET_BYTES);
    expect(await hosted.backend.cleanup()).toBe('complete');
  },
);

const scenarioRelease = scenario(
  'a held write completes, whole, when the child reads',
  async () => {
    const gate = join(scratch, 'release-pipe-input');
    const hosted = createPipeProcess({
      profile: shellProfile('until [ -e "$1" ]; do sleep 0.05; done; exec wc -c', [gate]),
      acceptsInput: true,
    });
    await hosted.backend.start();
    const { log, hold } = recordHold();
    const written = hosted.backend.write(new Uint8Array(300_000).fill(97), hold);
    expect(await settledIn(written)).toBe('unsettled');
    expect(log[0]).toBe('held');
    await Bun.write(gate, '');
    await written;
    expect(await hosted.backend.cleanup()).toBe('complete');
  },
);

const scenarioQuiet = scenario('a write the pipe takes at once is never held', async () => {
  const hosted = createPipeProcess({ profile: shellProfile('sleep 7919'), acceptsInput: true });
  await hosted.backend.start();
  const { log, hold } = recordHold();
  await hosted.backend.write(new Uint8Array(4), hold);
  await hosted.backend.write(new Uint8Array(4));
  expect(log).toEqual([]);
  expect(await hosted.backend.cleanup()).toBe('complete');
});

const scenarioScripted = scenario(
  'a write the pipe refuses with EAGAIN is held, and resumed when part of it lands',
  async () => {
    let calls = 0;
    const writeInput: DescriptorWrite = () => {
      calls += 1;
      if (calls === 1) throw eagain();
      if (calls === 2) return 2;
      if (calls === 3) throw eagain();
      return 100;
    };
    const hosted = createPipeProcess({
      profile: shellProfile('sleep 7919'),
      acceptsInput: true,
      writeInput,
    });
    await hosted.backend.start();
    const { log, hold } = recordHold();
    await hosted.backend.write(new Uint8Array(8), hold);
    expect(log).toEqual(['held', 'resumed', 'held']);
    expect(await hosted.backend.cleanup()).toBe('complete');
  },
);

const scenarioFailure = scenario('a write that fails for another reason is a failure', async () => {
  const hosted = createPipeProcess({
    profile: shellProfile('sleep 7919'),
    acceptsInput: true,
    writeInput: () => {
      throw Object.assign(new Error('closed'), { code: 'EPIPE' });
    },
  });
  await hosted.backend.start();
  expect(((await rejectionOf(hosted.backend.write(new Uint8Array(4)))) as Error).message).toBe(
    'closed',
  );
  await hosted.backend.cleanup();
});

const scenarioCleanup = scenario(
  'cleanup drops a held write, which stays unsettled, and completes',
  async () => {
    const hosted = createPipeProcess({
      profile: shellProfile('sleep 7919'),
      acceptsInput: true,
      writeInput: () => {
        throw eagain();
      },
    });
    await hosted.backend.start();
    const { log, hold } = recordHold();
    const written = hosted.backend.write(new Uint8Array(4), hold);
    expect(log).toEqual(['held']);
    expect(await hosted.backend.cleanup()).toBe('complete');
    expect(await settledIn(written)).toBe('unsettled');
  },
);

const scenarioNoInput = scenario('a pipe with no input channel refuses a write', async () => {
  const hosted = createPipeProcess({ profile: shellProfile('sleep 7919') });
  await hosted.backend.start();
  expect(((await rejectionOf(hosted.backend.write(new Uint8Array(4)))) as Error).message).toBe(
    'the process has no open input',
  );
  await hosted.backend.cleanup();
});

function recordingDevice(overrides: Partial<PipeDevice> = {}) {
  const real = loadPipeDevice();
  const closed: number[] = [];
  let pair: { readFd: number; writeFd: number } | undefined;
  const device: PipeDevice = {
    open: () => {
      pair = real.open();
      return pair;
    },
    close: (descriptor) => {
      closed.push(descriptor);
      real.close(descriptor);
    },
    ...overrides,
  };
  return { device, closed, pair: () => pair };
}

const scenarioNoLibc = scenario(
  'a host that cannot open a pipe is unsupported-runtime',
  async () => {
    const hosted = createPipeProcess({
      profile: shellProfile('sleep 7919'),
      acceptsInput: true,
      loadDevice: () => {
        throw new Error('no libc');
      },
    });
    const failure = await rejectionOf(hosted.backend.start());
    expect((failure as ProcessStartFailure).code).toBe('unsupported-runtime');
    expect(hosted.startFailure?.code).toBe('unsupported-runtime');
  },
);

const scenarioNoPipe = scenario('a pipe the host cannot open is spawn-failed', async () => {
  const hosted = createPipeProcess({
    profile: shellProfile('sleep 7919'),
    acceptsInput: true,
    loadDevice: () =>
      recordingDevice({
        open: () => {
          throw new Error('EMFILE');
        },
      }).device,
  });
  const failure = await rejectionOf(hosted.backend.start());
  expect((failure as ProcessStartFailure).code).toBe('spawn-failed');
});

const scenarioRefusedSpawn = scenario(
  'a refused spawn closes each end of the input pipe exactly once',
  async () => {
    const recording = recordingDevice();
    const hosted = createPipeProcess({
      profile: shellProfile('true'),
      acceptsInput: true,
      loadDevice: () => recording.device,
      spawn: () => {
        throw new Error('EACCES');
      },
    });
    const failure = await rejectionOf(hosted.backend.start());
    expect((failure as ProcessStartFailure).code).toBe('spawn-failed');
    const pair = recording.pair() as { readFd: number; writeFd: number };
    // A descriptor closed twice could by then belong to another thread.
    expect(recording.closed.toSorted()).toEqual([pair.readFd, pair.writeFd].toSorted());
  },
);

const scenarioDescriptorOwnership = scenario(
  'a started pipe closes its read end once, after the spawn, and its write end once, at cleanup',
  async () => {
    const recording = recordingDevice();
    const hosted = createPipeProcess({
      profile: shellProfile('sleep 7919'),
      acceptsInput: true,
      loadDevice: () => recording.device,
    });
    await hosted.backend.start();
    const pair = recording.pair() as { readFd: number; writeFd: number };
    // Bun duplicates the descriptor into the child and leaves the original open, so this host closes it.
    expect(recording.closed).toEqual([pair.readFd]);
    expect(await hosted.backend.cleanup()).toBe('complete');
    expect(recording.closed).toEqual([pair.readFd, pair.writeFd]);
    expect(await hosted.backend.cleanup()).toBe('complete');
    expect(recording.closed).toEqual([pair.readFd, pair.writeFd]);
  },
);

/** A child that has already gone: the pipe's reader is closed, so a write has nobody to reach. */
const scenarioExitedChild = scenario(
  'a write to a child that exited fails as a write error and does not kill the host',
  async () => {
    const hosted = createPipeProcess({ profile: shellProfile('exit 0'), acceptsInput: true });
    const exited = createDeferred<void>();
    void hosted.reportExitTo({
      start: () => hosted.backend.start(),
      reportProcessExit: () => {
        exited.resolve();
        return true;
      },
    });
    await exited.promise;
    // SIGPIPE would end this process here; Bun ignores it, and the write reports EPIPE.
    const failure = await rejectionOf(hosted.backend.write(new Uint8Array(4)));
    expect((failure as { code?: string }).code).toBe('EPIPE');
    expect(await hosted.backend.cleanup()).toBe('complete');
  },
);

const scenarioHeldChildExits = scenario(
  'a held write whose child exits fails instead of hanging',
  async () => {
    const gate = join(scratch, 'exit-pipe-input');
    const hosted = createPipeProcess({
      profile: shellProfile('until [ -e "$1" ]; do sleep 0.05; done; exit 0', [gate]),
      acceptsInput: true,
    });
    await hosted.backend.start();
    const { log, hold } = recordHold();
    const written = hosted.backend.write(new Uint8Array(300_000).fill(97), hold);
    expect(await settledIn(written)).toBe('unsettled');
    expect(log[0]).toBe('held');
    await Bun.write(gate, '');
    // The child leaves without reading it all: the rest of the write has nowhere to go.
    const failure = await rejectionOf(written);
    expect((failure as { code?: string }).code).toBe('EPIPE');
    expect(await hosted.backend.cleanup()).toBe('complete');
  },
);

describe('pipe input held by a child that is not reading', () => {
  scenarioResult(
    'a child that never reads holds a write after the kernel buffer and one budget, not half a mebibyte',
    scenarioBound,
  );
  scenarioResult('a held write completes, whole, when the child reads', scenarioRelease);
  scenarioResult('a write the pipe takes at once is never held', scenarioQuiet);
  scenarioResult(
    'a write the pipe refuses with EAGAIN is held, and resumed when part of it lands',
    scenarioScripted,
  );
  scenarioResult('a write that fails for another reason is a failure', scenarioFailure);
  scenarioResult(
    'cleanup drops a held write, which stays unsettled, and completes',
    scenarioCleanup,
  );
  scenarioResult('a pipe with no input channel refuses a write', scenarioNoInput);
  scenarioResult('a host that cannot open a pipe is unsupported-runtime', scenarioNoLibc);
  scenarioResult('a pipe the host cannot open is spawn-failed', scenarioNoPipe);
  scenarioResult(
    'a refused spawn closes each end of the input pipe exactly once',
    scenarioRefusedSpawn,
  );
  scenarioResult(
    'a started pipe closes its read end once, after the spawn, and its write end once, at cleanup',
    scenarioDescriptorOwnership,
  );
  scenarioResult(
    'a write to a child that exited fails as a write error and does not kill the host',
    scenarioExitedChild,
  );
  scenarioResult('a held write whose child exits fails instead of hanging', scenarioHeldChildExits);
});

await settleScenarios();
rmSync(scratch, { recursive: true, force: true });

describe('the pipe device', () => {
  const libc = (
    script: { pipe?: number; cloexec?: number; getFlags?: number; setFlags?: number } = {},
  ) => ({
    pipe: (descriptors: Int32Array) => {
      descriptors[0] = 100;
      descriptors[1] = 101;
      return script.pipe ?? 0;
    },
    getFlags: () => script.getFlags ?? 0,
    setFlags: () => script.setFlags ?? 0,
    setCloseOnExec: () => script.cloexec ?? 0,
  });

  test('opens a pair with the write end non-blocking', () => {
    expect(createPipeDevice(libc(), { close: () => undefined }).open()).toEqual({
      readFd: 100,
      writeFd: 101,
    });
  });

  test.each([
    ['pipe', { pipe: -1 }, 0],
    ['FD_CLOEXEC', { cloexec: -1 }, 2],
    ['reading the flags', { getFlags: -1 }, 2],
    ['O_NONBLOCK', { setFlags: -1 }, 2],
  ] as const)('a failure of %s throws and leaves nothing open', (_name, script, closes) => {
    const closed: number[] = [];
    const device = createPipeDevice(libc(script), {
      close: (descriptor) => closed.push(descriptor),
    });
    expect(() => device.open()).toThrow();
    expect(closed).toHaveLength(closes);
  });

  test('closing a descriptor that is already closed is not an error', () => {
    const device = createPipeDevice(libc(), {
      close: () => {
        throw new Error('EBADF');
      },
    });
    expect(() => device.close(5)).not.toThrow();
  });

  test('the real device opens a pair and closes it', () => {
    const device = loadPipeDevice();
    const pair = device.open();
    expect(pair.readFd).not.toBe(pair.writeFd);
    device.close(pair.readFd);
    device.close(pair.writeFd);
    expect(loadPipeDevice()).toBe(device);
  });
});
