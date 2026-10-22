/**
 * Which messages offer a branch: the final agent message of each completed turn.
 */
import { createConversationHistory, type ConversationHistory } from '@lostgradient/chat';
import { describe, expect, test } from 'bun:test';

import { branchPointIds } from './branch-points.ts';

type Row = {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool-use' | 'tool-result';
  readonly hidden?: true;
};

/** A conversation of `rows`, in order. Only each row's identity, role and visibility matter here. */
function conversationOf(rows: readonly Row[]): ConversationHistory {
  const empty = createConversationHistory({ id: 'session' });
  return {
    ...empty,
    ids: rows.map((row) => row.id),
    messages: Object.fromEntries(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          role: row.role,
          content: row.id,
          position: 0,
          createdAt: empty.createdAt,
          metadata: {},
          hidden: row.hidden === true,
          toolCall: undefined,
          toolResult: undefined,
          tokenUsage: undefined,
          goalCompleted: undefined,
        },
      ]),
    ),
  } as ConversationHistory;
}

function ids(rows: readonly Row[], runActive: boolean): string[] {
  return [...branchPointIds(conversationOf(rows), runActive)].toSorted();
}

describe('the messages that offer a branch', () => {
  test('are an agent message followed by a user message, and the last message while no run is going', () => {
    const rows: Row[] = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'u2', role: 'user' },
      { id: 'a2', role: 'assistant' },
    ];

    expect(ids(rows, false)).toEqual(['a1', 'a2']);
  });

  test('leave out the last agent message while a run is going, which has not finished', () => {
    const rows: Row[] = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'u2', role: 'user' },
      { id: 'a2', role: 'assistant' },
    ];

    expect(ids(rows, true)).toEqual(['a1']);
  });

  test('leave out an agent message a tool result follows, which is a step of a turn and not its end', () => {
    const rows: Row[] = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'r1', role: 'tool-result' },
      { id: 'a2', role: 'assistant' },
    ];

    expect(ids(rows, false)).toEqual(['a2']);
  });

  test('offer nothing in a conversation with no agent message', () => {
    expect(ids([], false)).toEqual([]);
    expect(ids([{ id: 'u1', role: 'user' }], false)).toEqual([]);
  });

  test('do not count a hidden row as what follows an agent message', () => {
    // The page puts a hidden row in the conversation to read a run, and a person never sees it.
    const rows: Row[] = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'hidden', role: 'user', hidden: true },
    ];

    expect(ids(rows, false)).toEqual(['a1']);
    expect(ids(rows, true)).toEqual([]);
  });
});
