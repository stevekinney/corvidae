import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  appendStreamingMessage,
  cancelStreamingMessage,
  createConversation,
  finalizeStreamingMessage,
  updateStreamingMessage,
} from './index.ts';

describe('public chat streaming builders', () => {
  test('re-exports streaming builders that keep a snapshot synchronized', () => {
    const environment = {
      now: () => '2026-07-17T00:00:00.000Z',
      randomId: () => 'assistant-stream',
    };
    const initial = createConversation({ id: 'streaming-export' });
    const started = appendStreamingMessage(initial, 'assistant', undefined, environment);

    const updated = updateStreamingMessage(
      started.conversation,
      started.messageId,
      'Hello',
      environment,
    );
    expect(updated.messages[started.messageId]?.content).toBe('Hello');

    const finalized = finalizeStreamingMessage(updated, started.messageId, undefined, environment);
    expect(finalized.messages[started.messageId]?.content).toBe('Hello');

    const cancelled = cancelStreamingMessage(started.conversation, started.messageId, environment);
    expect(cancelled.ids).toEqual([]);
  });

  test('private harness uses the public streaming lifecycle for content-driven streams', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, 'chat-private-harness.fixture.svelte'),
      'utf8',
    );

    expect(source).toContain("appendStreamingMessage(conversation, 'assistant')");
    expect(source).toContain('updateStreamingMessage(conversation, streamingMessageId');
    expect(source).toContain('finalizeStreamingMessage(conversation, streamingMessageId');
    expect(source).toContain('cancelStreamingMessage(conversation, streamingMessageId');
    expect(source).not.toContain("appendAssistantMessage(conversation, '')");
  });
});
