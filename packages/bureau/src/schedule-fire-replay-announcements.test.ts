/**
 * COR-1613 — a replay never leaves an abandoned review request open in a fire's durable history.
 *
 * Whether a replayed call id is deterministic is the model's, not Bureau's: the id comes from the
 * `generate` response, so a scripted model repeats it and a real provider mints a new one. Both
 * are tested. A repeated id is announced once; a new id leaves the first attempt's request, which
 * the dead process announced, to be closed with `review.superseded` when the fire settles.
 */
import { type GenerateFunction, stopWhen, createAgent } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { OWNER } from './http/management/management-fixtures.test-support.ts';
import {
  approvalToolbox,
  crashAfterApprovalWrite,
  createScheduleFireHarness,
  durableStatus,
  fireOnce,
  pollUntil,
  reviewOf,
} from './schedule-fire-fixtures.test-support';
import type { Bureau } from './types';

const harness = createScheduleFireHarness();

afterEach(async () => {
  await harness.dispose();
});

const stopAtApproval = stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls());

async function reviewEvents(bureau: Bureau, runId: string) {
  const page = await bureau.eventHistory({ kind: 'run', id: runId });
  if (!('events' in page)) return [];
  return page.events
    .filter((event) => event.kind.startsWith('review.'))
    .map((event) => ({
      kind: event.kind,
      reviewId: (event.payload as { reviewId?: string }).reviewId ?? '',
    }));
}

/** Every request in the history either names a review still pending or is followed by its close. */
function expectNoOpenAbandonedRequest(
  events: readonly { kind: string; reviewId: string }[],
  pending: readonly string[],
) {
  for (const [index, event] of events.entries()) {
    if (event.kind !== 'review.requested') continue;
    const closed = events
      .slice(index + 1)
      .some((later) => later.kind !== 'review.requested' && later.reviewId === event.reviewId);
    expect(closed || pending.includes(event.reviewId)).toBe(true);
  }
}

async function crashThenRecover(callIds: (attempt: number) => string) {
  const path = harness.nextDatabasePath();
  const crash = crashAfterApprovalWrite();
  let attempt = 0;
  const generate: GenerateFunction = async (context) => {
    if (context.step > 0) return { content: 'charged', toolCalls: [] };
    attempt += 1;
    return {
      content: '',
      toolCalls: [{ id: callIds(attempt), name: 'charge-card', arguments: { cents: 100 } }],
    };
  };
  const first = await harness.open({
    storage: await harness.sqliteStorage(path, (storage) => crash.wrap(storage)),
    agents: {
      default: createAgent({ generate, toolbox: approvalToolbox([]), stopWhen: stopAtApproval }),
    },
  });
  const { fireId } = await fireOnce(first, OWNER.alice, 'replay-session');
  await reviewOf(first, fireId);
  await crash.reached;
  // Let the first process's announcement reach the history before it is considered dead.
  await pollUntil(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const events = await reviewEvents(first, fireId);
    return events.length > 0 ? true : undefined;
  }, 'the first attempt’s request to reach the history');

  const recovered = await harness.open({
    storage: await harness.sqliteStorage(path),
    agents: {
      default: createAgent({ generate, toolbox: approvalToolbox([]), stopWhen: stopAtApproval }),
    },
  });
  await pollUntil(
    async () => ((await durableStatus(recovered, fireId)) === 'completed' ? true : undefined),
    'the recovered fire to complete',
  );
  await reviewOf(recovered, fireId);
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { recovered, fireId };
}

describe('a replay of a step that raised an approval', () => {
  it('closes the abandoned request when the replay makes the call under a new id', async () => {
    const { recovered, fireId } = await crashThenRecover((attempt) => `charge-${attempt}`);

    const events = await reviewEvents(recovered, fireId);
    const pending = recovered.reviews
      .list()
      .filter((review) => review.runId === fireId)
      .map((review) => review.id);

    expect(pending).toEqual([`approval:${fireId}:charge-2`]);
    expect(
      events.filter((event) => event.kind === 'review.requested').map((event) => event.reviewId),
    ).toEqual([`approval:${fireId}:charge-1`, `approval:${fireId}:charge-2`]);
    expect(
      events.filter((event) => event.kind === 'review.superseded').map((event) => event.reviewId),
    ).toEqual([`approval:${fireId}:charge-1`]);
    expectNoOpenAbandonedRequest(events, pending);
  });

  it('announces the request once when the replay makes the call under the same id', async () => {
    const { recovered, fireId } = await crashThenRecover(() => 'charge-same');

    const events = await reviewEvents(recovered, fireId);
    const pending = recovered.reviews
      .list()
      .filter((review) => review.runId === fireId)
      .map((review) => review.id);

    expect(pending).toEqual([`approval:${fireId}:charge-same`]);
    expect(events.filter((event) => event.kind === 'review.requested')).toHaveLength(1);
    expectNoOpenAbandonedRequest(events, pending);
  });
});
