import { describe, expect } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';

import { waitUntil } from '@lostgradient/testing/wait-until';
import { createDeferred } from '../session/fixtures/deferred.ts';
import { flush, utf8 } from '../session/session.test-support.ts';
import {
  hostFor,
  runHosted,
  scenario,
  scenarioResult,
  settleScenarios,
  trackHostedProcess,
} from './bun-process.test-support.ts';
import { shellProfile } from './fixtures/bun-pipe-stdin.ts';
import type { OutputMode } from './fixtures/terminal-output.ts';
import { createPipeProcess } from './pipe-process.ts';
import type { ProcessStartFailure } from './process-start-failure.ts';
import type { ProcessExit, SpawnedProcess, SpawnProcess } from './process-types.ts';
import { createPtyProcess } from './pty-process.ts';

const MODES: OutputMode[] = ['pipe', 'pty'];
const PTY_DIMENSIONS = { columns: 80, rows: 24 };

/** Wait for `condition`, failing after about five seconds; a condition is a state, never a guess at timing. */
async function eventually(condition: () => boolean): Promise<true> {
  await waitUntil(condition, { message: 'eventually' });
  return true;
}

/** A spawn that starts the real process and lets a test hand back a variation of it. */
function spawnWith(
  alter: (child: ReturnType<typeof Bun.spawn>, options: Record<string, unknown>) => SpawnedProcess,
): SpawnProcess {
  return (command, options) =>
    alter(spawnWithHangGuard(command, { ...(options as object) }), options);
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
    stdio: child.stdio,
    ...replaced,
  };
}

const scenario1 = scenario('when its output ends on its own', async () => {
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
  // Nothing reads a pipe until the session asks, so the output is read to its end here, as it would be there.
  for (const source of hosted.sources) {
    if (source.kind !== 'stream') throw new Error('a pipe process carries streams');
    const reader = source.stream.getReader();
    for (let result = await reader.read(); !result.done; result = await reader.read()) {}
    reader.releaseLock();
  }
  expect(await eventually(() => !stdout.locked && !stderr.locked)).toBe(true);
});

const scenario2 = scenario('when cleanup ends it', async () => {
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

describe('a pipe process releases the pipes it reads', () => {
  scenarioResult('when its output ends on its own', scenario1);

  scenarioResult('when cleanup ends it', scenario2);
});

const scenario3 = scenario(
  'is still signaled, so the cleanup deadline can never be spent waiting on its input',
  async () => {
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
  },
);

describe('a pipe process whose stdin cannot be closed', () => {
  scenarioResult(
    'is still signaled, so the cleanup deadline can never be spent waiting on its input',
    scenario3,
  );
});

/** A master the test drives: it refuses writes with `EAGAIN` until told to take them, and records what it took. */
function drivenMaster(takeAtMost = Number.POSITIVE_INFINITY) {
  const taken: number[][] = [];
  let attempts = 0;
  let blocked = true;
  let failure: string | undefined;
  const writeMaster = (_descriptor: number, bytes: Uint8Array, offset: number): number => {
    attempts += 1;
    if (failure !== undefined) throw Object.assign(new Error(failure), { code: failure });
    if (blocked) throw Object.assign(new Error('try again'), { code: 'EAGAIN' });
    const count = Math.min(bytes.length - offset, takeAtMost);
    taken.push([...bytes.subarray(offset, offset + count)]);
    return count;
  };
  return {
    writeMaster,
    taken,
    get attempts() {
      return attempts;
    },
    accept: () => {
      blocked = false;
    },
    failWith: (code: string) => {
      failure = code;
    },
  };
}

const scenario4 = scenario(
  'a write stays unsettled until the terminal has taken every byte',
  async () => {
    const master = drivenMaster();
    const hosted = trackHostedProcess(
      createPtyProcess({
        profile: shellProfile('sleep 7919'),
        dimensions: PTY_DIMENSIONS,
        terminationGraceMilliseconds: 100,
        writeMaster: master.writeMaster,
      }),
    );
    await hosted.backend.start();
    const settled: string[] = [];
    const first = hosted.backend.write(utf8('one')).then(() => settled.push('one'));
    const second = hosted.backend.write(utf8('two')).then(() => settled.push('two'));
    expect(await eventually(() => master.attempts >= 3)).toBe(true);
    expect(settled).toEqual([]);
    master.accept();
    await Promise.all([first, second]);
    expect(settled).toEqual(['one', 'two']);
    expect(master.taken.map((bytes) => String.fromCharCode(...bytes))).toEqual(['one', 'two']);
  },
);

const scenario5 = scenario(
  'a write the terminal takes in pieces settles when the last piece lands',
  async () => {
    const master = drivenMaster(2);
    master.accept();
    const hosted = trackHostedProcess(
      createPtyProcess({
        profile: shellProfile('sleep 7919'),
        dimensions: PTY_DIMENSIONS,
        terminationGraceMilliseconds: 100,
        writeMaster: master.writeMaster,
      }),
    );
    await hosted.backend.start();
    await hosted.backend.write(utf8('abcde'));
    expect(master.taken.map((bytes) => String.fromCharCode(...bytes))).toEqual(['ab', 'cd', 'e']);
  },
);

const scenario6 = scenario('a zero-length write settles at once and touches nothing', async () => {
  const master = drivenMaster();
  const hosted = trackHostedProcess(
    createPtyProcess({
      profile: shellProfile('sleep 7919'),
      dimensions: PTY_DIMENSIONS,
      terminationGraceMilliseconds: 100,
      writeMaster: master.writeMaster,
    }),
  );
  await hosted.backend.start();
  await hosted.backend.write(utf8(''));
  expect(master.attempts).toBe(0);
});

const scenario7 = scenario('a zero-length write to a real PTY settles', async () => {
  const hosted = trackHostedProcess(
    hostFor('pty', shellProfile('sleep 7919'), { terminationGraceMilliseconds: 100 }),
  );
  await hosted.backend.start();
  await hosted.backend.write(utf8(''));
});

const scenario8 = scenario(
  'a write to a terminal whose other end is gone never settles, and cleanup still completes',
  async () => {
    const master = drivenMaster();
    master.failWith('EIO');
    const hosted = trackHostedProcess(
      createPtyProcess({
        profile: shellProfile('sleep 7919'),
        dimensions: PTY_DIMENSIONS,
        terminationGraceMilliseconds: 100,
        writeMaster: master.writeMaster,
      }),
    );
    await hosted.backend.start();
    const outcome = await Promise.race([
      hosted.backend.write(utf8('lost')).then(() => 'settled'),
      Bun.sleep(150).then(() => 'unsettled'),
    ]);
    expect(outcome).toBe('unsettled');
    expect(master.attempts).toBe(1);
    expect(await hosted.backend.cleanup()).toBe('complete');
  },
);

const scenario9 = scenario('a write the kernel refuses for any other reason fails', async () => {
  const master = drivenMaster();
  master.failWith('EBADF');
  const hosted = trackHostedProcess(
    createPtyProcess({
      profile: shellProfile('sleep 7919'),
      dimensions: PTY_DIMENSIONS,
      terminationGraceMilliseconds: 100,
      writeMaster: master.writeMaster,
    }),
  );
  await hosted.backend.start();
  expect(((await rejectionOf(hosted.backend.write(utf8('x')))) as Error).message).toBe('EBADF');
});

const scenario10 = scenario(
  'the session holds bytes the terminal has not taken, refuses more, and delivers them once it reads',
  async () => {
    const master = drivenMaster();
    const hosted = hostFor('pty', shellProfile('sleep 7919'), {
      writeMaster: master.writeMaster,
    });
    const run = runHosted(hosted, { budgets: { inputQueueBytes: 8 } });
    await run.started;
    expect(run.attachment.write(utf8('12345678'))).toMatchObject({ disposition: 'accepted' });
    expect(await eventually(() => master.attempts >= 1)).toBe(true);
    expect(run.attachment.write(utf8('9'))).toMatchObject({
      disposition: 'failed',
      reason: 'input-held',
    });
    expect(run.attachment.inputHeld).toBe(true);
    master.accept();
    expect(await eventually(() => master.taken.length === 1)).toBe(true);
    await flush();
    expect(run.attachment.write(utf8('9'))).toMatchObject({ disposition: 'accepted' });
    await flush();
    expect(await eventually(() => master.taken.length === 2)).toBe(true);
    await run.session.dispose();
    expect(run.recorder.ofType('operationResult')).toEqual([]);
  },
);

describe('PTY input', () => {
  scenarioResult('a write stays unsettled until the terminal has taken every byte', scenario4);

  scenarioResult(
    'a write the terminal takes in pieces settles when the last piece lands',
    scenario5,
  );

  scenarioResult('a zero-length write settles at once and touches nothing', scenario6);

  scenarioResult('a zero-length write to a real PTY settles', scenario7);

  scenarioResult(
    'a write to a terminal whose other end is gone never settles, and cleanup still completes',
    scenario8,
  );

  scenarioResult('a write the kernel refuses for any other reason fails', scenario9);

  scenarioResult(
    'the session holds bytes the terminal has not taken, refuses more, and delivers them once it reads',
    scenario10,
  );
});

for (const mode of MODES) {
  const scenario11 = scenario(
    'is blocked by the kernel, not buffered by the host and not ended',
    async () => {
      const hosted = trackHostedProcess(hostFor(mode, shellProfile('yes')));
      const exit = createDeferred<ProcessExit>();
      void hosted.reportExitTo({
        start: () => hosted.backend.start(),
        reportProcessExit: (exitCode, signal) => {
          exit.resolve({ exitCode, signal });
          return true;
        },
      });
      await hosted.backend.start();
      const before = process.memoryUsage().rss;
      // A flooding producer that is buffered reaches gigabytes within a second.
      const outcome = await Promise.race([
        exit.promise,
        Bun.sleep(500).then(() => 'still running' as const),
      ]);
      expect(outcome).toBe('still running');
      expect(process.memoryUsage().rss - before).toBeLessThan(96 * 1024 * 1024);
      expect(await hosted.backend.cleanup()).toBe('complete');
    },
  );

  describe(`a ${mode} process whose output nothing reads`, () => {
    scenarioResult('is blocked by the kernel, not buffered by the host and not ended', scenario11);
  });
}

const scenario12 = scenario(
  'both readers are locked before start() yields, because an unlocked pipe is buffered without bound',
  async () => {
    let locks = 0;
    const lockCounting = (stream: unknown) => ({
      getReader: () => {
        locks += 1;
        return (stream as ReadableStream<Uint8Array>).getReader();
      },
    });
    const hosted = trackHostedProcess(
      createPipeProcess({
        profile: shellProfile('sleep 7919'),
        terminationGraceMilliseconds: 100,
        spawn: spawnWith((child) =>
          derive(child, {
            stdout: lockCounting(child.stdout),
            stderr: lockCounting(child.stderr),
          }),
        ),
      }),
    );
    const started = hosted.backend.start();
    // Not awaited: nothing may run between the spawn and the locks, not even a microtask.
    expect(locks).toBe(2);
    await started;
  },
);

describe('a pipe process takes its pipes in the spawn turn', () => {
  scenarioResult(
    'both readers are locked before start() yields, because an unlocked pipe is buffered without bound',
    scenario12,
  );
});

const scenario13 = scenario(
  'is reaped before the start fails as unsupported-runtime, and its command never ran',
  async () => {
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
  },
);

describe('a PTY that Bun returned without the release channel', () => {
  scenarioResult(
    'is reaped before the start fails as unsupported-runtime, and its command never ran',
    scenario13,
  );
});

await settleScenarios();
