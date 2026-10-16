import { describe, expect } from 'bun:test';

import { rejectionOf, SCENARIO_HANG_GUARD_MILLISECONDS } from '@lostgradient/testing';

import type { InputHold } from '../session/session-types.ts';
import { scenario, scenarioResult, settleScenarios } from './bun-process.test-support.ts';
import { shellProfile } from './fixtures/bun-pipe-stdin.ts';
import { createPipeProcess } from './pipe-process.ts';
import type { SpawnedProcess, SpawnProcess } from './process-types.ts';

type SinkScript = {
  write?: (bytes: Uint8Array) => number | Promise<number>;
  flush?: () => number | Promise<number>;
  end?: () => number | Promise<number>;
};

/** A real child whose standard input is replaced by a sink the test scripts. */
function pipeWith(script: SinkScript) {
  const spawn: SpawnProcess = (command, options) => {
    const child = Bun.spawn(command, {
      ...(options as object),
      timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
    } as never) as unknown as SpawnedProcess;
    return {
      pid: child.pid,
      exited: child.exited,
      get signalCode() {
        return child.signalCode;
      },
      stdout: child.stdout,
      stderr: child.stderr,
      stdin: {
        write: script.write ?? (() => 0),
        flush: script.flush ?? (() => 0),
        end: script.end ?? (() => 0),
      },
      kill: (signal?: number | string) => child.kill(signal),
    };
  };
  return createPipeProcess({ profile: shellProfile('sleep 7919'), acceptsInput: true, spawn });
}

function recordHold() {
  const log: string[] = [];
  const hold: InputHold = { held: () => log.push('held'), resumed: () => log.push('resumed') };
  return { log, hold };
}

const settledIn = (promise: Promise<unknown>) =>
  Promise.race([promise.then(() => 'settled'), Bun.sleep(50).then(() => 'unsettled')]);

const scenario1 = scenario('a write the pipe takes at once is never held', async () => {
  const hosted = pipeWith({});
  await hosted.backend.start();
  const { log, hold } = recordHold();
  await hosted.backend.write(new Uint8Array(4), hold);
  await hosted.backend.write(new Uint8Array(4));
  expect(log).toEqual([]);
  expect(await hosted.backend.cleanup()).toBe('complete');
});

const scenario2 = scenario(
  'a write the sink is waiting to drain is held until it does',
  async () => {
    let drain!: () => void;
    const drained = new Promise<number>((resolve) => {
      drain = () => resolve(4);
    });
    const hosted = pipeWith({ write: () => drained });
    await hosted.backend.start();
    const { log, hold } = recordHold();
    const written = hosted.backend.write(new Uint8Array(4), hold);
    expect(log).toEqual(['held']);
    expect(await settledIn(written)).toBe('unsettled');
    drain();
    await written;
    expect(await hosted.backend.cleanup()).toBe('complete');
  },
);

const scenario3 = scenario('a flush the sink is waiting to complete is held too', async () => {
  let finish!: () => void;
  const finished = new Promise<number>((resolve) => {
    finish = () => resolve(4);
  });
  const hosted = pipeWith({ flush: () => finished });
  await hosted.backend.start();
  const { log, hold } = recordHold();
  const written = hosted.backend.write(new Uint8Array(4), hold);
  expect(await settledIn(written)).toBe('unsettled');
  expect(log).toEqual(['held']);
  finish();
  await written;
  await hosted.backend.cleanup();
});

const scenario4 = scenario(
  'a write that fails while the process is running is a failure',
  async () => {
    const hosted = pipeWith({ write: () => Promise.reject(new Error('EIO')) });
    await hosted.backend.start();
    expect(((await rejectionOf(hosted.backend.write(new Uint8Array(4)))) as Error).message).toBe(
      'EIO',
    );
    await hosted.backend.cleanup();
  },
);

const scenario5 = scenario(
  'a held write that cleanup ends stays unsettled, and discarding it is not a failed cleanup',
  async () => {
    let refuse!: (error: Error) => void;
    const refused = new Promise<number>((_resolve, reject) => {
      refuse = reject;
    });
    const hosted = pipeWith({
      write: () => refused,
      end: () => Promise.reject(Object.assign(new Error('broken pipe'), { code: 'EPIPE' })),
    });
    await hosted.backend.start();
    const written = hosted.backend.write(new Uint8Array(4), recordHold().hold);
    const cleaning = hosted.backend.cleanup();
    refuse(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
    expect(await cleaning).toBe('complete');
    expect(await settledIn(written)).toBe('unsettled');
  },
);

const scenario6 = scenario(
  'an input that cannot be closed for another reason is incomplete',
  async () => {
    const hosted = pipeWith({ end: () => Promise.reject(new Error('EBADF')) });
    await hosted.backend.start();
    expect(await hosted.backend.cleanup()).toBe('incomplete');
  },
);

describe('pipe input held by a child that is not reading', () => {
  scenarioResult('a write the pipe takes at once is never held', scenario1);
  scenarioResult('a write the sink is waiting to drain is held until it does', scenario2);
  scenarioResult('a flush the sink is waiting to complete is held too', scenario3);
  scenarioResult('a write that fails while the process is running is a failure', scenario4);
  scenarioResult(
    'a held write that cleanup ends stays unsettled, and discarding it is not a failed cleanup',
    scenario5,
  );
  scenarioResult('an input that cannot be closed for another reason is incomplete', scenario6);
});

await settleScenarios();
