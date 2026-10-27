/**
 * COR-1482 — the Bureau's schedule methods pass `expectedRevision` to Weft, which compares it
 * inside its serialized write, and `schedules.update` wraps Weft's `updateSchedule`.
 */
import { ScheduleStaleRevisionError } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { BureauError, createBureau } from './create-bureau';
import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support.ts';
import { createAgent } from '@lostgradient/operative';

async function withBureau<T>(body: (harness: WorkflowBureauHarness) => Promise<T>): Promise<T> {
  const harness = await startWorkflowBureau({
    overrides: {
      agents: {
        default: createAgent({ generate: async () => ({ content: 'tick', toolCalls: [] }) }),
      },
    },
  });
  try {
    return await body(harness);
  } finally {
    await harness.dispose();
  }
}

async function created(harness: WorkflowBureauHarness, overrides: object = {}) {
  const summary = await harness.bureau.schedules.create({
    agentName: 'default',
    input: 'tick',
    spec: '1h',
    ...overrides,
  });
  return summary!;
}

describe('a Bureau schedule’s revision', () => {
  it('starts at 1 and goes up by one for each pause, resume, cancel, and update', async () => {
    await withBureau(async (harness) => {
      const { bureau } = harness;
      const summary = await created(harness);
      expect(summary.revision).toBe(1);
      await bureau.schedules.update(summary.id, { spec: '2h' });
      await bureau.schedules.pause(summary.id);
      await bureau.schedules.resume(summary.id);
      const awaited13 = await bureau.schedules.get(summary.id);
      expect(awaited13?.revision).toBe(4);
      await bureau.schedules.cancel(summary.id);
      const awaited14 = await bureau.schedules.get(summary.id);
      expect(awaited14?.revision).toBe(5);
    });
  });

  it('refuses a stale expectedRevision with the typed error and leaves the schedule as it was', async () => {
    await withBureau(async (harness) => {
      const { bureau } = harness;
      const summary = await created(harness);
      await bureau.schedules.pause(summary.id);
      for (const attempt of [
        () => bureau.schedules.resume(summary.id, { expectedRevision: 1 }),
        () => bureau.schedules.cancel(summary.id, { expectedRevision: 1 }),
        () => bureau.schedules.pause(summary.id, { expectedRevision: 1 }),
        () => bureau.schedules.update(summary.id, { spec: '3h' }, { expectedRevision: 1 }),
      ]) {
        const error = await attempt().catch((thrown: unknown) => thrown);
        expect(error).toBeInstanceOf(ScheduleStaleRevisionError);
        expect(error).toMatchObject({ expectedRevision: 1, currentRevision: 2 });
      }
      expect(await bureau.schedules.get(summary.id)).toMatchObject({
        status: 'paused',
        revision: 2,
      });
      expect(await bureau.schedules.resume(summary.id, { expectedRevision: 2 })).toBe(true);
    });
  });
});

describe('bureau.schedules.update', () => {
  it('changes the cadence, the description, and the overlap policy', async () => {
    await withBureau(async (harness) => {
      const summary = await created(harness, { description: 'first' });
      expect(
        await harness.bureau.schedules.update(summary.id, {
          spec: '*/10 * * * *',
          description: 'second',
          overlap: 'allow',
        }),
      ).toBe(true);
      expect(await harness.bureau.schedules.get(summary.id)).toMatchObject({
        cronExpression: '*/10 * * * *',
        description: 'second',
        overlap: 'allow',
        revision: 2,
      });
    });
  });

  it('refuses overlap allow on a schedule with a recurring session, and any overlap Bureau does not offer', async () => {
    await withBureau(async (harness) => {
      const recurring = await created(harness, { sessionId: 'digest' });
      for (const overlap of ['allow', 'queue']) {
        const error = await harness.bureau.schedules
          .update(recurring.id, { spec: '1h', overlap: overlap as never })
          .catch((thrown: unknown) => thrown);
        expect(error).toBeInstanceOf(BureauError);
        expect((error as BureauError).code).toBe('BAD_REQUEST');
      }
      const awaited15 = await harness.bureau.schedules.get(recurring.id);
      expect(awaited15?.revision).toBe(1);
    });
  });

  it('refuses a workflow’s schedule as one that does not exist, and rejects one that is not there as Weft does', async () => {
    await withBureau(async (harness) => {
      await harness.putWorkflow('digest', { trigger: { kind: 'schedule', spec: '1h' } });
      const refused = await harness.bureau.schedules
        .update('bureau-workflow-schedule:digest:1', { spec: '2h' })
        .catch((thrown: unknown) => thrown);
      expect(refused).toBeInstanceOf(BureauError);
      expect((refused as BureauError).code).toBe('NOT_FOUND');
      const missing = await harness.bureau.schedules
        .update('schedule-nobody', { spec: '2h' })
        .catch((thrown: unknown) => thrown);
      expect(String(missing)).toContain('not found');
    });
  });

  it('does nothing without a durable engine', async () => {
    const bureau = await createBureau({ agents: {}, storage: { type: 'memory' } });
    try {
      expect(await bureau.schedules.update('any', { spec: '1h' })).toBeUndefined();
    } finally {
      await bureau.dispose();
    }
  });
});
