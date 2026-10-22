/**
 * Which messages offer a branch: the final agent message of each completed turn.
 */
import { createConversationHistory, type ConversationHistory } from '@lostgradient/chat';
import { describe, expect, test } from 'bun:test';

import { branchPointIds } from './branch-points.ts';

type Row = {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool-call' | 'tool-result';
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
  };
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

  test('offer no message while a run is going, which has not finished its reply', () => {
    const rows: Row[] = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'u2', role: 'user' },
      { id: 'a2', role: 'assistant' },
    ];

    expect(ids(rows, true)).toEqual([]);
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

  test('leave out a tool-call row, which a step that calls a tool is made of', () => {
    const rows: Row[] = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'tool-call' },
      { id: 'r1', role: 'tool-result' },
      { id: 'u2', role: 'user' },
      { id: 'a2', role: 'assistant' },
    ];

    expect(ids(rows, false)).toEqual(['a2']);
  });
});

describe('the messages of a run the Bureau names step by step', () => {
  test('offer only the last reply of a run a follow-up was delivered to, not the earlier reply it interrupted', () => {
    const rows: Row[] = [
      { id: 'u1', role: 'user' },
      { id: 'run-1:step:0', role: 'assistant' },
      { id: 'follow-up', role: 'user' },
      { id: 'run-1:step:1', role: 'assistant' },
    ];

    expect(ids(rows, false)).toEqual(['run-1:step:1']);
  });

  test('offer the last reply of each completed run', () => {
    const rows: Row[] = [
      { id: 'u1', role: 'user' },
      { id: 'run-1:step:0', role: 'assistant' },
      { id: 'u2', role: 'user' },
      { id: 'run-2:step:0', role: 'assistant' },
      { id: 'run-2:step:1', role: 'assistant' },
    ];

    expect(ids(rows, false)).toEqual(['run-1:step:0', 'run-2:step:1']);
  });

  test('offer no row of the run that is going, even when a follow-up row follows its reply', () => {
    const rows: Row[] = [
      { id: 'u1', role: 'user' },
      { id: 'run-1:step:0', role: 'assistant' },
      { id: 'follow-up', role: 'user' },
    ];

    expect(ids(rows, true)).toEqual([]);
    expect(ids(rows, false)).toEqual(['run-1:step:0']);
  });

  test('offer nothing while a run is going, whichever run a row belongs to', () => {
    const rows: Row[] = [
      { id: 'u1', role: 'user' },
      { id: 'run-1:step:0', role: 'assistant' },
      { id: 'u2', role: 'user' },
      { id: 'conversation-2-x', role: 'assistant' },
      { id: 'follow-up', role: 'user' },
    ];

    expect(ids(rows, true)).toEqual([]);
  });

  test('do not offer a step that a tool result of its run follows', () => {
    const rows: Row[] = [
      { id: 'u1', role: 'user' },
      { id: 'run-1:step:0', role: 'assistant' },
      { id: 'run-1:step:0:result:call-1', role: 'tool-result' },
      { id: 'run-1:step:1', role: 'assistant' },
    ];

    expect(ids(rows, false)).toEqual(['run-1:step:1']);
  });
});
