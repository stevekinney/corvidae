import { describe, expect, it } from 'bun:test';

import { estimateConversationTokens, simpleTokenEstimator } from '../src/context';
import {
  appendMessages,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import { createMessage } from '../src/utilities';

const testEnvironment = {
  now: () => '2024-01-01T00:00:00.000Z',
  randomId: (() => {
    let counter = 0;
    return () => `test-id-${++counter}`;
  })(),
};

describe('token estimation', () => {
  it('sums token estimates for all messages', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'Hello' }, // 5 chars
      { role: 'assistant', content: 'Hi there' }, // 8 chars
      testEnvironment,
    );

    const tokens = estimateConversationTokens(conv, simpleTokenEstimator);
    // simpleTokenEstimator uses ~4 chars per token
    expect(tokens).toBeGreaterThan(0);
  });

  it('counts structural blocks (thinking/tool/result) toward the estimate, not just text', () => {
    let textOnly = createConversation({ id: 'a' }, testEnvironment);
    textOnly = appendMessages(textOnly, { role: 'assistant', content: 'hi' }, testEnvironment);

    let withThinking = createConversation({ id: 'b' }, testEnvironment);
    withThinking = appendMessages(
      withThinking,
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hi' },
          // A large thinking payload must NOT estimate as ~zero tokens.
          { type: 'thinking', thinking: 'x'.repeat(400), signature: 'sig' },
        ],
      },
      testEnvironment,
    );

    const textTokens = estimateConversationTokens(textOnly, simpleTokenEstimator);
    const thinkingTokens = estimateConversationTokens(withThinking, simpleTokenEstimator);
    // The 400-char thinking block adds ~100 tokens over the text-only message.
    expect(thinkingTokens).toBeGreaterThan(textTokens + 90);
  });

  it('uses estimator from environment when only environment is provided', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(conv, { role: 'user', content: 'Hello world' }, testEnvironment);

    const tokens = estimateConversationTokens(conv, undefined, testEnvironment);
    expect(tokens).toBe(3); // 'Hello world' is 11 chars -> 3 tokens
  });

  it('uses default estimator when no estimator or environment is provided', () => {
    let conv = createConversation({ id: 'test' });
    conv = appendMessages(conv, { role: 'user', content: 'Hello world' });

    const tokens = estimateConversationTokens(conv);
    expect(tokens).toBe(3);
  });

  it('accepts a conversation-level estimator over ordered messages', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Second' },
      testEnvironment,
    );

    const tokens = estimateConversationTokens(conv, {
      estimateConversationTokens(messages) {
        expect(messages.map((message) => message.content)).toEqual(['First', 'Second']);
        return messages.length * 10;
      },
    });

    expect(tokens).toBe(20);
  });

  it('prefers a conversation-level estimator when options also include a message estimator', () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(conv, { role: 'user', content: 'First' }, testEnvironment);

    const tokens = estimateConversationTokens(conv, {
      estimateTokens: () => 100,
      estimateConversationTokens: () => 5,
    });

    expect(tokens).toBe(5);
  });

  it('accepts an async conversation-level estimator over ordered messages', async () => {
    let conv = createConversation({ id: 'test' }, testEnvironment);
    conv = appendMessages(
      conv,
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Second' },
      testEnvironment,
    );

    const tokens = await estimateConversationTokens(conv, {
      async estimateConversationTokens(messages) {
        expect(messages.map((message) => message.content)).toEqual(['First', 'Second']);
        return messages.length * 20;
      },
    });

    expect(tokens).toBe(40);
  });
});

describe('simpleTokenEstimator', () => {
  it('estimates tokens based on character count', () => {
    const message = createMessage({
      id: 'test',
      role: 'user',
      content: 'Hello world', // 11 chars
      position: 0,
      createdAt: '2024-01-01T00:00:00.000Z',
      metadata: {},
      hidden: false,
    });

    const tokens = simpleTokenEstimator(message);
    // 11 chars / 4 = 2.75, ceil = 3
    expect(tokens).toBe(3);
  });

  it('counts base64 and referenced document payloads', () => {
    const message = createMessage({
      id: 'documents',
      role: 'user',
      content: [
        {
          type: 'document',
          name: 'inline.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'base64', data: 'cGRm' },
        },
        {
          type: 'document',
          name: 'remote.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'reference', uri: 'https://example.com/remote.pdf' },
        },
      ],
      position: 0,
      createdAt: '2024-01-01T00:00:00.000Z',
      metadata: {},
      hidden: false,
    });

    expect(simpleTokenEstimator(message)).toBe(21);
  });
});
