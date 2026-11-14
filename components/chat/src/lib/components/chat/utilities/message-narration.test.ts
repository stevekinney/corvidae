import { describe, expect, test } from 'bun:test';

import type { Message } from '../conversation-model.ts';
import { classifyAssistantText } from './message-narration.ts';

function message(overrides: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  return {
    content: '',
    createdAt: '2026-05-04T12:00:00.000Z',
    hidden: false,
    metadata: {},
    position: 1,
    ...overrides,
  } satisfies Message;
}

const user = (id: string): Message => message({ id, role: 'user', content: 'Check the ledger' });
const text = (id: string, content = `Text of ${id}`): Message =>
  message({ id, role: 'assistant', content });
const call = (id: string, extra: Partial<Message> = {}): Message =>
  message({
    id,
    role: 'tool-call',
    toolCall: { id: `${id}-call`, name: 'lookup', arguments: {} },
    ...extra,
  });
const result = (id: string, callId: string): Message =>
  message({
    id,
    role: 'tool-result',
    toolResult: { callId, outcome: 'success', content: { ok: true } },
  });

function roles(messages: Message[]): Record<string, string> {
  return Object.fromEntries(classifyAssistantText(messages));
}

describe('classifyAssistantText', () => {
  test('a turn with no tools has only an answer', () => {
    expect(roles([user('u'), text('a')])).toEqual({ a: 'answer' });
  });

  test('text, tool, text: the first is narration and the last the answer', () => {
    expect(roles([user('u'), text('n'), call('c'), text('a')])).toEqual({
      n: 'narration',
      a: 'answer',
    });
  });

  test('text, tool, text, tool, text: both leading texts are narration', () => {
    expect(roles([user('u'), text('n1'), call('c1'), text('n2'), call('c2'), text('a')])).toEqual({
      n1: 'narration',
      n2: 'narration',
      a: 'answer',
    });
  });

  test('a tool result counts as a tool message', () => {
    expect(roles([user('u'), text('n'), result('r', 'x')])).toEqual({ n: 'narration' });
  });

  test('text then a pending approval is narration', () => {
    const pending = call('c');
    const approval = message({
      id: 'r',
      role: 'tool-result',
      toolResult: {
        callId: 'c-call',
        outcome: 'action_required',
        action: { type: 'approval', message: 'Send the email?' },
      } as Message['toolResult'],
    });
    expect(roles([user('u'), text('n'), pending, approval])).toEqual({ n: 'narration' });
  });

  test('a turn that stopped after narration and a tool has narration and no answer', () => {
    expect(roles([user('u'), text('n'), call('c')])).toEqual({ n: 'narration' });
  });

  test('text with no tool after it stays an answer while it streams, and demotes when a tool follows', () => {
    const streaming = [user('u'), text('t', 'Reading the ledger')];
    expect(roles(streaming)).toEqual({ t: 'answer' });
    expect(roles([...streaming, call('c')])).toEqual({ t: 'narration' });
  });

  test('turns are independent: an earlier turn tool never demotes a later turn answer', () => {
    expect(roles([user('u1'), text('a1'), user('u2'), call('c'), text('a2')])).toEqual({
      a1: 'answer',
      a2: 'answer',
    });
  });

  test('an edited or regenerated turn is read from the messages it holds now', () => {
    const before = [user('u'), text('n'), call('c'), text('old-answer')];
    expect(roles(before)['old-answer']).toBe('answer');
    const regenerated = [user('u'), text('new-answer')];
    expect(roles(regenerated)).toEqual({ 'new-answer': 'answer' });
  });

  test('an empty streaming placeholder and a hidden tool call change nothing', () => {
    expect(
      roles([user('u'), text('n'), call('hidden', { hidden: true }), text('empty', '  ')]),
    ).toEqual({ n: 'answer' });
  });
});
