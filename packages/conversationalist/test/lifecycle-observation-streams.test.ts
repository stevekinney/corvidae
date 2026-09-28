import { describe, expect, it } from 'bun:test';

import { Conversation } from '../src/history';
import { createConversationHistory, defineMessagePlugin } from '../src/index';
import { rejectionOf } from '../src/testing/promise-outcome.test-support.ts';
import type { MessagePluginIdentity } from '../src/types';

describe('lifecycle streams and plugins', () => {
  it('revision-fences asynchronous tool-result streams', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'tool-race' }));
    conversation.appendToolCall({ id: 'call-1', name: 'lookup', arguments: {} });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const append = conversation.appendToolResultAsync({
      callId: 'call-1',
      outcome: 'success',
      content: [],
      stream: {
        async *[Symbol.asyncIterator]() {
          await waiting;
          yield { value: 'late' };
        },
      },
    });
    conversation.appendUserMessage('newer revision');
    release();

    expect(await rejectionOf(append)).toMatchObject({ code: 'error:revision-conflict' });
    expect(conversation.getPendingToolCalls()).toHaveLength(1);
  });

  it('actively closes owned tool-result iterators during disposal', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'tool-abort' }));
    let iteratorClosed = false;
    let nextCalled = false;
    const append = conversation.appendToolResultAsync({
      callId: 'call-1',
      outcome: 'success',
      content: [],
      stream: {
        [Symbol.asyncIterator]() {
          return {
            next() {
              nextCalled = true;
              return new Promise<IteratorResult<unknown>>(() => {});
            },
            async return() {
              iteratorClosed = true;
              return { done: true, value: undefined };
            },
          };
        },
      },
    });
    await Promise.resolve();
    expect(nextCalled).toBe(true);

    await conversation.dispose();

    expect(await rejectionOf(append)).toMatchObject({ code: 'error:operation-cancelled' });
    expect(iteratorClosed).toBe(true);
  });

  it('gives plugins stable identity, fixed authority, and activation and failure events', () => {
    const failing = defineMessagePlugin({ id: 'policy', revision: 3 }, () => {
      throw new Error('blocked');
    });
    const conversation = new Conversation(createConversationHistory({ id: 'plugins' }), {
      plugins: [failing],
    });
    const events: Array<{ type: string; plugin?: MessagePluginIdentity | undefined }> = [];
    conversation.addEventListener('plugin.activated', (event) => events.push(event));
    conversation.addEventListener('plugin.failed', (event) => events.push(event));

    expect(conversation.plugins).toEqual([
      { id: 'policy', revision: 3, authority: 'transcript-transform' },
    ]);
    expect(() => conversation.appendUserMessage('secret')).toThrow('blocked');
    expect(events.map(({ type }) => type)).toEqual(['plugin.activated', 'plugin.failed']);
    expect(events[1]?.plugin).toEqual({
      id: 'policy',
      revision: 3,
      authority: 'transcript-transform',
    });
    expect(
      () => new Conversation(createConversationHistory(), { plugins: [failing, failing] }),
    ).toThrow('Duplicate message plugin identity: policy');
    expect(() => defineMessagePlugin({ id: '', revision: 1 }, (input) => input)).toThrow(
      'Message plugin identity requires a non-empty id and a positive integer revision',
    );
    expect(() => defineMessagePlugin({ id: 'invalid', revision: 0 }, (input) => input)).toThrow(
      'Message plugin identity requires a non-empty id and a positive integer revision',
    );
    expect(
      () =>
        new Conversation(createConversationHistory(), {
          plugins: [
            () => {
              throw new Error('invalid plugin');
            },
          ],
        }),
    ).toThrow('requires an explicit id and revision');
    expect(
      () =>
        new Conversation(createConversationHistory(), {
          plugins: [
            Object.assign(
              () => {
                throw new Error('invalid plugin');
              },
              { id: 'invalid', revision: 0 },
            ),
          ],
        }),
    ).toThrow('requires an explicit id and revision');
  });

  it('makes the committed snapshot visible inside transition event callbacks', () => {
    const conversation = new Conversation(createConversationHistory({ id: 'event-snapshot' }));
    const snapshots: Array<{ revision: number; eventRevision: number; sameState: boolean }> = [];
    conversation.getSnapshot();
    conversation.addEventListener('change', (event) => {
      const snapshot = conversation.getSnapshot();
      snapshots.push({
        revision: snapshot.revision,
        eventRevision: event.revision,
        sameState: snapshot.conversation === event.conversation,
      });
    });

    conversation.appendUserMessage('current during dispatch');

    expect(snapshots).toEqual([{ revision: 1, eventRevision: 1, sameState: true }]);
  });

  it('delivers disposed after closed through the lifecycle event channel', async () => {
    const conversation = new Conversation(createConversationHistory({ id: 'lifecycle-events' }));
    const events: string[] = [];
    conversation.addEventListener('controller.closed', (event) => events.push(event.type));
    conversation.addEventListener('controller.disposed', (event) => events.push(event.type));

    conversation.close();
    await conversation.dispose();

    expect(events).toEqual(['controller.closed', 'controller.disposed']);
  });

  it('keeps plugin lifecycle events isolated to a fork', () => {
    const plugin = defineMessagePlugin({ id: 'fork-policy', revision: 1 }, (input) => input);
    const parent = new Conversation(createConversationHistory({ id: 'plugin-parent' }), {
      plugins: [plugin],
    });
    const child = parent.fork();
    const parentEvents: string[] = [];
    const childEvents: string[] = [];
    parent.addEventListener('plugin.activated', (event) => parentEvents.push(event.type));
    child.addEventListener('plugin.activated', (event) => childEvents.push(event.type));

    child.appendUserMessage('child only');
    child.appendUserMessage('activation remains one-time');

    expect(parentEvents).toEqual([]);
    expect(childEvents).toEqual(['plugin.activated']);
  });

  it('uses distinct sequences and one correlation for paired transitions', () => {
    const conversation = new Conversation(createConversationHistory({ id: 'paired-events' }));
    conversation.appendUserMessage('undo target');
    const events: Array<{ type: string; sequence: number; correlationId: string }> = [];
    conversation.addEventListener('change', (event) => events.push(event));
    conversation.addEventListener('undo', (event) => events.push(event));

    conversation.undo();

    expect(events.map(({ type }) => type)).toEqual(['change', 'undo']);
    expect(events[0]!.sequence).not.toBe(events[1]!.sequence);
    expect(events[0]!.correlationId).toBe(events[1]!.correlationId);

    const forkEvents: Array<{ sequence: number; correlationId: string }> = [];
    conversation.addEventListener('session.forked', (event) => forkEvents.push(event));
    conversation.addEventListener('change', (event) => forkEvents.push(event));
    conversation.fork();
    expect(forkEvents[0]!.sequence).not.toBe(forkEvents[1]!.sequence);
    expect(forkEvents[0]!.correlationId).toBe(forkEvents[1]!.correlationId);
  });

  it('preserves stream sequence counters across history navigation', () => {
    const conversation = new Conversation(createConversationHistory({ id: 'stream-revival' }));
    const sequences: number[] = [];
    conversation.addEventListener('stream.updated', (event) =>
      sequences.push(event.streamSequence!),
    );
    const messageId = conversation.appendStreamingMessage('assistant');
    conversation.updateStreamingMessage(messageId, 'first');
    conversation.finalizeStreamingMessage(messageId);
    conversation.undo();
    conversation.updateStreamingMessage(messageId, 'second');

    expect(sequences).toEqual([1, 2]);
  });
});
