/**
 * COR-1594, correction 1: the edges of the schedule write conditions that the first round missed.
 * Orphan-timer recovery that loses its condition retries, a caller's condition on a reserved key is
 * refused where the contract is owned instead of retried for ever, and each half of the timer's
 * "still as the tick left it" rule is pinned.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import type { Storage } from '../../storage/interface.ts';
import { KEYS } from '../../storage/interface.ts';
import { rejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { getInternals } from './internals.ts';
import {
  closeOpenedEngines,
  openEngines,
  SCHEDULE_ID,
  stateOf,
  tickB,
} from './schedule-across-engines.test-support.ts';
import { ScheduleReservedKeyError } from './schedule-reserved-key-error.ts';
import { recoverOrphanedScheduleTimers } from './schedule-timer-recovery.ts';
import { drainEngine, tickEngine } from './schedule.test-support.ts';
import { createScheduleTimerId } from './state-utilities.ts';

afterEach(closeOpenedEngines);

async function timerArmed(shared: Storage): Promise<boolean> {
  const { nextFireAt } = await stateOf(shared);
  if (nextFireAt === null) return false;
  const tick = await shared.get(KEYS.scheduleTick(nextFireAt, SCHEDULE_ID));
  const index = await shared.get(`timer-idx:${createScheduleTimerId(SCHEDULE_ID)}`);
  return tick !== null && index !== null;
}

describe('orphan-timer recovery that loses its condition', () => {
  it('re-arms an active schedule whose current run ended on another engine meanwhile', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines();
    // Engine A fires the first occurrence; its run waits for a signal.
    const first = await stateOf(shared);
    await tickEngine(engineA, clock, first.nextFireAt!);
    const fired = await stateOf(shared);
    // The timer is lost, as a crash between a schedule write and its timer leaves it.
    await shared.batch([
      { type: 'delete', key: `timer-idx:${createScheduleTimerId(SCHEDULE_ID)}` },
      { type: 'delete', key: KEYS.scheduleTick(fired.nextFireAt!, SCHEDULE_ID) },
    ]);
    const hold = b.holdScheduleWrite();

    const recovering = recoverOrphanedScheduleTimers(getInternals(engineB));
    await hold.reached;
    // The run ends: engine A's terminal handler clears the slot, a write that arms no timer.
    await engineA.signal(fired.currentWorkflowId!, 'release');
    await drainEngine();
    await drainEngine();
    hold.release();
    await recovering;

    const state = await stateOf(shared);
    expect(state.status).toBe('active');
    expect(state.currentWorkflowId).toBeUndefined();
    expect(await timerArmed(shared)).toBe(true);
    // And the schedule fires again.
    await tickEngine(engineA, clock, state.nextFireAt!);
    const { lastFireAt } = await stateOf(shared);
    expect(lastFireAt).toBe(state.nextFireAt!);
  });

  it('stops once the schedule is no longer active', async () => {
    const { shared, b, engineA, engineB } = await openEngines();
    const { nextFireAt } = await stateOf(shared);
    await shared.batch([
      { type: 'delete', key: `timer-idx:${createScheduleTimerId(SCHEDULE_ID)}` },
      { type: 'delete', key: KEYS.scheduleTick(nextFireAt!, SCHEDULE_ID) },
    ]);
    const hold = b.holdScheduleWrite();

    const recovering = recoverOrphanedScheduleTimers(getInternals(engineB));
    await hold.reached;
    await engineA.pauseSchedule(SCHEDULE_ID);
    hold.release();
    await recovering;

    const { status } = await stateOf(shared);
    expect(status).toBe('paused');
    expect(await timerArmed(shared)).toBe(false);
  });

  it('stops once something else has armed the timer', async () => {
    const { shared, b, engineA, engineB } = await openEngines();
    const { nextFireAt } = await stateOf(shared);
    await shared.batch([
      { type: 'delete', key: `timer-idx:${createScheduleTimerId(SCHEDULE_ID)}` },
      { type: 'delete', key: KEYS.scheduleTick(nextFireAt!, SCHEDULE_ID) },
    ]);
    const hold = b.holdScheduleWrite();

    const recovering = recoverOrphanedScheduleTimers(getInternals(engineB));
    await hold.reached;
    // Engine A updates the schedule, which arms its own timer.
    await engineA.updateSchedule(SCHEDULE_ID, '*/5 * * * *');
    const updated = await stateOf(shared);
    hold.release();
    await recovering;

    expect(await stateOf(shared)).toEqual(updated);
    expect(await timerArmed(shared)).toBe(true);
  });
});

// `updateSchedule` takes no caller conditions (`ScheduleUpdateOptions` has no `extraConditions`),
// so it has no such boundary to refuse at.
describe('a caller condition on a key Weft reserves', () => {
  const transitions = {
    pause: (engine: Awaited<ReturnType<typeof openEngines>>['engineA'], options: object) =>
      engine.pauseSchedule(SCHEDULE_ID, options),
    resume: (engine: Awaited<ReturnType<typeof openEngines>>['engineA'], options: object) =>
      engine.resumeSchedule(SCHEDULE_ID, options),
    cancel: (engine: Awaited<ReturnType<typeof openEngines>>['engineA'], options: object) =>
      engine.cancelSchedule(SCHEDULE_ID, options),
  } as const;

  for (const [name, run] of Object.entries(transitions)) {
    it(`is refused by ${name} with a typed error, and nothing is written`, async () => {
      const { shared, a, engineA, engineB } = await openEngines();
      if (name === 'resume') await engineA.pauseSchedule(SCHEDULE_ID);
      const stale = await shared.get(KEYS.schedule(SCHEDULE_ID));
      await engineB.updateSchedule(SCHEDULE_ID, '*/5 * * * *');
      const before = await shared.get(KEYS.schedule(SCHEDULE_ID));
      // A runaway retry would never settle: bound it, so a regression fails instead of hanging.
      a.capConditionalBatches(a.conditionalBatches + 50);
      const batchesBefore = a.conditionalBatches;

      const error = await rejectionOf(
        run(engineA, {
          extraConditions: [{ key: KEYS.schedule(SCHEDULE_ID), expectedValue: stale }],
          onExtraConditionsLost: () => new Error('the caller condition was lost'),
        }),
      );

      expect(error).toBeInstanceOf(ScheduleReservedKeyError);
      expect(a.conditionalBatches).toBe(batchesBefore);
      expect(await shared.get(KEYS.schedule(SCHEDULE_ID))).toEqual(before);
    });
  }

  it('still lets a condition on the caller own key through, and reports its loss as the caller error', async () => {
    const { shared, engineA } = await openEngines();
    await shared.put('app:projection:flag', new Uint8Array([1]));

    const error = await rejectionOf(
      engineA.pauseSchedule(SCHEDULE_ID, {
        extraConditions: [{ key: 'app:projection:flag', expectedValue: new Uint8Array([2]) }],
        onExtraConditionsLost: () => new Error('the caller condition was lost'),
      }),
    );

    expect(error).toMatchObject({ message: 'the caller condition was lost' });
    const { status } = await stateOf(shared);
    expect(status).toBe('active');
  });
});

describe('the timer rule that a schedule is still as the tick left it', () => {
  it('abandons a tick whose occurrence another engine fired first (nextFireAt moved, revision did not)', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines();
    const hold = b.holdScheduleWrite();

    const ticking = tickB(clock, engineB, shared);
    await hold.reached;
    // Engine A's scheduler delivers the same timer and commits its tick.
    await engineA.scheduler.tick(clock.now);
    await drainEngine();
    const byA = await stateOf(shared);
    hold.release();
    await ticking;
    await drainEngine();

    const state = await stateOf(shared);
    expect(state.revision).toBe(byA.revision);
    expect(state.currentWorkflowId).toBe(byA.currentWorkflowId);
    expect(state).toEqual(byA);
  });

  it('abandons a tick whose schedule was updated to the same next fire (revision moved, nextFireAt did not)', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines();
    const before = await stateOf(shared);
    const hold = b.holdScheduleWrite();

    const ticking = tickB(clock, engineB, shared);
    await hold.reached;
    // The same cadence, re-anchored at the same instant: the next fire is where it was.
    clock.now = before.createdAt;
    await engineA.updateSchedule(SCHEDULE_ID, '* * * * *');
    const updated = await stateOf(shared);
    expect(updated.revision).toBe(before.revision + 1);
    expect(updated.nextFireAt).toBe(before.nextFireAt);
    hold.release();
    await ticking;
    await drainEngine();

    expect(await stateOf(shared)).toEqual(updated);
  });
});
