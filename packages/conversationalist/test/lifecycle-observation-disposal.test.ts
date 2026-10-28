import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { Conversation } from '../src/history';
import { appendUserMessage, createConversationHistory, defineMessagePlugin } from '../src/index';

describe('lifecycle disposal and mutations', () => {
  it('honors caller cancellation when an async tool-result stream is blocked', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'caller-abort' }));
    const controller = new AbortController();
    let iteratorClosed = false;
    const append = conversation.appendToolResultAsync(
      {
        callId: 'call-1',
        outcome: 'success',
        content: [],
        stream: {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<unknown>>(() => {}),
              async return() {
                iteratorClosed = true;
                return { done: true, value: undefined };
              },
            };
          },
        },
      },
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort('caller stopped');

    expect(await rejectionOf(append)).toMatchObject({ name: 'AbortError' });
    expect(iteratorClosed).toBe(true);
  });

  it('rejects malformed external histories without throwing', () => {
    const conversation = new Conversation(createConversationHistory({ id: 'external-shape' }));
    const malformed = {
      ...conversation.current,
      ids: ['missing-message'],
    };

    expect(
      conversation.reconcileExternalSnapshot({
        conversation: malformed,
        revision: 1,
        lifecycle: 'open',
      }),
    ).toEqual({ accepted: false, revision: 0, reason: 'invalid-external-snapshot' });
  });

  it('reports truthful compaction outcomes and honors caller cancellation after summary', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'compact-outcomes' }));
    for (let index = 0; index < 8; index++) conversation.appendUserMessage(`message ${index}`);
    const outcomes: Array<[string, string]> = [];
    conversation.addEventListener('compaction.started', (event) =>
      outcomes.push([event.type, event.outcome]),
    );
    conversation.addEventListener('compaction.cancelled', (event) =>
      outcomes.push([event.type, event.outcome]),
    );
    const controller = new AbortController();

    const compacting = conversation.compact(
      async () => {
        controller.abort('caller stopped');
        return 'summary despite cancellation';
      },
      { signal: controller.signal },
    );

    expect(await rejectionOf(compacting)).toMatchObject({ code: 'error:operation-cancelled' });
    expect(outcomes).toEqual([
      ['compaction.started', 'started'],
      ['compaction.cancelled', 'cancelled'],
    ]);
  });

  it('delivers snapshot.restored after callers can subscribe', async () => {
    const source = new Conversation(createConversationHistory({ id: 'restored-event' }));
    source.appendUserMessage('persisted');
    const restored = Conversation.from(source.snapshot());
    const events: string[] = [];
    restored.addEventListener('snapshot.restored', (event) => events.push(event.type));

    await Promise.resolve();

    expect(events).toEqual(['snapshot.restored']);
  });

  it('announces plugin activation only after the owning mutation commits', () => {
    const plugin = defineMessagePlugin({ id: 'reentrant-plugin', revision: 1 }, (input) => input);
    const conversation = new Conversation(createConversationHistory({ id: 'plugin-order' }), {
      plugins: [plugin],
    });
    conversation.addEventListener('plugin.activated', () => {
      conversation.appendAssistantMessage('listener write');
    });

    conversation.appendUserMessage('outer write');

    expect(conversation.current.ids.map((id) => conversation.current.messages[id]!.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('registers compaction as owned work before announcing it', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'compact-order' }));
    for (let index = 0; index < 8; index++) conversation.appendUserMessage(`message ${index}`);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let disposal!: Promise<void>;
    conversation.addEventListener('compaction.started', () => {
      disposal = conversation.dispose();
    });
    const compacting = conversation.compact(async () => {
      await waiting;
      return 'late summary';
    });

    expect(conversation.inFlightOperationCount).toBe(1);
    release();
    expect(await rejectionOf(compacting)).toMatchObject({ code: 'error:operation-cancelled' });
    await disposal;
    expect(conversation.inFlightOperationCount).toBe(0);
  });

  it('rejects a mutation result when its callback writes reentrantly', () => {
    const conversation = new Conversation(createConversationHistory({ id: 'mutation-reentrant' }));

    const result = conversation.applyMutation({ expectedRevision: 0 }, (state) => {
      conversation.appendAssistantMessage('reentrant write');
      return appendUserMessage(state, 'stale callback result');
    });

    expect(result).toEqual({ accepted: false, revision: 1, reason: 'revision-conflict' });
    expect(conversation.current.ids.map((id) => conversation.current.messages[id]!.role)).toEqual([
      'assistant',
    ]);
  });
});
