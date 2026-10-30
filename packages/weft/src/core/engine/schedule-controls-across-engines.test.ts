/**
 * COR-1829: skipping the next run and running a schedule now hold across engines that share a
 * store, as the other writes to a schedule do (COR-1594). Engine A's write to the schedule key is
 * parked between its read and its write while engine B commits a change.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { KEYS } from '../../storage/keys.ts';
import { encode } from '../codec.ts';
import {
  closeOpenedEngines,
  openEngines,
  SCHEDULE_ID,
  stateOf,
  tickB,
} from './schedule-across-engines.test-support.ts';
import { drainEngine, listRunningWorkflowIds, MINUTE } from './schedule.test-support.ts';

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
    // The update's change; a skip is bookkeeping and leaves the revision alone.
    expect(state.revision).toBe(2);
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

/** Engine A runs the schedule once, so a run that waits for its signal holds the slot. */
async function occupySlot(opened: Awaited<ReturnType<typeof openEngines>>): Promise<string> {
  const first = await opened.engineA.triggerSchedule(SCHEDULE_ID);
  await drainEngine();
  if (first.outcome !== 'started') throw new Error('The first run did not start.');
  return first.workflowId;
}

describe('running a schedule now while another engine fires it (trigger parked, tick commits)', () => {
  it('skip: decides again from the run the tick started, and starts no second run', async () => {
    const opened = await openEngines();
    const { clock, shared, a, engineA, engineB } = opened;
    const hold = a.holdScheduleWrite();

    const triggered = engineA.triggerSchedule(SCHEDULE_ID);
    await hold.reached;
    await tickB(clock, engineB, shared);
    await drainEngine();
    const byB = await stateOf(shared);
    hold.release();
    const result = await triggered;
    await drainEngine();

    expect(byB.currentWorkflowId).toBeDefined();
    expect(result).toEqual({ outcome: 'skipped', blockingWorkflowId: byB.currentWorkflowId! });
    expect(await listRunningWorkflowIds(engineA)).toEqual([byB.currentWorkflowId!]);
    const state = await stateOf(shared);
    expect(state.currentWorkflowId).toBe(byB.currentWorkflowId);
    expect(state.skippedCount).toBe(1);
    expect(state.nextFireAt).toBe(byB.nextFireAt);
  });

  it('queue: keeps the occurrence the tick queued and queues its own run after it', async () => {
    const opened = await openEngines();
    const { clock, shared, a, engineA, engineB } = opened;
    await engineA.updateSchedule(SCHEDULE_ID, '* * * * *', { overlap: 'queue' });
    const running = await occupySlot(opened);
    const hold = a.holdScheduleWrite();

    const triggered = engineA.triggerSchedule(SCHEDULE_ID);
    await hold.reached;
    await tickB(clock, engineB, shared);
    const byB = await stateOf(shared);
    hold.release();
    const result = await triggered;

    expect(byB.queuedRuns).toHaveLength(1);
    expect(result.outcome).toBe('queued');
    const state = await stateOf(shared);
    expect(state.currentWorkflowId).toBe(running);
    expect(state.queuedRuns.map((run) => run.workflowId)).toEqual([
      byB.queuedRuns[0]!.workflowId,
      result.outcome === 'queued' ? result.workflowId : '',
    ]);
    expect(state.nextFireAt).toBe(byB.nextFireAt);
  });
});

describe('a timer tick while another engine runs the schedule now (tick parked, trigger commits)', () => {
  it('queue: keeps the run the trigger queued and adds its own occurrence after it', async () => {
    const opened = await openEngines();
    const { clock, shared, b, engineA, engineB } = opened;
    await engineA.updateSchedule(SCHEDULE_ID, '* * * * *', { overlap: 'queue' });
    const running = await occupySlot(opened);
    const before = await stateOf(shared);
    const hold = b.holdScheduleWrite();

    const ticking = tickB(clock, engineB, shared);
    await hold.reached;
    const result = await engineA.triggerSchedule(SCHEDULE_ID);
    hold.release();
    await ticking;
    await drainEngine();

    expect(result.outcome).toBe('queued');
    const state = await stateOf(shared);
    expect(state.currentWorkflowId).toBe(running);
    expect(state.queuedRuns).toHaveLength(2);
    expect(state.queuedRuns[0]).toMatchObject({
      workflowId: result.outcome === 'queued' ? result.workflowId : '',
      manual: true,
    });
    expect(state.queuedRuns[1]).toMatchObject({ occurrence: before.nextFireAt! });
    expect(state.nextFireAt).toBe(before.nextFireAt! + MINUTE);
  });

  it('skip: counts both skips when a run holds the slot', async () => {
    const opened = await openEngines();
    const { clock, shared, b, engineA, engineB } = opened;
    const running = await occupySlot(opened);
    const before = await stateOf(shared);
    const hold = b.holdScheduleWrite();

    const ticking = tickB(clock, engineB, shared);
    await hold.reached;
    const result = await engineA.triggerSchedule(SCHEDULE_ID);
    hold.release();
    await ticking;
    await drainEngine();

    expect(result).toEqual({ outcome: 'skipped', blockingWorkflowId: running });
    const state = await stateOf(shared);
    expect(state.currentWorkflowId).toBe(running);
    expect(state.skippedCount).toBe(2);
    expect(state.nextFireAt).toBe(before.nextFireAt! + MINUTE);
  });

  it('skip: never writes over the run the trigger recorded, and still moves the cadence on', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines();
    const before = await stateOf(shared);
    const hold = b.holdScheduleWrite();

    // The tick has started its run and is about to record it.
    const ticking = tickB(clock, engineB, shared);
    await hold.reached;
    const result = await engineA.triggerSchedule(SCHEDULE_ID);
    hold.release();
    await ticking;
    await drainEngine();

    expect(result.outcome).toBe('started');
    const state = await stateOf(shared);
    expect(state.currentWorkflowId).toBe(result.outcome === 'started' ? result.workflowId : '');
    expect(state.lastFireAt).toBe(before.nextFireAt!);
    expect(state.nextFireAt).toBe(before.nextFireAt! + MINUTE);
  });
});

describe('a timer tick while another engine clears the run it replaced', () => {
  it('keeps the run the tick started when the other engine only cleared the slot', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines();
    // The schedule still names a run that has finished: the tick clears it and starts its own.
    const finished = await engineA.start('across-workflow', null);
    await engineA.signal(finished.id, 'release');
    await finished.result();
    const before = await stateOf(shared);
    await shared.put(
      KEYS.schedule(SCHEDULE_ID),
      encode({ ...before, currentWorkflowId: finished.id }),
    );
    const hold = b.holdScheduleWrite();

    const ticking = tickB(clock, engineB, shared);
    await hold.reached;
    // The other engine's terminal handler clears the finished run.
    const { currentWorkflowId: _cleared, ...cleared } = await stateOf(shared);
    await shared.put(
      KEYS.schedule(SCHEDULE_ID),
      encode({ ...cleared, updatedAt: cleared.updatedAt + 1 }),
    );
    hold.release();
    await ticking;
    await drainEngine();

    const state = await stateOf(shared);
    const running = await listRunningWorkflowIds(engineA);
    expect(running).toHaveLength(1);
    expect(state.currentWorkflowId).toBe(running[0]);
    expect(state.nextFireAt).toBe(before.nextFireAt! + MINUTE);
  });
});

describe('skipping the next run while another engine fires it (tick parked, skip commits)', () => {
  it('moves the skip to the next fire when the tick already started the one it named', async () => {
    const { clock, shared, b, engineA, engineB } = await openEngines();
    const before = await stateOf(shared);
    const first = before.nextFireAt!;
    const hold = b.holdScheduleWrite();

    const ticking = tickB(clock, engineB, shared);
    await hold.reached;
    await engineA.skipNextScheduleOccurrence(SCHEDULE_ID);
    const skipped = await stateOf(shared);
    expect(skipped.skipUntil).toBe(first);
    hold.release();
    await ticking;
    await drainEngine();

    const state = await stateOf(shared);
    expect(state.lastFireAt).toBe(first);
    expect(state.nextFireAt).toBe(first + MINUTE);
    expect(state.skipUntil).toBe(first + MINUTE);
  });
});
