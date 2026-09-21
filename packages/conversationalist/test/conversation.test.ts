import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { describe, expect, test } from 'bun:test';
import {
  appendAssistantMessage,
  appendMessages,
  appendUserMessage,
  createConversationHistory as createConversation,
  getMessageAtPosition,
  getMessageById,
  getMessageIds,
  getMessages,
  getStatistics,
  searchConversationMessages,
  toChatMessages,
} from '../src/conversation/index';
import { ConversationalistError } from '../src/errors';
import { getOrderedMessages } from '../src/utilities/message-store';

const runtime = createManualRuntimeServices();

describe('conversation functional queries and appends', () => {
  test('create, append, statistics and encode', () => {
    let c = createConversation({ title: 'Demo' });
    c = appendUserMessage(c, 'hello');
    c = appendAssistantMessage(c, [
      { type: 'text', text: 'ok' },
      { type: 'image', url: 'https://example.com/i.png' },
    ]);

    const stats = getStatistics(c);
    expect(stats.total).toBe(2);
    expect(stats.byRole['user']).toBe(1);
    expect(stats.withImages).toBe(1);

    const external = toChatMessages(c);
    expect(external.length).toBe(2);
    expect(external[0]!.role).toBe('user');
  });

  test('rejects non-JSON metadata payloads', () => {
    const c = createConversation();
    expect(() =>
      Reflect.apply(appendMessages, undefined, [
        c,
        {
          role: 'user',
          content: 'hello',
          metadata: { when: new Date(runtime.clock.now()) },
        },
      ]),
    ).toThrow(ConversationalistError);
  });

  test('getMessages includeHidden and lookup helpers', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'system', content: 's', metadata: { v: 1 } },
      { role: 'user', content: 'u', hidden: true },
    );
    const visible = getMessages(c);
    expect(visible.length).toBe(1);
    const all = getMessages(c, { includeHidden: true });
    expect(all.length).toBe(2);
    expect(getMessageAtPosition(c, 1)?.role).toBe('user');
    const id = all[0]!.id;
    expect(getMessageById(c, id)?.id).toBe(id);
    expect(getMessageIds(c)).toEqual(all.map((message) => message.id));
    expect(searchConversationMessages(c, (m) => m.role === 'system').length).toBe(1);
  });

  test('toChatMessages role mapping and filtering', () => {
    let c = createConversation();
    c = appendMessages(
      c,
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
      { role: 'system', content: 's' },
      { role: 'developer', content: 'd' },
      {
        role: 'tool-call',
        content: 'fc',
        toolCall: { id: 'c1', name: 't', arguments: {} },
      },
      {
        role: 'tool-result',
        content: 'tr',
        toolResult: { callId: 'c1', outcome: 'success', content: {} },
      },
      { role: 'snapshot', content: 'snap' },
      { role: 'user', content: 'hidden', hidden: true },
    );
    const ext = toChatMessages(c);
    // hidden filtered -> 7 messages
    expect(ext.length).toBe(7);
    // spot check some roles
    expect(ext[0]!.role).toBe('user');
    expect(ext[1]!.role).toBe('assistant');
    expect(ext[2]!.role).toBe('system');
  });

  test('appendMessages respects injected environment for ids and timestamps', () => {
    const env = {
      now: () => '2000-01-01T00:00:00.000Z',
      randomId: () => 'custom-id',
    };
    const base = createConversation();
    const next = appendMessages(base, { role: 'user', content: 'hello' }, env);
    const messages = getOrderedMessages(next);
    expect(messages[0]!.id).toBe('custom-id');
    expect(messages[0]!.createdAt).toBe('2000-01-01T00:00:00.000Z');
    expect(next.updatedAt).toBe('2000-01-01T00:00:00.000Z');
  });

  test('appendMessages can be invoked without inputs', () => {
    const base = createConversation();
    const next = appendMessages(base);
    expect(next.ids.length).toBe(0);
    expect(next).not.toBe(base);
  });

  test('appendMessages accepts only an environment argument', () => {
    const base = createConversation();
    const env = { now: () => '2024-05-05T05:05:05.000Z' };
    const next = appendMessages(base, env);
    expect(next.ids.length).toBe(0);
    expect(next.updatedAt).toBe('2024-05-05T05:05:05.000Z');
  });
});
