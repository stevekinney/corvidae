/**
 * COR-1613 — what a client reads of a schedule fire that settled holding a pending review: a
 * stream that resumes at the snapshot's cursor is told the fire's current status, and the
 * fire's context reads as awaiting input, as its task does.
 */
import { stopWhen } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  OWNER,
  readFrames,
  rpc,
  subscribeRequest,
} from './http/management/management-fixtures.test-support.ts';
import {
  approvalToolbox,
  chargesOnce,
  createScheduleFireHarness,
  durableStatus,
  fireOnce,
  handlerOf,
  pollUntil,
  reviewOf,
} from './schedule-fire-fixtures.test-support';

const harness = createScheduleFireHarness();

afterEach(async () => {
  await harness.dispose();
});

const SESSION = 'views-session';

/** A fire that ends its steps at its approval, so its run settles with the review still open. */
async function settledWithPendingReview() {
  const charges: number[] = [];
  const bureau = await harness.open({
    generate: chargesOnce,
    toolbox: approvalToolbox(charges),
    stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
  });
  const { fireId } = await fireOnce(bureau, OWNER.alice, SESSION);
  const review = await reviewOf(bureau, fireId);
  await pollUntil(
    async () => ((await durableStatus(bureau, fireId)) === 'completed' ? true : undefined),
    'the fire to end at its approval',
  );
  return { bureau, fireId, review, charges };
}

describe('a task stream resumed at the snapshot cursor', () => {
  it('is told the fire’s current status, which changed while the client was away', async () => {
    const { bureau, fireId, review } = await settledWithPendingReview();
    const handler = handlerOf(bureau);
    const view = await rpc(handler, 'bureau.tasks.get', { taskId: fireId }, 'alice-key');
    expect(view.result).toMatchObject({ status: 'input-required' });

    const reading = readFrames(
      await handler(subscribeRequest('bureau.tasks.events', { taskId: fireId }, 'alice-key', '-1')),
      { timeoutMs: 10_000 },
    );
    await bureau.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice });
    const frames = await reading;

    expect(frames.map((frame) => (frame.data as { status?: string }).status)).toEqual([
      'input-required',
      'completed',
    ]);
  });
});

describe('the context of a fire that settled holding a pending review', () => {
  it('reads as awaiting input in the list and in a read, as its task does', async () => {
    const { bureau, fireId } = await settledWithPendingReview();
    const handler = handlerOf(bureau);
    const task = await rpc(handler, 'bureau.tasks.get', { taskId: fireId }, 'alice-key');
    expect(task.result).toMatchObject({ status: 'input-required' });
    const contextId = String(task.result?.['contextId']);

    const listed = await rpc(handler, 'bureau.contexts.list', {}, 'alice-key');
    const contexts = (listed.result?.['contexts'] ?? []) as Array<{ id: string; activity: string }>;
    expect(contexts.find((context) => context.id === contextId)?.activity).toBe('awaiting-input');
    const read = await rpc(handler, 'bureau.contexts.get', { contextId }, 'alice-key');
    expect(read.result).toMatchObject({ activity: 'awaiting-input' });
  });
});
