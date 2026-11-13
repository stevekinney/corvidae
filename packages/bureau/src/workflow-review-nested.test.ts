/**
 * COR-2239's contract for COR-2240 and COR-2242: a review whose wait sits inside a race (a wait
 * with a `timeout`) or a parallel round is listed in Reviews at the address of its own step, with an
 * id that is distinct at distinct addresses, and it leaves Reviews when its timeout wins or its
 * decision arrives. The parked timeline entry of such a wait is a bare `race` or `parallel`, so the
 * address comes from the file workflow's history (`signal-waiting` carries it).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStorage } from '@lostgradient/storage';
import {
  advanceTimersByTime,
  restoreRealTimers,
  useFakeTimers,
} from '@lostgradient/testing/fake-timers';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it, jest } from 'bun:test';
import { z } from 'zod';

import type { BureauError } from './bureau-errors';
import type { PendingHumanWaitReview } from './bureau-types/reviews';
import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  restoreRealTimers();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function start(
  options: Parameters<typeof startWorkflowBureau>[0] = {},
): Promise<WorkflowBureauHarness> {
  const harness = await startWorkflowBureau(options);
  cleanups.push(() => harness.dispose());
  return harness;
}

const reviewsOf = (harness: WorkflowBureauHarness): PendingHumanWaitReview[] =>
  harness.bureau.reviews
    .list()
    .filter(
      (review): review is PendingHumanWaitReview =>
        review.kind === 'human-wait' && review.workflow !== undefined,
    );

async function statusOf(harness: WorkflowBureauHarness, runId: string): Promise<string> {
  const state = await harness.bureau.durableEngine()!.get(runId);
  return state?.status ?? 'missing';
}

async function begin(
  harness: WorkflowBureauHarness,
  id: string,
  steps: readonly unknown[],
): Promise<string> {
  await harness.putWorkflow(id, { trigger: { kind: 'manual' }, steps });
  const { runId } = await harness.bureau.workflows!.start(id, { owner: 'person:test' });
  return runId;
}

const approve = (harness: WorkflowBureauHarness, id: string) =>
  harness.bureau.reviews.resolve({
    id,
    decision: 'approve',
    principal: 'person:test',
    payload: {},
  });

const REVIEW = (signal: string, extra: Record<string, unknown> = {}) => ({
  kind: 'await-signal',
  signal,
  review: true,
  ...extra,
});

const EDITOR = {
  kind: 'activity',
  handler: 'agent',
  input: { agent: 'editor', message: 'Carry on' },
};

describe('a review with a timeout (probe a)', () => {
  it('lists at its own step, then the next review on the same signal at its own', async () => {
    const harness = await start();
    const runId = await begin(harness, 'timed-then-plain', [
      REVIEW('approve', { timeout: '1h' }),
      REVIEW('approve'),
    ]);
    await waitUntil(() => reviewsOf(harness).length === 1);
    const first = reviewsOf(harness)[0]!;
    expect(first.id).toBe(`human-wait:${runId}:approve:0`);
    expect(first.workflow).toMatchObject({ step: 1 });

    await approve(harness, first.id);

    await waitUntil(() => reviewsOf(harness).some((review) => review.id !== first.id));
    expect(reviewsOf(harness).map((review) => review.id)).toEqual([
      `human-wait:${runId}:approve:1`,
    ]);
    await approve(harness, `human-wait:${runId}:approve:1`);
    await waitUntil(async () => (await statusOf(harness, runId)) === 'completed');
  });

  it('is still listed after a restart, at the same id', async () => {
    const storage = new MemoryStorage();
    const directory = await mkdtemp(join(tmpdir(), 'bureau-review-nested-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const first = await start({ directory, overrides: { storage } });
    const runId = await begin(first, 'timed-restart', [
      REVIEW('approve', { timeout: '1h' }),
      EDITOR,
    ]);
    await waitUntil(() => reviewsOf(first).length === 1);
    const id = reviewsOf(first)[0]!.id;
    await first.bureau.dispose();

    const second = await start({ directory, overrides: { storage } });

    expect(reviewsOf(second).map((review) => review.id)).toEqual([id]);
    await approve(second, id);
    await waitUntil(async () => (await statusOf(second, runId)) === 'completed');
  });

  it('leaves Reviews when its timeout wins, before anything else ends the run', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await start({ replies: { editor: async () => (await gate, 'ok') } });
    // Fake timers are the only clock the race primitive honors: the engine's own clock does not
    // fire its sleep branch, so this is AC1's "manual clock" for a wait with a timeout. They are
    // installed before the run starts, so its sleep branch is a fake timer.
    useFakeTimers(Date.now());
    const runId = await begin(harness, 'timed-out', [REVIEW('approve', { timeout: '1h' }), EDITOR]);
    await waitUntil(() => reviewsOf(harness).length === 1);
    await advanceTimersByTime(60 * 60 * 1000);

    // The run is inside the next step, which neither waits on a signal nor ends it.
    await waitUntil(() => harness.calls.some((call) => call.agent === 'editor'));
    await waitUntil(() => reviewsOf(harness).length === 0);
    expect(await statusOf(harness, runId)).toBe('running');
    release();
    await waitUntil(async () => (await statusOf(harness, runId)) === 'completed');
    expect(harness.calls.at(-1)?.message).toContain('"timedOut": true');
  });
});

describe('a review inside a map with a timeout (probe b)', () => {
  it('lists each item at its own address, one after another', async () => {
    const harness = await start({
      output: z.array(z.string()),
      replies: { writer: () => '["one","two"]' },
    });
    const runId = await begin(harness, 'mapped-timed', [
      { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'seed' } },
      { kind: 'map', over: 'output', steps: [REVIEW('ok', { timeout: '1h' })] },
    ]);
    await waitUntil(() => reviewsOf(harness).length === 1);
    const zero = reviewsOf(harness)[0]!;
    expect(zero.id).toBe(`human-wait:${runId}:ok:2#0`);

    await approve(harness, zero.id);

    await waitUntil(() => reviewsOf(harness).some((review) => review.id !== zero.id));
    const one = reviewsOf(harness)[0]!;
    expect(one.id).toBe(`human-wait:${runId}:ok:2#1`);
    await approve(harness, one.id);
    await waitUntil(async () => (await statusOf(harness, runId)) === 'completed');
  });
});

describe('a review inside a parallel branch (probe c)', () => {
  it('lists at the branch step, and the review after the round at its own step', async () => {
    const harness = await start();
    const runId = await begin(harness, 'parallel-then-plain', [
      { kind: 'parallel', branches: { a: [REVIEW('approve')] } },
      REVIEW('approve'),
    ]);
    await waitUntil(() => reviewsOf(harness).length === 1);
    const inBranch = reviewsOf(harness)[0]!;
    expect(inBranch.id).toStartWith(`human-wait:${runId}:approve:1`);
    expect(inBranch.workflow).toMatchObject({ step: 2 });

    await approve(harness, inBranch.id);

    await waitUntil(() => reviewsOf(harness).some((review) => review.id !== inBranch.id));
    const after = reviewsOf(harness)[0]!;
    expect(after.id).toBe(`human-wait:${runId}:approve:2`);
    expect(after.id).not.toBe(inBranch.id);
    await approve(harness, after.id);
    await waitUntil(async () => (await statusOf(harness, runId)) === 'completed');
  });

  it('lists every branch that waits at once, and keeps the others when one is decided', async () => {
    const harness = await start();
    const runId = await begin(harness, 'parallel-two', [
      {
        kind: 'parallel',
        branches: { left: [REVIEW('left-ok')], right: [REVIEW('right-ok', { timeout: '1h' })] },
      },
      EDITOR,
    ]);
    await waitUntil(() => reviewsOf(harness).length === 2);
    const ids = reviewsOf(harness).map((review) => review.id);
    expect(new Set(ids).size).toBe(2);
    expect(
      reviewsOf(harness)
        .map((review) => review.signalName)
        .toSorted(),
    ).toEqual(['left-ok', 'right-ok']);

    const left = reviewsOf(harness).find((review) => review.signalName === 'left-ok')!;
    await approve(harness, left.id);
    await waitUntil(() => reviewsOf(harness).length === 1);
    const right = reviewsOf(harness)[0]!;
    expect(right.signalName).toBe('right-ok');
    expect(await harness.bureau.reviews.pendingOf(runId)).toHaveLength(1);

    await approve(harness, right.id);
    await waitUntil(async () => (await statusOf(harness, runId)) === 'completed');
  });

  it('lists a map nested in a branch, one item after another (G19)', async () => {
    const harness = await start({
      output: z.array(z.string()),
      replies: { writer: () => '["one","two"]' },
    });
    const runId = await begin(harness, 'map-in-branch', [
      { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'seed' } },
      {
        kind: 'parallel',
        branches: { only: [{ kind: 'map', over: 'output', steps: [REVIEW('item-ok')] }] },
      },
    ]);
    await waitUntil(() => reviewsOf(harness).length === 1);
    const zero = reviewsOf(harness)[0]!;
    expect(zero.id).toStartWith(`human-wait:${runId}:item-ok:3`);

    await approve(harness, zero.id);
    await waitUntil(() => reviewsOf(harness).some((review) => review.id !== zero.id));
    const one = reviewsOf(harness)[0]!;
    expect(one.id).not.toBe(zero.id);
    expect(one.id).toStartWith(`human-wait:${runId}:item-ok:3`);
    await approve(harness, one.id);
    await waitUntil(async () => (await statusOf(harness, runId)) === 'completed');
  });
});

describe('what the clock does to a timed review', () => {
  it('keeps a review that a decision beat the timeout to from listing again', async () => {
    const harness = await start();
    const runId = await begin(harness, 'decided-first', [
      REVIEW('approve', { timeout: '1h' }),
      EDITOR,
    ]);
    await waitUntil(() => reviewsOf(harness).length === 1);
    await approve(harness, reviewsOf(harness)[0]!.id);
    await waitUntil(async () => (await statusOf(harness, runId)) === 'completed');
    jest.useFakeTimers();
    await advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(reviewsOf(harness)).toEqual([]);
  });

  it('refuses a decision on a review whose timeout already won, and delivers nothing', async () => {
    const harness = await start();
    useFakeTimers(Date.now());
    const runId = await begin(harness, 'stale-after-timeout', [
      REVIEW('approve', { timeout: '1h' }),
      { kind: 'sleep', duration: '1d' },
      REVIEW('approve'),
    ]);
    await waitUntil(() => reviewsOf(harness).length === 1);
    const stale = reviewsOf(harness)[0]!;
    await advanceTimersByTime(60 * 60 * 1000);
    // The run now sleeps: no event tells Reviews the timeout won, so the row may still be listed.
    await waitUntil(async () => {
      const state = await harness.bureau.durableEngine()!.get(runId);
      return (state?.waitingForSignals ?? []).length === 0;
    });

    const refused = await approve(harness, stale.id).catch((error: unknown) => error);

    expect((refused as BureauError).code).toBe('CONFLICT');
    const state = await harness.bureau.durableEngine()!.get(runId);
    expect(state?.status).toBe('running');
    expect(await harness.bureau.reviews.pendingOf(runId)).toEqual([]);
  });
});
