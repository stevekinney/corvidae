/**
 * COR-2009 — the schedule tick records what the scheduler did as its result: it checks what it was
 * given, refuses anything else, and returns it unchanged.
 */
import { MemoryStorage } from '@lostgradient/storage';
import { workflow } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createRunEngine } from './create-run-engine';
import { RUN_ENGINE_WORKFLOW_TYPE } from './run-engine-workflow-types';
import { isScheduleTick, type ScheduleTick } from './schedule-tick-workflow';

const MISSED: ScheduleTick = {
  event: 'missed-runs',
  scheduleId: 'daily-summary',
  scheduleName: 'Daily summary',
  missedRuns: 4,
  reason: 'late',
  since: Date.UTC(2026, 9, 30, 8),
  until: Date.UTC(2026, 10, 2, 15),
  whileStopped: true,
};

async function engineFor() {
  const { engine } = await createRunEngine({
    storage: new MemoryStorage(),
    runWorkflow: workflow({ name: 'agentRun' }).execute(async function* (ctx) {
      return yield* ctx.run(() => Promise.resolve('idle'));
    }),
    recover: false,
  });
  return engine;
}

describe('the schedule tick workflow', () => {
  it('knows a tick it records from anything else', () => {
    expect(isScheduleTick(MISSED)).toBe(true);
    expect(
      isScheduleTick({
        event: 'came-due',
        scheduleId: 'daily-summary',
        scheduleName: null,
        fireRunId: 'run-1',
      }),
    ).toBe(true);
    expect(isScheduleTick({ ...MISSED, whileStopped: 'yes' })).toBe(false);
    expect(isScheduleTick({ event: 'skipped', scheduleId: 'daily-summary' })).toBe(false);
  });

  it('returns what it records as its result', async () => {
    const engine = await engineFor();
    try {
      const handle = await engine.start(RUN_ENGINE_WORKFLOW_TYPE.scheduleTick, MISSED);
      expect(await handle.result()).toEqual(MISSED);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('fails on anything that is not a tick', async () => {
    const engine = await engineFor();
    try {
      const handle = await engine.start(RUN_ENGINE_WORKFLOW_TYPE.scheduleTick, { event: 'other' });
      const failure = await handle.result().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('A schedule tick records');
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
