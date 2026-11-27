/**
 * COR-2725 (attempt 2 on AC1): the stop and the anchor belong to one turn. A turn that ends on its
 * steps, with or without a follow-up the person typed after them, carries its outcome after those
 * steps, and an outcome is never drawn on, or bound to the run of, a row outside the turn: a
 * Discard or Continue there would act on an earlier, finished reply.
 */

import { describe, expect, test } from 'bun:test';

import { appendMessages, createConversationHistory, FOLLOW_UP_METADATA_KEY } from '../builders.ts';
import type { ConversationHistory } from '../conversation-model.ts';
import { CINDER_NOTES_METADATA_KEY } from '../utilities/index.ts';
import { resolveTurnOutcome, type TurnOutcomeFacts } from './turn-outcome.ts';

const IDLE: TurnOutcomeFacts = { running: false, now: 1_000 };
const DROPPED: TurnOutcomeFacts = {
  running: true,
  now: 1_000,
  reconnect: { attempt: 1, attempts: 7, wait: 5_000, nextTryAt: 4_000, runDropped: true },
};

type Earlier = 'none' | 'a reply' | 'only steps';
type Current = 'only steps' | 'narrated then steps' | 'steps then a reply' | 'the message alone';
type Trailing = 'nothing' | 'a follow-up';
type Mark = 'none' | 'stopped' | 'failed';

function earlierTurn(shape: Earlier) {
  if (shape === 'none') return [];
  const asked = { id: 'u1', role: 'user' as const, content: 'First' };
  if (shape === 'a reply')
    return [asked, { id: 'runA:step:0', role: 'assistant' as const, content: 'Done.' }];
  return [
    asked,
    {
      id: 'runA:step:0',
      role: 'tool-call' as const,
      content: '',
      toolCall: { id: 'a1', name: 'lookup', arguments: {} },
    },
    {
      id: 'runA:step:0:result:a1',
      role: 'tool-result' as const,
      content: '',
      toolResult: { callId: 'a1', outcome: 'success' as const, content: 'ok' },
    },
  ];
}

const STEPS = [
  {
    id: 'runB:step:1',
    role: 'tool-call' as const,
    content: '',
    toolCall: { id: 'b1', name: 'lookup', arguments: {} },
  },
  {
    id: 'runB:step:1:result:b1',
    role: 'tool-result' as const,
    content: '',
    toolResult: { callId: 'b1', outcome: 'success' as const, content: 'ok' },
  },
];

function currentTurn(shape: Current) {
  const asked = { id: 'u2', role: 'user' as const, content: 'Second' };
  switch (shape) {
    case 'only steps':
      return [asked, ...STEPS];
    case 'narrated then steps':
      return [
        asked,
        { id: 'runB:step:0', role: 'assistant' as const, content: 'Checking.' },
        ...STEPS,
      ];
    case 'steps then a reply':
      return [asked, ...STEPS, { id: 'runB:step:2', role: 'assistant' as const, content: 'Done.' }];
    case 'the message alone':
      return [asked];
  }
}

function build(earlier: Earlier, current: Current, trailing: Trailing, mark: Mark) {
  const rows = [
    ...earlierTurn(earlier),
    ...currentTurn(current),
    ...(trailing === 'a follow-up'
      ? [
          {
            id: 'u3',
            role: 'user' as const,
            content: 'Also this',
            metadata: { [FOLLOW_UP_METADATA_KEY]: true },
          },
        ]
      : []),
  ];
  let conversation: ConversationHistory = appendMessages(
    createConversationHistory({ id: 'c' }),
    ...rows,
  );
  // The run's stop line sits on the last row the run wrote, the way the host puts it.
  const written = currentTurn(current).at(-1)!;
  if (mark !== 'none') {
    const row = conversation.messages[written.id]!;
    conversation = {
      ...conversation,
      messages: {
        ...conversation.messages,
        [written.id]: {
          ...row,
          metadata: {
            ...row.metadata,
            [CINDER_NOTES_METADATA_KEY]: [
              {
                kind: 'stopped',
                id: 'stopped:runB',
                reason: 'The provider dropped.',
                ...(mark === 'failed' ? { failed: true } : {}),
              },
            ],
          },
        },
      },
    };
  }
  const ids = conversation.ids;
  const start = ids.findLastIndex((id) => {
    const row = conversation.messages[id]!;
    return row.role === 'user' && row.metadata[FOLLOW_UP_METADATA_KEY] !== true;
  });
  return { conversation, turn: new Set(ids.slice(start)), written: written.id };
}

describe('the probe: a turn of steps with a follow-up after them, after a finished reply', () => {
  for (const mark of ['stopped', 'failed'] as const) {
    test(`${mark}: the outcome is drawn on the turn's anchor, bound to run B`, () => {
      const { conversation } = build('a reply', 'only steps', 'a follow-up', mark);
      const outcome = resolveTurnOutcome(conversation, IDLE);
      expect(outcome.stop?.rowId).toBe('runB:step:1:result:b1');
      expect(outcome.state?.kind).toBe(mark);
      expect(outcome.assistantId).toBe('runB:step:1:result:b1:outcome');
      expect(outcome.rowId).toBe('runB:step:1:result:b1');
    });
  }

  test('finished with no answer, the empty answer is drawn after the steps, not on the earlier reply', () => {
    const { conversation } = build('a reply', 'only steps', 'a follow-up', 'none');
    const outcome = resolveTurnOutcome(conversation, IDLE);
    expect(outcome.state).toEqual({ kind: 'empty' });
    expect(outcome.rowId).toBe('runB:step:1:result:b1');
  });

  test('a dropped stream is drawn on the turn, never on the earlier reply', () => {
    const { conversation } = build('a reply', 'only steps', 'a follow-up', 'none');
    const outcome = resolveTurnOutcome(conversation, DROPPED);
    expect(outcome.state?.kind).toBe('reconnecting');
    expect(outcome.rowId).toBe('runB:step:1:result:b1');
  });

  test('with no earlier assistant message, the outcome is still drawn', () => {
    const { conversation } = build('none', 'only steps', 'a follow-up', 'failed');
    const outcome = resolveTurnOutcome(conversation, IDLE);
    expect(outcome.state?.kind).toBe('failed');
    expect(outcome.assistantId).toBe('runB:step:1:result:b1:outcome');
  });
});

describe('every turn shape: the outcome and the stop belong to the last turn', () => {
  const EARLIER: Earlier[] = ['none', 'a reply', 'only steps'];
  const CURRENT: Current[] = [
    'only steps',
    'narrated then steps',
    'steps then a reply',
    'the message alone',
  ];
  const TRAILING: Trailing[] = ['nothing', 'a follow-up'];
  const MARKS: Mark[] = ['none', 'stopped', 'failed'];

  for (const earlier of EARLIER)
    for (const current of CURRENT)
      for (const trailing of TRAILING)
        for (const mark of MARKS)
          for (const facts of [IDLE, DROPPED]) {
            test(`after ${earlier}; ${current}; ${trailing}; ${mark}; ${facts.running ? 'dropped' : 'idle'}`, () => {
              const { conversation, turn } = build(earlier, current, trailing, mark);
              const outcome = resolveTurnOutcome(conversation, facts);
              if (outcome.stop !== undefined) {
                expect(turn.has(outcome.stop.rowId)).toBe(true);
                // A stop that is drawn as a state has somewhere in its turn to draw it.
                expect(outcome.rowId).toBeDefined();
              }
              if (outcome.rowId !== undefined) expect(turn.has(outcome.rowId)).toBe(true);
              if (outcome.stop !== undefined && outcome.rowId !== undefined) {
                expect(turn.has(outcome.rowId)).toBe(turn.has(outcome.stop.rowId));
              }
              // A state is only ever drawn on a message of the turn, or the turn's anchor.
              if (outcome.state !== undefined && outcome.assistantId !== undefined) {
                const base = outcome.assistantId.replace(/:outcome$/u, '');
                expect(turn.has(base)).toBe(true);
              }
            });
          }
});
