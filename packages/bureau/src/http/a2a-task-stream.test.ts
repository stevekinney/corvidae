/**
 * `followTask` against a stand-in Bureau (COR-903, part 2a): a stream closes instead of thinning
 * when its reader falls behind, and instead of skipping when retention overtakes its next cursor.
 */
import type { StreamResponse } from '@a2a-js/sdk';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type { DurableEventEnvelope } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { DURABLE_HISTORY_GAP_KIND } from '../durable-event-history.ts';
import type { TaskView } from '../task-registry.ts';
import { type A2AStreamBureau, followTask } from './a2a-task-stream.ts';
import { waitUntil, yieldEventLoopTurn } from '@lostgradient/testing/wait-until';

const VIEW: TaskView = {
  id: 'task-1',
  contextId: 'context-1',
  agentName: 'asker',
  owner: 'api-key:alice',
  actor: null,
  kind: 'chat',
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
function standIn(
  overrides: {
    view?: TaskView;
    eventHistory?: A2AStreamBureau['tasks']['events'];
    getDelayMs?: number;
  } = {},
) {
  let deliver: ((event: DurableEventEnvelope) => void) | undefined;
  let closed: ((error: unknown) => void) | undefined;
  let changed: ((view: TaskView) => void) | undefined;
  const bureau: A2AStreamBureau = {
    reviews: { get: async () => undefined },
    tasks: {
      events:
        overrides.eventHistory ??
        (async () => ({ events: [], hasMore: false, nextCursor: undefined })),
      subscribeEvents: (_taskId, listener, options) => {
        deliver = listener;
        closed = options?.onClosed ?? undefined;
        return { unsubscribe: () => undefined } as never;
      },
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    internals: {
      taskRegistry: {
        record: async () => undefined,
        get: async () => {
          if (overrides.getDelayMs !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, overrides.getDelayMs));
          }
          return overrides.view ?? VIEW;
        },
        onSettled: () => () => undefined,
        onChanged: (_taskId, listener) => {
          changed = listener;
          return () => undefined;
        },
      },
    },
  };
  return {
    bureau,
    change: (view: TaskView) => changed?.(view),
    deliver: (event: DurableEventEnvelope) => deliver?.(event),
    close: (error: unknown) => closed?.(error),
    /** Whether the stream has subscribed to the tail, so a delivered event reaches it. */
    attached: () => deliver !== undefined,
  };
}

function follow(
  bureau: A2AStreamBureau,
  buffer?: number,
  seen: { view?: TaskView; metadata?: unknown } = {},
  durableHistoryActive = true,
) {
  return followTask({
    bureau,
    taskId: 'task-1',
    lastEventId: undefined,
    durableHistoryActive,
    snapshot: async (view) => {
      seen.view = view;
      return {
        task: {
          id: view.id,
          contextId: view.contextId,
          status: undefined,
          artifacts: [],
          history: [],
          metadata: undefined,
        },
        surfaces: [],
      };
    },
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
    const { bureau, deliver, attached } = standIn();
    const stream = follow(bureau, 2);
    const opening = await stream.next();
    expect(opening.value?.payload?.$case).toBe('task');
    // The reader asks for one more event, which subscribes the tail, then stops reading.
    const second = stream.next();
    await waitUntil(attached, { message: 'the stream to subscribe to the tail' });

    // Five review transitions arrive before the reader reads any of them.
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      deliver(
        envelope(sequence, sequence % 2 === 1 ? 'review.requested' : 'review.approved', {
          reviewId: 'review-1',
        }),
      );
    }
    // load-proof: the work this lets finish runs on in-memory storage and doubles and settles through promise continuations only, so a microtask drain completes it (checked by replacing the turn with one); no timer or I/O is pending
    await yieldEventLoopTurn();

    const read = await second;
    const rest = await drain(stream);
    // One event reached the reader, two filled the buffer, and the stream then closed: it never
    // carried all five, and it ended rather than dropping some and going on.
    expect(read.done).toBe(false);
    expect(rest.length).toBe(2);
  });

  it('closes, rather than skipping, when retention overtakes the next cursor', async () => {
    const { bureau, deliver, attached } = standIn();
    const stream = follow(bureau);
    await stream.next();
    const second = stream.next();
    await waitUntil(attached, { message: 'the stream to subscribe to the tail' });

    deliver(envelope(1, 'review.requested', { reviewId: 'review-1' }));
    deliver(
      envelope(7, DURABLE_HISTORY_GAP_KIND, { requestedCursor: '1', firstRetainedCursor: '9' }),
    );
    deliver(envelope(9, 'review.approved', { reviewId: 'review-1' }));

    const read = await second;
    const rest = await drain(stream);
    // The event before the gap is sent, and the stream closes at the gap: the event after it,
    // which a reconnect's snapshot covers, is never sent.
    expect(read.value?.payload?.$case).toBe('statusUpdate');
    expect(rest).toEqual([]);
  });

  it('keeps a review open that retention left only the later events of', async () => {
    const view: TaskView = {
      ...VIEW,
      status: 'input-required',
      openWaits: [{ kind: 'human-wait', reviewId: 'review-1', signalName: 'human-response' }],
    };
    const seen: { view?: TaskView } = {};
    const { bureau } = standIn({
      view,
      // The event that opened the review is gone; a later, unrelated one survives.
      eventHistory: async () => ({
        events: [envelope(4, 'run.completed', {})],
        hasMore: false,
        nextCursor: undefined,
      }),
    });
    const stream = follow(bureau, undefined, seen);
    const opening = await stream.next();
    expect(opening.value?.payload?.$case).toBe('task');
    expect(seen.view?.status).toBe('input-required');
    await stream.return(undefined);
  });

  it('resumes from the cursor retention advanced to when the task kept no event', async () => {
    let calls = 0;
    const { bureau } = standIn({
      eventHistory: async () => {
        calls += 1;
        return calls === 1
          ? ({ outcome: 'gap', firstRetainedSequence: 5 } as never)
          : { events: [], hasMore: false, nextCursor: undefined };
      },
    });
    const stream = follow(bureau);
    const opening = await stream.next();
    const payload = opening.value?.payload as { value: { metadata: Record<string, any> } };
    const task = payload.value;
    expect(Object.values(task.metadata)[0]?.cursor).toBe('4');
    await stream.return(undefined);
  });

  it('sends every event before the one that ends the task, however fast they arrive', async () => {
    const { bureau, deliver, attached } = standIn({ getDelayMs: 20 });
    const stream = follow(bureau);
    await stream.next();
    const second = stream.next();
    await waitUntil(attached, { message: 'the stream to subscribe to the tail' });

    deliver(envelope(1, 'review.requested', { reviewId: 'review-1' }));
    deliver(envelope(2, 'review.approved', { reviewId: 'review-1' }));
    deliver(envelope(3, 'run.error', { message: 'boom' }));

    const read = await second;
    const rest = await drain(stream);
    const states = [read.value, ...rest].map((event) => {
      const payload = event?.payload as { value: { status?: { state: number } } } | undefined;
      return payload?.value.status?.state;
    });
    // The review opening and its closing both arrive ahead of the failure that ends the stream.
    expect(states.length).toBe(3);
  });

  it('sees a change made before the reader asks for the next event, and names the waits', async () => {
    const { bureau, change } = standIn({
      eventHistory: async () => ({ outcome: 'unsupported-capability' }) as never,
    });
    const stream = follow(bureau, undefined, {}, false);
    const snapshot = await stream.next();
    expect(snapshot.value?.payload?.$case).toBe('task');
    // The change lands between the snapshot and the next read.
    change({
      ...VIEW,
      status: 'input-required',
      updatedAt: '2026-10-22T00:00:01.000Z',
      openWaits: [{ kind: 'human-wait', reviewId: 'review-1', signalName: 'human-response' }],
    });
    const read = await stream.next();
    const next = read.value?.payload;
    expect(next.value.status.state).toBe(6); // TASK_STATE_INPUT_REQUIRED
    expect(next.value.status.message.metadata.signalNames).toEqual(['human-response']);
    await stream.return(undefined);
  });

  it('fails the stream when its history subscription closes on an error', async () => {
    const { bureau, close, attached } = standIn();
    const stream = follow(bureau);
    await stream.next();
    const second = stream.next();
    await waitUntil(attached, { message: 'the stream to subscribe to the tail' });
    close(new Error('the history failed'));
    expect(((await rejectionOf(second)) as Error).message).toBe('the history failed');
  });
});
