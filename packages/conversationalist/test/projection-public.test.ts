import { describe, expect, it } from 'bun:test';

import {
  appendMessages,
  type ConversationEnvironment,
  createConversationHistory,
} from '../src/conversation/index';
import { createPublicConversationProjection } from '../src/projection';
import type { ConversationHistory } from '../src/types';

const createTestEnvironment = (): Partial<ConversationEnvironment> => {
  let counter = 0;
  return {
    now: () => '2026-01-01T00:00:00.000Z',
    randomId: () => `projection-test-${++counter}`,
  };
};

const createSeed = (): ConversationHistory =>
  createConversationHistory({ id: 'projection-test' }, createTestEnvironment());

describe('createPublicConversationProjection', () => {
  it('keeps only redacted visible text and excludes privileged transcript data', () => {
    const environment = createTestEnvironment();
    const withVisibleMessage = appendMessages(
      createConversationHistory(
        {
          id: 'tenant-a',
          title: 'Account for person@example.com',
          metadata: { credential: 'server-secret', managedAssetGrant: 'asset-secret' },
        },
        environment,
      ),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Email person@example.com or call 303-555-0100.' },
          { type: 'thinking', thinking: 'provider-private reasoning', signature: 'signature' },
          {
            type: 'server_tool_use',
            id: 'server-tool',
            name: 'lookup',
            input: { token: 'privileged-tool-input' },
          },
          {
            type: 'image',
            source: { kind: 'remote-url', url: 'https://assets.example/private-grant' },
            alt: 'private image',
          },
        ],
        metadata: { personalData: 'private-person' },
        toolCall: { id: 'tool-call', name: 'lookup', arguments: { secret: 'argument' } },
        tokenUsage: { prompt: 1, completion: 1, total: 2 },
      },
      environment,
    );
    const conversation = appendMessages(
      withVisibleMessage,
      { role: 'assistant', content: 'hidden secret', hidden: true },
      { role: 'system', content: 'server-only system instruction' },
      { role: 'developer', content: 'server-only developer instruction' },
      {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'private-call', name: 'lookup', arguments: { secret: 'argument' } },
      },
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'private-call', outcome: 'success', content: 'private result' },
      },
      environment,
    );

    const projection = createPublicConversationProjection(conversation);
    const serialized = JSON.stringify(projection);

    expect(projection.ids).toHaveLength(1);
    expect(projection.metadata).toEqual({});
    expect(projection.title).toBe('Account for [EMAIL_REDACTED]');
    expect(projection.messages[projection.ids[0]!]!.content).toEqual([
      { type: 'text', text: 'Email [EMAIL_REDACTED] or call [PHONE_REDACTED].' },
    ]);
    for (const forbidden of [
      'server-secret',
      'asset-secret',
      'private-person',
      'provider-private reasoning',
      'privileged-tool-input',
      'https://assets.example/private-grant',
      'hidden secret',
      'server-only system instruction',
      'server-only developer instruction',
      'argument',
      'private result',
      'signature',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.messages[projection.ids[0]!]!)).toBe(true);
  });

  it('applies domain redaction in addition to mandatory default redaction', () => {
    const conversation = appendMessages(
      createSeed(),
      {
        role: 'assistant',
        content: 'Email person@example.com about account 123-456.',
      },
      createTestEnvironment(),
    );

    const projection = createPublicConversationProjection(conversation, {
      redactText: (text) => text.replace('123-456', '[ACCOUNT_REDACTED]'),
    });

    expect(projection.messages[projection.ids[0]!]!.content).toBe(
      'Email [EMAIL_REDACTED] about account [ACCOUNT_REDACTED].',
    );
  });
});
