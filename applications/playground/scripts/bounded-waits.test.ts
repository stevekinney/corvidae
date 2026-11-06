/**
 * Every wait in the static gate, its cleanup, its stand-ins, and its lifecycle tests is bounded.
 * Each case here races the code under test against a watchdog, so a regression shows up as a
 * failure instead of a stalled test process.
 */
import { HANG_GUARD_MILLISECONDS, spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { outcomeOf, rethrow } from '@lostgradient/testing';

import {
  livingProcesses,
  reapRecordedProcesses,
  recordedProcessIds,
  waitUntilGone,
} from './fixtures/static-playground/stand-ins/stand-in-record.ts';
import { interruptRunner, waitUntil } from './static-playground-processes.ts';

const STAND_IN_RUNNER = join(
  import.meta.dirname,
  'fixtures',
  'static-playground',
  'stand-ins',
  'stand-in-test-runner.ts',
);

/** The stand-in runner starts a real process, so the whole body runs at module scope. */
const standInRunnerEndsAtItsWaitBudget = await outcomeOf(async () => {
  const record = await mkdtemp(join(tmpdir(), 'bounded-wait-record-'));
  try {
    const standIn = spawnWithHangGuard(
      [
        process.execPath,
        STAND_IN_RUNNER,
        '--mode',
        'pass',
        '--record',
        record,
        '--wait-milliseconds',
        '300',
        '--owner-pid',
        String(process.pid),
      ],
      {
        env: { PATH: '/usr/bin:/bin' },
        stdout: 'ignore',
        stderr: 'pipe',
        detached: true,
      },
    );

    // Awaited outright: the hang guard ends a stand-in that ignores its budget, and a watchdog
    // here would time the stand-in's boot on a loaded host rather than its budget.
    const exitCode = await standIn.exited;

    expect(exitCode).toBe(1);
    expect(await new Response(standIn.stderr).text()).toContain('timed out waiting for');
  } finally {
    // The stand-in's sleepers: one in its own group, one detached into a group of its own. Stop
    // each by the PID it recorded, and prove none is left, whatever the body did.
    const recorded = reapRecordedProcesses(record);
    try {
      await waitUntilGone(recorded, HANG_GUARD_MILLISECONDS);
    } finally {
      await rm(record, { recursive: true, force: true });
    }
  }
});

/**
 * A test killed by the hang guard or from outside never reaches its `finally`, which once left a
 * runner's three sleepers and the server running for hours. Every stand-in names its owner and
 * exits once that process is gone, so killing the owner here, with nothing else, must end them.
 */
const standInsEndWithTheirOwner = await outcomeOf(async () => {
  const record = await mkdtemp(join(tmpdir(), 'bounded-wait-record-'));
  const owner = spawnWithHangGuard(['/bin/sh', '-c', 'while :; do sleep 1; done'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    spawnWithHangGuard(
      [
        process.execPath,
        STAND_IN_RUNNER,
        '--mode',
        'hang',
        '--record',
        record,
        '--owner-pid',
        String(owner.pid),
      ],
      { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'ignore'], detached: true },
    );
    const labels = ['test-runner', 'runner-grandchild', 'runner-detached'];
    await waitUntil(
      () => labels.every((label) => existsSync(join(record, `${label}.pid`))),
      HANG_GUARD_MILLISECONDS,
      'the stand-in runner and its sleepers to record their PIDs',
    );
    const recorded = recordedProcessIds(record);

    expect(recorded).toHaveLength(labels.length);
    expect(livingProcesses(recorded)).toHaveLength(labels.length);

    owner.kill('SIGKILL');
    await waitUntilGone(recorded, HANG_GUARD_MILLISECONDS);
  } finally {
    owner.kill('SIGKILL');
    reapRecordedProcesses(record);
    await rm(record, { recursive: true, force: true });
  }
});

describe('bounded waits', () => {
  it('stops waiting for a runner whose exit is never reported', async () => {
    // A subprocess whose `exited` never settles, as when an exit is never observed.
    const neverExits = {
      pid: 2_147_483_000,
      exitCode: null,
      signalCode: null,
      kill: () => undefined,
      exited: new Promise<number>(() => {}),
    } as unknown as Bun.Subprocess;

    // Awaited outright: a grace that never ends is ended by the hang guard.
    // wait-bound: the stub's exit never settles, so only the grace itself is under test
    const outcome = await interruptRunner(neverExits, undefined, { graceMilliseconds: 200 });

    expect(outcome).toEqual({ survivors: [], runnerExited: false });
  });

  it('ends a stand-in test runner that never receives its proceed file', () =>
    rethrow(standInRunnerEndsAtItsWaitBudget));

  it('ends every stand-in, sleepers included, once the test that owns them is gone', () =>
    rethrow(standInsEndWithTheirOwner));
});
