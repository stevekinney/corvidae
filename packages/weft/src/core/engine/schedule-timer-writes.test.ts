/**
 * The writes a schedule timer tick makes (COR-1594, COR-1829, COR-1925): a write that fails for a
 * reason other than a lost read condition is reported as a persistence failure that leaves the
 * timer for the next scan instead of pausing the schedule, and a skip another process recorded is
 * carried into the tick's write on the occurrence that still fires.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { KEYS } from '../../storage/keys.ts';
import {
  closeOpenedEngines,
  nextTimerArmed,
  openEngines,
  SCHEDULE_ID,
  stateOf,
} from './schedule-across-engines.test-support.ts';
import { carryConcurrentRecords, ScheduleStatePersistenceError } from './schedule-timer-writes.ts';
import { drainEngine, listRunningWorkflowIds, MINUTE } from './schedule.test-support.ts';

afterEach(closeOpenedEngines);

describe('a tick whose write of the schedule fails', () => {
  it('reports a persistence failure, leaves the schedule active and keeps its timer for the next scan', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { clock, shared, a, engineA } = await openEngines({ overlap: 'skip' });
      const running = await engineA.triggerSchedule(SCHEDULE_ID);
      if (running.outcome !== 'started') throw new Error('The run now should start.');
      await drainEngine();
      const before = await stateOf(shared);
      expect(await nextTimerArmed(shared)).toBe(true);

      // The occurrence finds the run still holding the slot and is skipped; recording that fails.
      a.failScheduleWrites();
      clock.now = before.nextFireAt!;
      await engineA.scheduler.tick(clock.now);

      const failure = errors.mock.calls
        .flat()
        .find((argument): argument is ScheduleStatePersistenceError => {
          return argument instanceof ScheduleStatePersistenceError;
        });
      expect(failure?.scheduleId).toBe(SCHEDULE_ID);
      expect(failure?.message).toBe(
        `Failed to persist schedule "${SCHEDULE_ID}" while processing its timer`,
      );
      expect(failure?.cause).toMatchObject({ message: 'simulated schedule write failure' });
      // A persistence failure is rethrown, never turned into a pause: the stored schedule and
      // its timer are exactly what they were, so the next scan runs the occurrence again.
      expect(await stateOf(shared)).toEqual(before);
      expect(await shared.get(KEYS.scheduleTick(before.nextFireAt!, SCHEDULE_ID))).not.toBeNull();
      expect(await listRunningWorkflowIds(engineA)).toEqual([running.workflowId]);
    } finally {
      errors.mockRestore();
    }
  });
});

describe('carrying a skip another process recorded into a tick’s write', () => {
  async function cadenceStates() {
    const { shared, engineA } = await openEngines();
    const base = await stateOf(shared);
    expect(base.nextFireAt).not.toBeNull();
    engineA[Symbol.dispose]();
    return base;
  }

  it('moves the skip to the next occurrence that fires when the tick has already moved past it', async () => {
    const base = await cadenceStates();
    const first = base.nextFireAt!;
    // The tick moved the cadence to the second occurrence; the other process skipped the first.
    const ours = { ...base, nextFireAt: first + MINUTE };
    const theirs = { ...base, skipUntil: first };

    const carried = carryConcurrentRecords(ours, base, theirs);

    expect(carried.skipUntil).toBe(first + MINUTE);
    expect(carried.nextFireAt).toBe(first + MINUTE);
  });

  it('moves the skip to the occurrence after the one the tick fired when it names that one', async () => {
    const base = await cadenceStates();
    const first = base.nextFireAt!;
    // The tick fired the first occurrence without moving the cadence yet (a backfill).
    const ours = { ...base, lastFireAt: first };
    const theirs = { ...base, skipUntil: first };

    const carried = carryConcurrentRecords(ours, base, theirs);

    expect(carried.skipUntil).toBe(first + MINUTE);
    expect(carried.lastFireAt).toBe(first);
  });

  it('keeps a skip that names an occurrence the tick has not reached', async () => {
    const base = await cadenceStates();
    const first = base.nextFireAt!;
    const theirs = { ...base, skipUntil: first };

    expect(carryConcurrentRecords(base, base, theirs).skipUntil).toBe(first);
  });
});
