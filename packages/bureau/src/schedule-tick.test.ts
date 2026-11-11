/**
 * COR-2009 — the schedule tick, the internal workflow whose runs record what the scheduler did: an
 * agent schedule that came due, and missed runs the engine noticed. Each is a run of its own,
 * started by the Bureau (tagged `origin:system`), which is how the run list shows "Schedule tick"
 * runs started by Interborough beside the runs the schedules started.
 */
import {
  createAgent,
  createDefaultRuntimeServices,
  isScheduleTick,
  type RuntimeServices,
  stopWhen,
  type ScheduleTick,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';

import { createBureau } from './create-bureau.ts';
import {
  isScheduleTickRunId,
  SCHEDULE_TICK_WORKFLOW_TYPE,
  scheduleTickId,
} from './schedule-tick.ts';
import { isTaskOrigin, taskOriginTag, TASK_ORIGIN_KINDS } from './task-origin.ts';
import type { AgentDefinitions } from './agent-catalog.ts';
import type { Bureau } from './bureau-types/facade.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  setSystemTime();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function openBureau(runtime?: RuntimeServices): Promise<Bureau> {
  const bureau = await createBureau<AgentDefinitions>({
    ...(runtime === undefined ? {} : { runtime }),
    agents: {
      default: createAgent({
        generate: async () => ({ content: 'Summarized.', toolCalls: [] }),
        toolbox: createToolbox([]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: new MemoryStorage(),
    durable: true,
    maintenance: 'manual',
  });
  cleanups.push(() => bureau.dispose());
  return bureau;
}

async function ticksOf(bureau: Bureau) {
  const engine = bureau.durableEngine();
  if (engine === undefined) throw new Error('The Bureau composed no durable engine.');
  // Every run, filtered here: under manual maintenance the engine's type index is not refreshed.
  const page = await engine.list({});
  const ticks = page.items.filter((summary) => summary.type === SCHEDULE_TICK_WORKFLOW_TYPE);
  return Promise.all(
    ticks.map(async (summary) => ({ summary, state: await engine.get(summary.id) })),
  );
}

/** The completed tick that recorded `event`, once there is one. */
async function completedTick(bureau: Bureau, event: ScheduleTick['event']) {
  const ticks = await ticksOf(bureau);
  return ticks.find(
    ({ state }) =>
      state?.status === 'completed' && isScheduleTick(state.result) && state.result.event === event,
  );
}

const DAY = 24 * 60 * 60_000;

/**
 * Runtime services whose wall clock reads `offset` milliseconds from real time and is moved by
 * `advance`, as the showcase's offset clock is; its timers stay real.
 */
function offsetRuntime(offset: number): RuntimeServices & { advance(milliseconds: number): void } {
  const real = createDefaultRuntimeServices();
  let by = offset;
  const now = () => Date.now() + by;
  return {
    ...real,
    clock: { now, nowISO: () => new Date(now()).toISOString() },
    advance(milliseconds) {
      by += milliseconds;
    },
  };
}

describe('the schedule tick', () => {
  it('is the Bureau’s own: its origin kind is `system`, and its runs carry that tag', () => {
    expect(TASK_ORIGIN_KINDS).toContain('system');
    expect(isTaskOrigin({ kind: 'system' })).toBe(true);
    expect(taskOriginTag({ kind: 'system' })).toBe('origin:system');
    expect(SCHEDULE_TICK_WORKFLOW_TYPE).toBe('scheduleTick');
  });

  it('records one tick per thing it records, however often it is recorded', () => {
    const cameDue: ScheduleTick = {
      event: 'came-due',
      scheduleId: 'daily-summary',
      scheduleName: 'Daily summary',
      fireRunId: 'fire-1',
    };
    expect(scheduleTickId(cameDue)).toBe(scheduleTickId({ ...cameDue }));
    expect(scheduleTickId(cameDue)).not.toBe(scheduleTickId({ ...cameDue, fireRunId: 'fire-2' }));
    expect(isScheduleTickRunId(scheduleTickId(cameDue))).toBe(true);
    expect(isScheduleTickRunId('fire-1')).toBe(false);
  });

  it('records the missed runs the engine noticed, and whether they were missed while it was off', async () => {
    const bureau = await openBureau();
    const summary = await bureau.schedules.create({
      agentName: 'default',
      input: 'Summarize yesterday’s chats and open reviews.',
      spec: '1m',
      description: 'Daily summary',
    });
    const scheduleId = summary?.id ?? '';

    // Ten minutes late: the engine skips the occurrences it missed and records them.
    setSystemTime(new Date(Date.now() + 10 * 60_000));
    await bureau.maintain(Date.now());
    setSystemTime();
    await waitUntil(async () => (await completedTick(bureau, 'missed-runs')) !== undefined);

    const ticks = await ticksOf(bureau);
    const missed = ticks.find(
      ({ state }) => isScheduleTick(state?.result) && state.result.event === 'missed-runs',
    );
    expect(missed?.summary.tags).toEqual(['origin:system', `schedule:${scheduleId}`]);
    expect(missed?.state?.result).toEqual({
      event: 'missed-runs',
      scheduleId,
      scheduleName: 'Daily summary',
      missedRuns: 10,
      reason: 'late',
      since: summary?.nextFireAt,
      until: expect.any(Number),
      // The window began after this Bureau started: it was running, only late.
      whileStopped: false,
    });

    // The same misses need attention, as the engine recorded them (COR-2009, Health).
    const attention = await bureau.attention();
    expect(attention.items).toContainEqual(
      expect.objectContaining({
        kind: 'missed-runs',
        scheduleId,
        scheduleName: 'Daily summary',
        count: 10,
        since: summary?.nextFireAt,
      }),
    );
  });

  it('reads its own clock, not the real one, for missed runs and for what needs attention', async () => {
    // A month behind real time, as the showcase's Nov 2 clock is once Nov 2 has passed.
    const runtime = offsetRuntime(-30 * DAY);
    const bureau = await openBureau(runtime);
    const summary = await bureau.schedules.create({
      agentName: 'default',
      input: 'Summarize yesterday’s chats and open reviews.',
      spec: '1m',
      description: 'Daily summary',
    });
    const scheduleId = summary?.id ?? '';

    runtime.advance(10 * 60_000);
    await bureau.maintain(runtime.clock.now());
    await waitUntil(async () => (await completedTick(bureau, 'missed-runs')) !== undefined);

    const missed = await completedTick(bureau, 'missed-runs');
    expect(missed?.state?.result).toMatchObject({
      event: 'missed-runs',
      scheduleId,
      missedRuns: 10,
      since: summary?.nextFireAt,
      // The window began after this Bureau started, on its clock: it was running, only late.
      whileStopped: false,
    });
    // The misses fall inside the last seven days on the Bureau's clock, whatever the real date.
    const attention = await bureau.attention();
    expect(attention.items).toContainEqual(
      expect.objectContaining({ kind: 'missed-runs', scheduleId, count: 10 }),
    );
  });

  it('records an agent schedule that came due, naming the run its fire started', async () => {
    const bureau = await openBureau();
    const summary = await bureau.schedules.create({
      agentName: 'default',
      input: 'Summarize yesterday’s chats and open reviews.',
      spec: '1m',
      description: 'Daily summary',
    });
    const scheduleId = summary?.id ?? '';
    const due = summary?.nextFireAt ?? 0;

    setSystemTime(new Date(due + 1_000));
    await bureau.maintain(Date.now());
    setSystemTime();
    await waitUntil(async () => (await completedTick(bureau, 'came-due')) !== undefined);

    const ticks = await ticksOf(bureau);
    const cameDue = ticks.find(
      ({ state }) => isScheduleTick(state?.result) && state.result.event === 'came-due',
    );
    const fires = await bureau.durableEngine()!.list({ scheduleId });
    expect(cameDue?.summary.tags).toContain('origin:system');
    expect(cameDue?.state?.result).toEqual({
      event: 'came-due',
      scheduleId,
      scheduleName: 'Daily summary',
      fireRunId: fires.items[0]?.id,
    });
    expect(ticks).toHaveLength(1);
  });

  it('records nothing for a schedule started by hand', async () => {
    const bureau = await openBureau();
    const summary = await bureau.schedules.create({
      agentName: 'default',
      input: 'Summarize yesterday’s chats and open reviews.',
      spec: '1h',
    });

    const fired = await bureau.schedules.runNow(summary?.id ?? '');
    await waitUntil(async () => {
      const workflowId = fired !== undefined && 'workflowId' in fired ? fired.workflowId : '';
      const state = await bureau.durableEngine()!.get(workflowId);
      return state?.status === 'completed';
    });

    expect(await ticksOf(bureau)).toEqual([]);
  });
});
