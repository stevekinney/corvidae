import { describe, expect, it } from 'bun:test';

import {
  appendMessages,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import {
  appendStreamingMessage,
  cancelStreamingMessage,
  finalizeStreamingMessage,
  updateStreamingMessage,
} from '../src/streaming';
import type { ConversationHistory as Conversation, Message } from '../src/types';

const getOrderedMessages = (conversation: Conversation): Message[] =>
  conversation.ids
    .map((id) => conversation.messages[id])
    .filter((message): message is Message => Boolean(message));

const testEnvironment = {
  now: () => '2024-01-01T00:00:00.000Z',
  randomId: (() => {
    let counter = 0;
    return () => `test-id-${++counter}`;
  })(),
};

describe('updateStreamingMessage', () => {
  it('updates message content', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    const updated = updateStreamingMessage(conversation, messageId, 'Hello', testEnvironment);
    expect(getOrderedMessages(updated)[0]?.content).toBe('Hello');
  });

  it('replaces content on each update (for accumulation)', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    let updated = updateStreamingMessage(conversation, messageId, 'Hello', testEnvironment);
    updated = updateStreamingMessage(updated, messageId, 'Hello world', testEnvironment);

    expect(getOrderedMessages(updated)[0]?.content).toBe('Hello world');
  });

  it('returns unchanged conversation for unknown message ID', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation } = appendStreamingMessage(conv, 'assistant', undefined, testEnvironment);

    const updated = updateStreamingMessage(conversation, 'unknown-id', 'Content', testEnvironment);
    expect(updated).toBe(conversation);
  });

  it('supports multi-modal content updates', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    const updated = updateStreamingMessage(
      conversation,
      messageId,
      [{ type: 'text', text: 'Hello' }],
      testEnvironment,
    );

    expect(Array.isArray(getOrderedMessages(updated)[0]?.content)).toBe(true);
  });

  it('preserves token usage when updating content', () => {
    // A streaming placeholder that already carries token usage (a provider can
    // report usage mid-stream), so the update path has something to preserve.
    const conversation = appendMessages(
      createConversation({ id: 'test' }, testEnvironment),
      {
        role: 'assistant',
        content: '',
        metadata: { __streaming: true },
        tokenUsage: { prompt: 1, completion: 2, total: 3 },
      },
      testEnvironment,
    );
    const messageId = getOrderedMessages(conversation)[0]!.id;

    const updated = updateStreamingMessage(conversation, messageId, 'Updated', testEnvironment);

    expect(getOrderedMessages(updated)[0]?.content).toBe('Updated');
    expect(getOrderedMessages(updated)[0]?.tokenUsage).toEqual({
      prompt: 1,
      completion: 2,
      total: 3,
    });
  });

  it('ignores a late token that arrives after the message was finalized', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    const streamed = updateStreamingMessage(conversation, messageId, 'Frozen', testEnvironment);
    const finalized = finalizeStreamingMessage(
      streamed,
      messageId,
      { tokenUsage: { prompt: 1, completion: 2, total: 3 } },
      testEnvironment,
    );

    const late = updateStreamingMessage(finalized, messageId, 'Frozen and then some');

    // The very same conversation object comes back, so `updatedAt` cannot have
    // been bumped and no consumer holding a reference sees a change.
    expect(late).toBe(finalized);
    expect(late.updatedAt).toBe(finalized.updatedAt);
    expect(getOrderedMessages(late)[0]?.content).toBe('Frozen');
    expect(getOrderedMessages(late)[0]?.tokenUsage).toEqual({
      prompt: 1,
      completion: 2,
      total: 3,
    });
  });

  it('ignores a late token that arrives after the message was cancelled', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );

    const streamed = updateStreamingMessage(conversation, messageId, 'Partial', testEnvironment);
    const cancelled = cancelStreamingMessage(streamed, messageId, testEnvironment);

    const late = updateStreamingMessage(cancelled, messageId, 'Partial and then some');

    expect(late).toBe(cancelled);
    expect(late.ids).toHaveLength(0);
  });

  it('does not resurrect a non-streaming message that never streamed', () => {
    const conversation = appendMessages(
      createConversation({ id: 'test' }, testEnvironment),
      { role: 'assistant', content: 'Settled' },
      testEnvironment,
    );
    const messageId = getOrderedMessages(conversation)[0]!.id;

    const updated = updateStreamingMessage(conversation, messageId, 'Rewritten', testEnvironment);

    expect(updated).toBe(conversation);
    expect(getOrderedMessages(updated)[0]?.content).toBe('Settled');
  });

  it('does not read the injected clock when it rejects a late token', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );
    const finalized = finalizeStreamingMessage(
      updateStreamingMessage(conversation, messageId, 'Frozen', testEnvironment),
      messageId,
      undefined,
      testEnvironment,
    );

    let clockReads = 0;
    const countingEnvironment = {
      ...testEnvironment,
      now: () => {
        clockReads += 1;
        return testEnvironment.now();
      },
    };

    // Rejected: the target is finalized, and the id is unknown.
    updateStreamingMessage(finalized, messageId, 'Late', countingEnvironment);
    updateStreamingMessage(finalized, 'no-such-message', 'Late', countingEnvironment);
    expect(clockReads).toBe(0);

    // Accepted updates still stamp `updatedAt`, so the clock is read exactly once.
    updateStreamingMessage(conversation, messageId, 'Streaming', countingEnvironment);
    expect(clockReads).toBe(1);
  });

  it('does not propagate a throwing clock when it rejects a late token', () => {
    const conv = createConversation({ id: 'test' }, testEnvironment);
    const { conversation, messageId } = appendStreamingMessage(
      conv,
      'assistant',
      undefined,
      testEnvironment,
    );
    const finalized = finalizeStreamingMessage(conversation, messageId, undefined, testEnvironment);

    const explodingEnvironment = {
      ...testEnvironment,
      now: (): string => {
        throw new Error('clock should not be read for a rejected update');
      },
    };

    expect(updateStreamingMessage(finalized, messageId, 'Late', explodingEnvironment)).toBe(
      finalized,
    );
  });
});
