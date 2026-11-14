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

  const asks = (id: string, callId: string, type: 'approval' | 'input'): Message =>
    message({
      id,
      role: 'tool-result',
      toolResult: {
        callId,
        outcome: 'action_required',
        action:
          type === 'approval'
            ? { type: 'approval', message: 'Send the email?' }
            : { type: 'input', schema: { type: 'object' } },
      } as Message['toolResult'],
    });

  test('text then a pending approval is asking', () => {
    expect(roles([user('u'), text('n'), call('c'), asks('r', 'c-call', 'approval')])).toEqual({
      n: 'asking',
    });
  });

  test('text, a finished step, then a pending approval is asking', () => {
    expect(
      roles([
        user('u'),
        text('n'),
        call('s'),
        result('sr', 's-call'),
        call('c'),
        asks('r', 'c-call', 'approval'),
      ]),
    ).toEqual({ n: 'asking' });
  });

  test('text then a pending question or tool input is asking', () => {
    expect(roles([user('u'), text('n'), call('c'), asks('r', 'c-call', 'input')])).toEqual({
      n: 'asking',
    });
  });

  test('only the text directly before the ask is asking; earlier text is narration', () => {
    expect(
      roles([
        user('u'),
        text('first'),
        call('s'),
        result('sr', 's-call'),
        text('second'),
        call('c'),
        asks('r', 'c-call', 'approval'),
      ]),
    ).toEqual({ first: 'narration', second: 'asking' });
  });

  test('an approval decided later in the transcript leaves plain narration', () => {
    const decided = message({
      id: 'r2',
      role: 'tool-result',
      toolResult: { callId: 'c-call', outcome: 'success', content: { ok: true } },
    });
    expect(
      roles([user('u'), text('n'), call('c'), asks('r', 'c-call', 'approval'), decided, text('a')]),
    ).toEqual({ n: 'narration', a: 'answer' });
  });

  test('an ask the person answered in this chat leaves plain narration', () => {
    const transcript = [user('u'), text('n'), call('c'), asks('r', 'c-call', 'approval')];
    const answeredCallIds = new Set(['c-call']);
    expect(Object.fromEntries(classifyAssistantText(transcript, { answeredCallIds }))).toEqual({
      n: 'narration',
    });
  });

  test('a question the host draws after the last message makes the narration before it an ask', () => {
    const transcript = [user('u'), text('n'), call('c')];
    expect(
      Object.fromEntries(classifyAssistantText(transcript, { trailingAskPending: true })),
    ).toEqual({ n: 'asking' });
    expect(Object.fromEntries(classifyAssistantText(transcript, {}))).toEqual({ n: 'narration' });
  });

  test('a trailing ask does not reach narration with other assistant text between, an earlier turn, or an answer', () => {
    const options = { trailingAskPending: true };
    expect(
      Object.fromEntries(
        classifyAssistantText([user('u'), text('n1'), call('c'), text('n2'), call('d')], options),
      ),
    ).toEqual({ n1: 'narration', n2: 'asking' });
    expect(
      Object.fromEntries(
        classifyAssistantText([user('u1'), text('n'), call('c'), user('u2'), text('a')], options),
      ),
    ).toEqual({ n: 'narration', a: 'answer' });
  });

  test('an ask in an earlier turn does not make a later turn narration an ask', () => {
    expect(
      roles([
        user('u1'),
        call('c'),
        asks('r', 'c-call', 'approval'),
        user('u2'),
        text('n'),
        call('d'),
      ]),
    ).toEqual({ n: 'narration' });
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
