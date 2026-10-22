/**
 * `followTask` against a stand-in Bureau (COR-903, part 2a): a stream closes instead of thinning
 * when its reader falls behind, and instead of skipping when retention overtakes its next cursor.
 */
import type { StreamResponse } from '@a2a-js/sdk';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type { DurableEventEnvelope } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { DURABLE_HISTORY_GAP_KIND } from '../durable-event-history.ts';
import type { TaskView } from '../task-registry.ts';
import { type A2AStreamBureau, followTask } from './a2a-task-stream.ts';

const VIEW: TaskView = {
  id: 'task-1',
  contextId: 'context-1',
  agentName: 'asker',
  owner: 'api-key:alice',
  actor: null,
  status: 'working',
  finishReason: null,
  statusMessage: null,
  createdAt: '2026-10-22T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
  cleanup: null,
  openWaits: [],
};

function envelope(sequence: number, kind: string, payload: unknown = {}): DurableEventEnvelope {
  return {
    owner: { kind: 'run', id: 'task-1' },
    kind,
    cursor: String(sequence),
    emittedAtMs: Date.parse('2026-10-22T00:00:00.000Z') + sequence,
    payload,
  } as unknown as DurableEventEnvelope;
}

/** A Bureau whose history holds nothing yet, and whose tail is driven by the test. */
function standIn() {
  let deliver: ((event: DurableEventEnvelope) => void) | undefined;
  const bureau: A2AStreamBureau = {
    eventHistory: async () => ({ events: [], hasMore: false, nextCursor: undefined }),
    subscribeEventHistory: (_owner, listener) => {
      deliver = listener;
      return { unsubscribe: () => undefined } as never;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    tasks: {
      get: async () => VIEW,
      onSettled: () => () => undefined,
      onChanged: () => () => undefined,
    },
  };
  return { bureau, deliver: (event: DurableEventEnvelope) => deliver?.(event) };
}

function follow(bureau: A2AStreamBureau, buffer?: number) {
  return followTask({
    bureau,
    taskId: 'task-1',
    lastEventId: undefined,
    durableHistoryActive: true,
    snapshot: async (view) =>
      ({
        id: view.id,
        contextId: view.contextId,
        status: undefined,
        artifacts: [],
        history: [],
        metadata: undefined,
      }),
    replyOf: async () => undefined,
    timers: createDefaultRuntimeServices().timers,
    signal: undefined,
    ...(buffer === undefined ? {} : { buffer }),
  });
}

async function drain(stream: AsyncGenerator<StreamResponse>): Promise<StreamResponse[]> {
  const events: StreamResponse[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('followTask', () => {
  it('closes, rather than thinning, a stream whose reader falls behind its buffer', async () => {
    const { bureau, deliver } = standIn();
    const stream = follow(bureau, 2);
    const opening = await stream.next();
    expect(opening.value?.payload?.$case).toBe('task');
    // The reader asks for one more event, which subscribes the tail, then stops reading.
    const second = stream.next();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Five review transitions arrive before the reader reads any of them.
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      deliver(
        envelope(sequence, sequence % 2 === 1 ? 'review.requested' : 'review.approved', {
          reviewId: 'review-1',
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));

    const read = await second;
    const rest = await drain(stream);
    // One event reached the reader, two filled the buffer, and the stream then closed: it never
    // carried all five, and it ended rather than dropping some and going on.
    expect(read.done).toBe(false);
    expect(rest.length).toBe(2);
  });

  it('closes, rather than skipping, when retention overtakes the next cursor', async () => {
    const { bureau, deliver } = standIn();
    const stream = follow(bureau);
    await stream.next();
    const second = stream.next();
    await new Promise((resolve) => setTimeout(resolve, 10));

    deliver(envelope(1, 'review.requested', { reviewId: 'review-1' }));
    deliver(
      envelope(7, DURABLE_HISTORY_GAP_KIND, { requestedCursor: '1', firstRetainedCursor: '9' }),
    );
    deliver(envelope(9, 'review.approved', { reviewId: 'review-1' }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const read = await second;
    const rest = await drain(stream);
    // The event before the gap is sent, and the stream closes at the gap: the event after it,
    // which a reconnect's snapshot covers, is never sent.
    expect(read.value?.payload?.$case).toBe('statusUpdate');
    expect(rest).toEqual([]);
  });
});
