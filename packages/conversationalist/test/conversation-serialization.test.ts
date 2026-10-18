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
import { CURRENT_SCHEMA_VERSION } from '../src/versioning';

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
          source: { kind: 'inline', data: 'cGRm', encoding: 'base64' },
        },
        {
          type: 'document',
          name: 'workspace-notes.md',
          mimeType: 'text/markdown',
          source: { kind: 'local-file', path: '/workspace/notes.md' },
        },
      ],
    });

    const restored = deserializeConversation(JSON.parse(JSON.stringify(c)));

    expect(restored.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(getOrderedMessages(restored)[0]?.content).toEqual([
      {
        type: 'document',
        name: 'requirements.pdf',
        mimeType: 'application/pdf',
        source: { kind: 'inline', data: 'cGRm', encoding: 'base64' },
      },
      {
        type: 'document',
        name: 'workspace-notes.md',
        mimeType: 'text/markdown',
        source: { kind: 'local-file', path: '/workspace/notes.md' },
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
      schemaVersion: CURRENT_SCHEMA_VERSION,
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
      schemaVersion: CURRENT_SCHEMA_VERSION,
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
      schemaVersion: CURRENT_SCHEMA_VERSION,
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
      schemaVersion: CURRENT_SCHEMA_VERSION,
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

  test('deserialize refuses a payload stored under another schema version', () => {
    const now = runtime.clock.nowISO();
    const stored = (schemaVersion: number, content: unknown) => ({
      schemaVersion,
      id: 'stored',
      status: 'active' as const,
      metadata: {},
      ids: ['m1'],
      messages: {
        m1: {
          id: 'm1',
          role: 'user',
          content,
          position: 0,
          createdAt: now,
          metadata: {},
          hidden: false,
        },
      },
      createdAt: now,
      updatedAt: now,
    });

    // Version 5 stored an image as `{ type: 'image', url }`. It is refused by
    // version, never dual-read and never reported as a malformed payload.
    for (const schemaVersion of [1, 3, CURRENT_SCHEMA_VERSION - 1, CURRENT_SCHEMA_VERSION + 1]) {
      const payload = stored(schemaVersion, [{ type: 'image', url: 'https://example.com/a.png' }]);
      let thrown: unknown;
      try {
        deserializeConversation(payload);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConversationalistError);
      expect((thrown as ConversationalistError).code).toBe('error:unsupported-schema-version');
      expect((thrown as ConversationalistError).context).toEqual({
        schemaVersion,
        expected: CURRENT_SCHEMA_VERSION,
      });
    }
  });

  test('deserialize rejects non-object roots and malformed message entries', () => {
    expect(() => deserializeConversation(null)).toThrow(ConversationalistError);

    const now = runtime.clock.nowISO();
    const malformed = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
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
