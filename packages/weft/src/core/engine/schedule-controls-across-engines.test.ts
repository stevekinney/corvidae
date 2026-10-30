/**
 * COR-1829: skipping the next run and running a schedule now hold across engines that share a
 * store, as the other writes to a schedule do (COR-1594). Engine A's write to the schedule key is
 * parked between its read and its write while engine B commits a change.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import {
  closeOpenedEngines,
  openEngines,
  SCHEDULE_ID,
  stateOf,
} from './schedule-across-engines.test-support.ts';
import { drainEngine } from './schedule.test-support.ts';

afterEach(closeOpenedEngines);

describe('skipping the next run while another engine changes the schedule', () => {
  it('reads the schedule again and is refused when the other engine paused it', async () => {
    const { shared, a, engineA, engineB } = await openEngines();
    const hold = a.holdScheduleWrite();

    const skipped = engineA.skipNextScheduleOccurrence(SCHEDULE_ID);
    const rejection = rejectionOf(skipped);
    await hold.reached;
    await engineB.pauseSchedule(SCHEDULE_ID);
    hold.release();

    const failure = await rejection;
    expect((failure as Error).message).toContain('has no next occurrence to skip');
    const state = await stateOf(shared);
    expect(state.status).toBe('paused');
    expect(state.skipUntil).toBeUndefined();
  });

  it('applies to the schedule as the other engine left it when the revision was not named', async () => {
    const { shared, a, engineA, engineB } = await openEngines();
    const hold = a.holdScheduleWrite();

    const skipped = engineA.skipNextScheduleOccurrence(SCHEDULE_ID);
    await hold.reached;
    await engineB.updateSchedule(SCHEDULE_ID, '*/5 * * * *');
    hold.release();
    await skipped;

    const state = await stateOf(shared);
    expect(state.cronExpression).toBe('*/5 * * * *');
    expect(state.skipUntil).toBe(state.nextFireAt ?? undefined);
    expect(state.revision).toBe(3);
  });
});

describe('running a schedule now while another engine changes the schedule', () => {
  it('records the run it started on the schedule as the other engine left it', async () => {
    const { shared, a, engineA, engineB } = await openEngines();
    const hold = a.holdScheduleWrite();

    const triggered = engineA.triggerSchedule(SCHEDULE_ID);
    await hold.reached;
    await engineB.pauseSchedule(SCHEDULE_ID);
    hold.release();
    const result = await triggered;
    await drainEngine();

    expect(result.outcome).toBe('started');
    const state = await stateOf(shared);
    expect(state.status).toBe('paused');
    expect(state.revision).toBe(2);
    expect(state.currentWorkflowId).toBe(result.outcome === 'started' ? result.workflowId : '');
  });
});
