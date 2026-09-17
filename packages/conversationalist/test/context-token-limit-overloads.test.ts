import { describe, expect, it } from 'bun:test';

import { simpleTokenEstimator } from '../src/context';
import { truncateToTokenLimit } from '../src/context-truncation';
import {
  appendMessages,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import { isConversationEnvironmentParameter } from '../src/environment';
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

const estimator = () => 100;

describe('overloads', () => {
  it('handles messages with token usage during truncation', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'Hi there!',
        tokenUsage: { prompt: 10, completion: 5, total: 15 },
      },
      testEnvironment,
    );

    const truncated = truncateToTokenLimit(
      conv,
      1, // Very low limit
      {
        estimateTokens: simpleTokenEstimator,
        preserveLastN: 1,
      },
      testEnvironment,
    );

    // Should preserve tokenUsage in truncated messages
    const assistantMsg = getOrderedMessages(truncated).find((m) => m.role === 'assistant');
    if (assistantMsg) {
      expect(assistantMsg.tokenUsage).toBeDefined();
    }
  });

  it('works with a plain options object (not environment)', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(conv, { role: 'user', content: 'Hello' }, testEnvironment);
    conv = appendMessages(conv, { role: 'assistant', content: 'World' }, testEnvironment);

    // Tokens: Hello (2) + World (2) = 4
    const truncated = truncateToTokenLimit(conv, 2, { preserveLastN: 1 });
    expect(getOrderedMessages(truncated).length).toBe(1);
    expect(getOrderedMessages(truncated)[0]!.content).toBe('World');
  });

  it('works with no options or estimator provided', () => {
    let conv = createConversation({ id: 'test' });
    conv = appendMessages(conv, { role: 'user', content: 'Hello world' });

    const truncated = truncateToTokenLimit(conv, 1);
    expect(getOrderedMessages(truncated).length).toBe(0);
  });

  it('accepts a function as the third argument (overload)', () => {
    let conv = createConversation({ id: 'test' });
    conv = appendMessages(conv, { role: 'user', content: 'Hello' });

    const truncated = truncateToTokenLimit(conv, 1, () => 100);
    expect(getOrderedMessages(truncated).length).toBe(0);
  });

  it('accepts a conversation-level estimator in options', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Old' },
      { role: 'assistant', content: 'Middle' },
      { role: 'user', content: 'New' },
      testEnvironment,
    );
    const estimatorCalls: number[] = [];

    const truncated = truncateToTokenLimit(conv, 2, {
      estimateConversationTokens(messages) {
        estimatorCalls.push(messages.length);
        return messages.length;
      },
    });

    expect(estimatorCalls).toContain(3);
    expect(getOrderedMessages(truncated).map((message) => message.content)).toEqual([
      'Middle',
      'New',
    ]);
  });

  it('returns unchanged with a conversation-level estimator when under the token limit', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(conv, { role: 'user', content: 'Small' }, testEnvironment);

    const truncated = truncateToTokenLimit(conv, 10, {
      estimateConversationTokens: () => 1,
    });

    expect(truncated).toBe(conv);
  });

  it('keeps only locked messages when a conversation-level estimator says locked content fills the budget', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Old' },
      { role: 'assistant', content: 'Protected' },
      testEnvironment,
    );

    const truncated = truncateToTokenLimit(conv, 2, {
      estimateConversationTokens(messages) {
        return messages.length;
      },
      preserveLastN: 1,
    });

    expect(getOrderedMessages(truncated).map((message) => message.content)).toEqual([
      'System',
      'Protected',
    ]);
  });

  it('counts each retained candidate as a full conversation for provider-style estimators', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Old' },
      { role: 'assistant', content: 'Middle' },
      { role: 'user', content: 'New' },
      testEnvironment,
    );

    const truncated = truncateToTokenLimit(conv, 12, {
      estimateConversationTokens(messages) {
        return messages.length + 10;
      },
    });

    expect(getOrderedMessages(truncated).map((message) => message.content)).toEqual([
      'Middle',
      'New',
    ]);
  });

  it('returns only locked blocks when the first async conversation-estimator candidate is too large', async () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Old' },
      { role: 'assistant', content: 'New' },
      testEnvironment,
    );

    const truncated = await truncateToTokenLimit(conv, 0, {
      async estimateConversationTokens(messages) {
        return messages.length;
      },
    });

    expect(getOrderedMessages(truncated)).toEqual([]);
  });

  it('returns no messages when the first async conversation-estimator candidate exceeds a positive budget', async () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Old' },
      { role: 'assistant', content: 'New' },
      testEnvironment,
    );

    const truncated = await truncateToTokenLimit(conv, 1, {
      async estimateConversationTokens(messages) {
        return messages.length * 2;
      },
    });

    expect(getOrderedMessages(truncated)).toEqual([]);
  });

  it('accepts an async conversation-level estimator in options', async () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Old' },
      { role: 'assistant', content: 'Middle' },
      { role: 'user', content: 'New' },
      testEnvironment,
    );

    const truncated = await truncateToTokenLimit(conv, 2, {
      async estimateConversationTokens(messages) {
        return messages.length;
      },
    });

    expect(getOrderedMessages(truncated).map((message) => message.content)).toEqual([
      'Middle',
      'New',
    ]);
  });

  it('does not overwrite explicitly passed environment when options contain an estimator', () => {
    let conv = createConversation({ id: 'test' });
    conv = appendMessages(conv, { role: 'user', content: 'Hello' });

    const myEnv = {
      now: () => '2025-01-01T00:00:00.000Z',
      randomId: () => 'custom-id',
      estimateTokens: () => 1,
    };

    // If we pass an estimator in options AND an environment
    const truncated = truncateToTokenLimit(
      conv,
      10,
      { estimateTokens: () => 100 }, // This estimator should be used
      myEnv, // This environment should NOT be overwritten by the options object
    );

    // If it used myEnv.now(), the updatedAt should match.
    // truncateToTokenLimit re-creates messages if it truncates.
    // In this case, conv has 1 message.
    // If it uses options.estimateTokens (100), 100 > 10, so it truncates.
    // If it uses myEnv.estimateTokens (1), 1 <= 10, so it doesn't truncate.

    expect(getOrderedMessages(truncated).length).toBe(0); // Should have used the 100 tokens estimator
    expect(truncated.updatedAt).toBe('2025-01-01T00:00:00.000Z'); // Should have used myEnv.now()
  });

  it('correctly identifies TruncateOptions with only estimateTokens as options, not environment', () => {
    let conv = createConversation({ id: 'test' });
    conv = appendMessages(conv, { role: 'user', content: 'Hello' });

    // Every message is 100 tokens. 100 > 10, so it should truncate.

    const truncated = truncateToTokenLimit(conv, 10, { estimateTokens: estimator });

    // If it's correctly identified as options, it should truncate.
    // If it's incorrectly identified as environment, it will use the default estimator (character count / 4),
    // 'Hello' is 5 chars -> 2 tokens. 2 <= 10, so it won't truncate.
    expect(getOrderedMessages(truncated).length).toBe(0);
  });

  it('does not identify { plugins: [] } as an environment', () => {
    const options = { plugins: [] };
    expect(isConversationEnvironmentParameter(options)).toBe(false);
  });

  it('identifies maxHistoryDepth-only objects as an environment', () => {
    expect(isConversationEnvironmentParameter({ maxHistoryDepth: 5 })).toBe(true);
  });

  it('correctly uses environment when passed as 3rd argument with an estimator', () => {
    let conv = createConversation({ id: 'test' });
    conv = appendMessages(conv, { role: 'user', content: 'Hello' });

    const myEnv = {
      now: () => '2025-01-01T00:00:00.000Z',
      randomId: () => 'custom-id',
      estimateTokens: () => 100, // This should trigger truncation
    };

    // Pass environment as 3rd arg, 4th arg is undefined
    const truncated = truncateToTokenLimit(conv, 10, myEnv);

    expect(getOrderedMessages(truncated).length).toBe(0); // Truncated because 100 > 10
    expect(truncated.updatedAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('prioritizes environment fields over options fields when disambiguating', () => {
    let conv = createConversation({ id: 'test' });
    conv = appendMessages(conv, { role: 'user', content: 'Hello' });

    // This object has BOTH environment fields (now) AND fields that exist in options (estimateTokens)
    // The presence of 'now' should make it be treated as an environment, not options
    const ambiguousObject = {
      now: () => '2025-01-01T00:00:00.000Z',
      estimateTokens: () => 100,
    };

    const truncated = truncateToTokenLimit(conv, 10, ambiguousObject);

    // Should truncate using the environment's estimator
    expect(getOrderedMessages(truncated).length).toBe(0);
    // Should use the environment's now function (not default)
    expect(truncated.updatedAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('treats object with only estimateTokens as options when no environment fields present', () => {
    let conv = createConversation({ id: 'test' });
    conv = appendMessages(conv, { role: 'user', content: 'Hello' });

    // This object has only estimateTokens (no now/randomId/plugins)
    // Should be treated as TruncateOptions, not ConversationEnvironment
    const optionsObject = {
      estimateTokens: () => 100,
    };

    const truncated = truncateToTokenLimit(conv, 10, optionsObject);

    // Should truncate using the provided estimator
    expect(getOrderedMessages(truncated).length).toBe(0);
    // updatedAt should use default environment (current time), not a fixed time
    expect(truncated.updatedAt).not.toBe('2025-01-01T00:00:00.000Z');
  });
});
