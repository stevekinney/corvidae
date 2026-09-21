import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { describe, expect, test } from 'bun:test';
import {
  appendMessages,
  appendUserMessage,
  createConversationHistory as createConversation,
  deserializeConversationHistory as deserializeConversation,
} from '../src/conversation/index';
import { ConversationalistError } from '../src/errors';
import { getOrderedMessages } from '../src/utilities/message-store';

const runtime = createManualRuntimeServices();

describe('conversation serialization', () => {
  test('serialize and deserialize document multimodal content', () => {
    let c = createConversation();
    c = appendMessages(c, {
      role: 'user',
      content: [
        {
          type: 'document',
          name: 'requirements.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'base64', data: 'cGRm' },
        },
        {
          type: 'document',
          name: 'workspace-notes.md',
          mimeType: 'text/markdown',
          source: { kind: 'reference', uri: 'sandbox:/workspace/notes.md' },
        },
      ],
    });

    const restored = deserializeConversation(JSON.parse(JSON.stringify(c)));

    expect(restored.schemaVersion).toBe(5);
    expect(getOrderedMessages(restored)[0]?.content).toEqual([
      {
        type: 'document',
        name: 'requirements.pdf',
        mimeType: 'application/pdf',
        source: { kind: 'base64', data: 'cGRm' },
      },
      {
        type: 'document',
        name: 'workspace-notes.md',
        mimeType: 'text/markdown',
        source: { kind: 'reference', uri: 'sandbox:/workspace/notes.md' },
      },
    ]);
  });

  test('cacheBoundary survives a JSON serialization round trip', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'system', content: 'Stable prefix.', cacheBoundary: true },
      {
        role: 'user',
        content: 'Not a boundary',
      },
    );

    const restored = deserializeConversation(JSON.parse(JSON.stringify(c)));
    const [system, user] = getOrderedMessages(restored);

    expect(system?.cacheBoundary).toBe(true);
    expect(user?.cacheBoundary).toBeUndefined();
  });

  test('deserialize validation: position contiguity and tool references', () => {
    const now = runtime.clock.nowISO();
    // Position mismatch
    const badPos = {
      schemaVersion: 1,
      id: 'c',
      status: 'active' as const,
      metadata: {},
      ids: ['m1'],
      messages: {
        m1: {
          id: 'm1',
          role: 'user',
          content: 'x',
          position: 2,
          createdAt: now,
          metadata: {},
          hidden: false,
        },
      },
      createdAt: now,
      updatedAt: now,
    };
    expect(() => deserializeConversation(badPos)).toThrow(ConversationalistError);

    // Missing tool reference
    const badTool = {
      schemaVersion: 1,
      id: 'c2',
      status: 'active' as const,
      metadata: {},
      ids: ['t'],
      messages: {
        t: {
          id: 't',
          role: 'tool-result',
          content: 'x',
          position: 0,
          createdAt: now,
          metadata: {},
          hidden: false,
          toolResult: { callId: 'nope', outcome: 'error', content: {} },
        },
      },
      createdAt: now,
      updatedAt: now,
    };
    expect(() => deserializeConversation(badTool)).toThrow(ConversationalistError);
  });

  test('deserialize rejects invalid schema data', () => {
    expect(() => deserializeConversation({})).toThrow(ConversationalistError);
  });

  test('deserialize rejects missing messages and unlisted messages', () => {
    const now = runtime.clock.nowISO();
    const missingMessage = {
      schemaVersion: 1,
      id: 'c3',
      status: 'active' as const,
      metadata: {},
      ids: ['missing'],
      messages: {},
      createdAt: now,
      updatedAt: now,
    };
    expect(() => deserializeConversation(missingMessage)).toThrow(ConversationalistError);

    const unlistedMessage = {
      schemaVersion: 1,
      id: 'c4',
      status: 'active' as const,
      metadata: {},
      ids: [],
      messages: {
        m1: {
          id: 'm1',
          role: 'user',
          content: 'x',
          position: 0,
          createdAt: now,
          metadata: {},
          hidden: false,
        },
      },
      createdAt: now,
      updatedAt: now,
    };
    expect(() => deserializeConversation(unlistedMessage)).toThrow(ConversationalistError);
  });

  test('deserialize handles conversation input with metadata', () => {
    let c = createConversation({
      title: 'T',
      status: 'active',
      metadata: { source: 'x' },
    });
    c = appendUserMessage(c, 'hi', { foo: 1 });
    const restored = deserializeConversation(c);
    expect(restored.title).toBe('T');
    expect(getOrderedMessages(restored)[0]!.metadata['foo']).toBe(1);
    expect(restored.ids).toEqual(c.ids);
  });

  test('deserialize migrates legacy tool-use payloads', () => {
    const now = runtime.clock.nowISO();
    const legacy = {
      schemaVersion: 3,
      id: 'legacy',
      status: 'active' as const,
      metadata: {},
      ids: ['m1', 'm2'],
      messages: {
        m1: {
          id: 'm1',
          role: 'tool-use',
          content: '',
          position: 0,
          createdAt: now,
          metadata: {},
          hidden: false,
          toolCall: { id: 'call-1', name: 'weather', args: { location: 'Denver' } },
        },
        m2: {
          id: 'm2',
          role: 'tool-result',
          content: '',
          position: 1,
          createdAt: now,
          metadata: {},
          hidden: false,
          toolResult: { callId: 'call-1', outcome: 'success', result: { tempF: 72 } },
        },
      },
      createdAt: now,
      updatedAt: now,
    };

    const restored = deserializeConversation(legacy);
    const messages = getOrderedMessages(restored);

    expect(messages[0]?.role).toBe('tool-call');
    expect(messages[0]?.toolCall?.arguments).toEqual({ location: 'Denver' });
    expect(messages[1]?.toolResult?.content).toEqual({ tempF: 72 });
  });

  test('deserialize rejects non-object roots and malformed message entries', () => {
    expect(() => deserializeConversation(null)).toThrow(ConversationalistError);

    const now = runtime.clock.nowISO();
    const malformed = {
      schemaVersion: 5,
      id: 'malformed',
      status: 'active' as const,
      metadata: {},
      ids: ['m1'],
      messages: {
        m1: 'not-an-object',
      },
      createdAt: now,
      updatedAt: now,
    };

    expect(() => deserializeConversation(malformed)).toThrow(ConversationalistError);
  });

  test('deserialize with tool-call and tool-result preserves linkage', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      {
        role: 'tool-call',
        content: 'call',
        toolCall: { id: 'dc1', name: 't', arguments: {} },
      },
      {
        role: 'tool-result',
        content: 'ok',
        toolResult: { callId: 'dc1', outcome: 'success', content: {} },
      },
    );
    const restored = deserializeConversation(c);
    const restoredMessages = getOrderedMessages(restored);
    expect(restoredMessages.length).toBe(2);
    expect(restoredMessages[0]!.toolCall?.id).toBe('dc1');
    expect(restoredMessages[1]!.toolResult?.callId).toBe('dc1');
  });
});
