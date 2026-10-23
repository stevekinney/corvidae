import { describe, expect, test } from 'bun:test';
import type { ConversationHistory } from '../components/chat/conversation-model.ts';
import { decodeChatStreamEvent, encodeChatStreamEvent } from './stream-event-codec.ts';

const providerConversation = {
  schemaVersion: 8,
  id: 'conversation-1',
  status: 'active' as const,
  metadata: {},
  ids: ['m1', 'm2'],
  messages: {
    m1: {
      id: 'm1',
      role: 'assistant',
      content: '',
      position: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      metadata: {},
      hidden: false,
      toolCall: { id: 'call-1', name: 'lookup', arguments: {}, providerCallId: 'gemini-1' },
    },
    m2: {
      id: 'm2',
      role: 'tool-result',
      content: '',
      position: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      metadata: {},
      hidden: false,
      toolResult: {
        callId: 'call-1',
        outcome: 'success',
        content: 'ok',
        providerCallId: 'gemini-1',
      },
    },
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as unknown as ConversationHistory;

function completed(wireVersion: 1 | 2 | 3 | 4) {
  return {
    type: 'run.completed' as const,
    conversation: providerConversation,
    content: 'Done.',
    usage: { prompt: 1, completion: 1, total: 2 },
    finishReason: 'stop-condition',
    wireVersion,
    sequence: 5,
  };
}

describe('wire version 4 run.completed conversation schema (COR-1675)', () => {
  test('version 4 carries the schema 8 conversation losslessly', () => {
    const frame = JSON.parse(encodeChatStreamEvent(completed(4)));
    expect(frame.conversation.schemaVersion).toBe(8);
    expect(frame.conversation.messages.m1.toolCall.providerCallId).toBe('gemini-1');
    expect(decodeChatStreamEvent(encodeChatStreamEvent(completed(4)))).toEqual(completed(4));
  });

  for (const version of [1, 2, 3] as const) {
    test(`version ${version} projects a schema 7 conversation an older client accepts`, () => {
      const frame = JSON.parse(encodeChatStreamEvent(completed(version)));
      expect(frame.conversation.schemaVersion).toBe(7);
      expect(frame.conversation.messages.m1.toolCall).toEqual({
        id: 'call-1',
        name: 'lookup',
        arguments: {},
      });
      expect('providerCallId' in frame.conversation.messages.m2.toolResult).toBe(false);
    });
  }

  test('a schema 7 frame from an older server decodes as schema 8 on versions 1 to 3 only', () => {
    const legacy = JSON.parse(encodeChatStreamEvent(completed(3)));
    const decoded = decodeChatStreamEvent(legacy);
    expect(decoded.type === 'run.completed' && decoded.conversation.schemaVersion).toBe(8);
    expect(() => decodeChatStreamEvent({ ...legacy, wireVersion: 4 })).toThrow(
      'Invalid chat stream event',
    );
  });

  test('a version 1 to 3 frame labeled schema 7 but carrying providerCallId is refused', () => {
    const legacy = JSON.parse(encodeChatStreamEvent(completed(3)));
    legacy.conversation.messages.m1.toolCall.providerCallId = 'gemini-1';
    expect(() => decodeChatStreamEvent(legacy)).toThrow('Invalid chat stream event');
  });

  test('version 4 run.started and text deltas follow version 3', () => {
    const started = {
      type: 'run.started' as const,
      runId: 'r',
      wireVersion: 4 as const,
      sequence: 0,
    };
    expect(decodeChatStreamEvent(encodeChatStreamEvent(started))).toEqual(started);
    const delta = {
      type: 'stream:text-delta' as const,
      content: 'a',
      accumulated: 'a',
      messageId: 'm',
      wireVersion: 4 as const,
      sequence: 1,
    };
    expect(decodeChatStreamEvent(encodeChatStreamEvent(delta))).toEqual(delta);
  });
});
