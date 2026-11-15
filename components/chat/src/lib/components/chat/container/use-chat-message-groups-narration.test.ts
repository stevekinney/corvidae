/**
 * A settled turn folds into one step group: its steps and the narration between them, then the
 * answer as a row of its own. A turn that has not settled, has no answer, or holds something that
 * must keep its own row stays as it was.
 */

import { describe, expect, test } from 'bun:test';
import type { Message } from '../conversation-model.ts';

import {
  buildChatRenderRows,
  buildMessagesWithDateSeparators,
  chatRenderRowKey,
  findRenderRowIndexByMessageId,
  type ChatRenderRow,
  type ChatRenderRowOptions,
} from './use-chat-message-groups.svelte.ts';

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

const person = (id: string) => message({ id, role: 'user', content: 'Question' });
const text = (id: string, content: string, overrides: Partial<Message> = {}) =>
  message({ id, role: 'assistant', content, ...overrides });
const step = (id: string, overrides: Partial<Message> = {}) =>
  message({
    id,
    role: 'tool-call',
    toolCall: { id: `call-${id}`, name: 'lookup', arguments: {} },
    ...overrides,
  });

function rowsOf(messages: Message[], options?: ChatRenderRowOptions): ChatRenderRow[] {
  return buildChatRenderRows(buildMessagesWithDateSeparators(messages, new Set()), options);
}

/** The row types, with the tool group's folded entries spelled out. */
function shape(rows: readonly ChatRenderRow[]): string[] {
  return rows.map((row) => {
    if (row.type === 'message') return `message:${row.message.id}`;
    if (row.type === 'tool-call-group') {
      const entries =
        row.entries?.map((entry) => `${entry.type}:${entry.message.id}`).join(',') ?? 'none';
      return `group[${row.messages.map((call) => call.id).join(',')}|${entries}]`;
    }
    return row.type;
  });
}

describe('a settled turn folds into one step group', () => {
  test('a turn with no tools has nothing to fold', () => {
    const rows = rowsOf([person('u'), text('answer', 'Done.')]);
    expect(shape(rows)).toEqual(['date', 'message:u', 'message:answer']);
  });

  test('text, a step, then the answer: one group holds the narration and the step, then the answer', () => {
    const rows = rowsOf([
      person('u'),
      text('say-1', 'Reading the ledger'),
      step('s1'),
      text('answer', 'Done.'),
    ]);
    expect(shape(rows)).toEqual([
      'date',
      'message:u',
      'group[s1|narration:say-1,step:s1]',
      'message:answer',
    ]);
  });

  test('text, step, text, step, answer: one step row in the original order, not two', () => {
    const rows = rowsOf([
      person('u'),
      text('say-1', 'Reading the ledger'),
      step('s1'),
      text('say-2', 'Now the invoices'),
      step('s2'),
      text('answer', 'Done.'),
    ]);
    expect(rows.filter((row) => row.type === 'tool-call-group')).toHaveLength(1);
    expect(shape(rows)).toEqual([
      'date',
      'message:u',
      'group[s1,s2|narration:say-1,step:s1,narration:say-2,step:s2]',
      'message:answer',
    ]);
  });

  test('a turn that stopped with only narration keeps it in place, unfolded', () => {
    const rows = rowsOf([person('u'), text('say-1', 'Reading the ledger'), step('s1')]);
    expect(shape(rows)).toEqual(['date', 'message:u', 'message:say-1', 'group[s1|none]']);
  });

  test('a turn that stopped with an answer part folds like an answered one', () => {
    const rows = rowsOf([
      person('u'),
      text('say-1', 'Reading the ledger'),
      step('s1'),
      text('answer', 'The first half of the answer', { metadata: { turn: 'stopped' } }),
    ]);
    expect(shape(rows).slice(2)).toEqual(['group[s1|narration:say-1,step:s1]', 'message:answer']);
  });

  test("a turn with steps and no narration keeps today's plain group", () => {
    const rows = rowsOf([person('u'), step('s1'), step('s2'), text('answer', 'Done.')]);
    expect(shape(rows)).toEqual(['date', 'message:u', 'group[s1,s2|none]', 'message:answer']);
  });

  test('an earlier turn folds on its own and the next turn is untouched', () => {
    const rows = rowsOf([
      person('u1'),
      text('say-1', 'Reading'),
      step('s1'),
      text('answer-1', 'Done.'),
      person('u2'),
      text('say-2', 'Checking'),
      step('s2'),
    ]);
    expect(shape(rows).slice(2)).toEqual([
      'group[s1|narration:say-1,step:s1]',
      'message:answer-1',
      'message:u2',
      'message:say-2',
      'group[s2|none]',
    ]);
  });
});

describe('what keeps a turn from folding', () => {
  const turn = [
    person('u'),
    text('say-1', 'Reading the ledger'),
    step('s1'),
    text('say-2', 'Now the invoices'),
    step('s2'),
    text('answer', 'Done.'),
  ];

  test('a turn still in progress draws its narration in place and groups the steps as before', () => {
    const rows = rowsOf(turn, { unsettledMessageIds: new Set(turn.map((entry) => entry.id)) });
    expect(shape(rows)).toEqual([
      'date',
      'message:u',
      'message:say-1',
      'group[s1|none]',
      'message:say-2',
      'group[s2|none]',
      'message:answer',
    ]);
  });

  test('a pending approval mid-turn keeps the turn as it is, so the card stays where it was', () => {
    const rows = rowsOf(turn, { pendingToolCallIds: new Set(['call-s1']) });
    expect(rows.some((row) => row.type === 'tool-call-group' && row.entries !== undefined)).toBe(
      false,
    );
    expect(shape(rows).slice(2)).toEqual([
      'message:say-1',
      'group[s1|none]',
      'message:say-2',
      'group[s2|none]',
      'message:answer',
    ]);
  });

  test('a call that keeps its own row (a question or a receipt) ends the fold', () => {
    const rows = rowsOf(turn, { ungroupedToolCallIds: new Set(['call-s1']) });
    expect(rows.some((row) => row.type === 'tool-call-group' && row.entries !== undefined)).toBe(
      false,
    );
    expect(shape(rows)).toContain('message:s1');
  });

  test('a date separator inside the turn ends the fold', () => {
    const nextDay = text('say-2', 'Now the invoices', { createdAt: '2026-05-05T12:00:00.000Z' });
    const rows = rowsOf([
      person('u'),
      text('say-1', 'Reading the ledger'),
      step('s1'),
      nextDay,
      step('s2', { createdAt: '2026-05-05T12:00:00.000Z' }),
      text('answer', 'Done.', { createdAt: '2026-05-05T12:00:00.000Z' }),
    ]);
    expect(rows.some((row) => row.type === 'tool-call-group' && row.entries !== undefined)).toBe(
      false,
    );
  });

  test("the unread divider inside the turn ends the fold; before the turn's first step it stays above the group", () => {
    const inside = rowsOf(turn, { firstUnreadId: 'say-2' });
    expect(inside.some((row) => row.type === 'tool-call-group' && row.entries !== undefined)).toBe(
      false,
    );
    expect(inside.map((row) => row.type)).toContain('unread-divider');

    const before = rowsOf(turn, { firstUnreadId: 'say-1' });
    expect(shape(before).slice(2)).toEqual([
      'unread-divider',
      'group[s1,s2|narration:say-1,step:s1,narration:say-2,step:s2]',
      'message:answer',
    ]);
  });

  test('narration that draws more than its text stays where it is', () => {
    const withReasoning = [
      person('u'),
      text('say-1', 'Reading', { metadata: { 'cinder:reasoning': 'because' } }),
      step('s1'),
      text('answer', 'Done.'),
    ];
    expect(rowsOf(withReasoning).some((row) => row.type === 'tool-call-group' && row.entries)).toBe(
      false,
    );
    expect(
      rowsOf(turn, { canFoldNarration: (candidate) => candidate.id !== 'say-2' }).some(
        (row) => row.type === 'tool-call-group' && row.entries,
      ),
    ).toBe(false);
  });

  // A fold draws a narration message as its text alone, so a native reasoning block (drawn by the
  // message as its "Thinking" disclosure) would be lost even with the group open.
  test.each([
    ['thinking', { type: 'thinking', thinking: 'The ledger comes first.' }],
    ['redacted_thinking', { type: 'redacted_thinking', data: 'opaque' }],
  ] as const)('narration with a native %s block stays where it is', (_name, block) => {
    const withNativeReasoning = [
      person('u'),
      message({
        id: 'say-1',
        role: 'assistant',
        content: [block, { type: 'text', text: 'Reading' }] as Message['content'],
      }),
      step('s1'),
      text('answer', 'Done.'),
    ];
    const rows = rowsOf(withNativeReasoning);
    expect(rows.some((row) => row.type === 'tool-call-group' && row.entries)).toBe(false);
    expect(shape(rows)).toContain('message:say-1');
  });

  test('narration whose content is text blocks only still folds', () => {
    const blocks = [
      person('u'),
      message({
        id: 'say-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Reading' }] as Message['content'],
      }),
      step('s1'),
      text('answer', 'Done.'),
    ];
    expect(rowsOf(blocks).some((row) => row.type === 'tool-call-group' && row.entries)).toBe(true);
  });

  test('a hidden message between the steps ends the fold', () => {
    const rows = rowsOf([
      person('u'),
      text('say-1', 'Reading'),
      step('s1'),
      text('quiet', 'hidden note', { hidden: true }),
      step('s2'),
      text('answer', 'Done.'),
    ]);
    expect(rows.some((row) => row.type === 'tool-call-group' && row.entries)).toBe(false);
  });
});

describe('keys across a turn settling, an edit and a regenerate', () => {
  const settled = [
    person('u'),
    text('say-1', 'Reading the ledger'),
    step('s1'),
    text('answer', 'Done.'),
  ];

  test('the answer keeps its key and the first group keeps its key when the turn settles', () => {
    const working = rowsOf(settled, { unsettledMessageIds: new Set(settled.map((m) => m.id)) });
    const done = rowsOf(settled);
    const keyOfAnswer = (rows: readonly ChatRenderRow[]) =>
      chatRenderRowKey(rows.find((row) => row.type === 'message' && row.message.id === 'answer')!);
    expect(keyOfAnswer(working)).toBe('msg-answer');
    expect(keyOfAnswer(done)).toBe('msg-answer');
    const groupKey = (rows: readonly ChatRenderRow[]) =>
      chatRenderRowKey(rows.find((row) => row.type === 'tool-call-group')!);
    expect(groupKey(working)).toBe('tool-group-s1');
    expect(groupKey(done)).toBe('tool-group-s1');
    // The narration row disappears: the rows change, the answer's row is the same keyed row.
    expect(working.map(chatRenderRowKey)).toContain('msg-say-1');
    expect(done.map(chatRenderRowKey)).not.toContain('msg-say-1');
  });

  test('a regenerated answer folds the same narration under the new answer', () => {
    const regenerated = [...settled.slice(0, 3), text('answer-2', 'Done, again.')];
    const rows = rowsOf(regenerated);
    expect(shape(rows).slice(2)).toEqual(['group[s1|narration:say-1,step:s1]', 'message:answer-2']);
    expect(rows.map(chatRenderRowKey)).toContain('msg-answer-2');
  });

  test('an edited turn folds under the edited message and leaves no stale group behind', () => {
    const edited = [
      person('u-edited'),
      text('say-1b', 'Reading again'),
      step('s1b'),
      text('a2', 'Ok.'),
    ];
    const rows = rowsOf(edited);
    expect(shape(rows).slice(2)).toEqual(['group[s1b|narration:say-1b,step:s1b]', 'message:a2']);
    expect(rows.map(chatRenderRowKey)).not.toContain('tool-group-s1');
  });
});

describe('finding a folded message', () => {
  test('a folded narration message is found in its group row', () => {
    const rows = rowsOf([
      person('u'),
      text('say-1', 'Reading'),
      step('s1'),
      text('answer', 'Done.'),
    ]);
    const groupIndex = rows.findIndex((row) => row.type === 'tool-call-group');
    expect(findRenderRowIndexByMessageId(rows, 'say-1')).toBe(groupIndex);
    expect(findRenderRowIndexByMessageId(rows, 's1')).toBe(groupIndex);
  });
});

const shapeOfRows = shape;

describe('a stopped turn that said only what it was doing', () => {
  const stoppedIds = new Set(['say']);
  const options: ChatRenderRowOptions = {
    deferOutcome: (candidate) => stoppedIds.has(candidate.id),
  };
  // The turn's own rows, without the day band above them.
  const shape = (rows: readonly ChatRenderRow[]) =>
    shapeOfRows(rows).filter((row) => row !== 'date');

  test('ends with its outcome after the step row, not between the text and the steps', () => {
    const rows = rowsOf(
      [person('u'), text('say', 'Reading first.'), step('s1'), step('s2')],
      options,
    );
    expect(shape(rows)).toEqual(['message:u', 'message:say', 'group[s1,s2|none]', 'turn-outcome']);
    const last = rows.at(-1);
    expect(last?.type === 'turn-outcome' && last.message.id).toBe('say');
    expect(chatRenderRowKey(last!)).toBe('outcome-say');
  });

  test('keeps the outcome in place when the host defers none, or when no step follows the text', () => {
    expect(shape(rowsOf([person('u'), text('say', 'Reading first.'), step('s1')]))).toEqual([
      'message:u',
      'message:say',
      'group[s1|none]',
    ]);
    expect(shape(rowsOf([person('u'), text('say', 'Partial answer')], options))).toEqual([
      'message:u',
      'message:say',
    ]);
  });

  test('leaves a person message and a step that keeps its own row alone', () => {
    const rows = rowsOf([person('say'), step('s1')], options);
    expect(shape(rows)).toEqual(['message:say', 'group[s1|none]']);
    const ungrouped = rowsOf([person('u'), text('say', 'Reading first.'), step('s1')], {
      ...options,
      ungroupedToolCallIds: new Set(['call-s1']),
    });
    expect(shape(ungrouped)).toEqual(['message:u', 'message:say', 'message:s1']);
  });
});
