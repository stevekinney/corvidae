import {
  appendMessages,
  createConversationHistory,
  type ConversationHistory,
} from '@lostgradient/chat';
import { describe, expect, test } from 'bun:test';

import { branchPointIds } from './branch-points.ts';
import { editForkPoint, holdEdit, lastBranchPoint, takeEdit } from './edit-fork.ts';

function conversationOf(
  rows: ReadonlyArray<{ id: string; role: 'user' | 'assistant'; hidden?: boolean }>,
): ConversationHistory {
  return rows.reduce(
    (history, row) =>
      appendMessages(history, {
        id: row.id,
        role: row.role,
        content: row.id,
        ...(row.hidden === true ? { hidden: true } : {}),
      }),
    createConversationHistory({ id: 'session-1' }),
  );
}

const TURNS = conversationOf([
  { id: 'u1', role: 'user' },
  { id: 'a1', role: 'assistant' },
  { id: 'u2', role: 'user' },
  { id: 'a2', role: 'assistant' },
]);

describe('editForkPoint', () => {
  const points = branchPointIds(TURNS, false);

  test('branches before the first message for the first message', () => {
    expect(editForkPoint(TURNS, 'u1', points)).toBeNull();
  });

  test('branches through the reply before a later message', () => {
    expect(editForkPoint(TURNS, 'u2', points)).toBe('a1');
  });

  test('has no point for a message that is not one the person sent, or is unknown', () => {
    expect(editForkPoint(TURNS, 'a1', points)).toBeUndefined();
    expect(editForkPoint(TURNS, 'missing', points)).toBeUndefined();
  });

  test('has no point for a message sent while a run was going, which follows no finished reply', () => {
    const history = conversationOf([
      { id: 'u1', role: 'user' },
      { id: 'run-1:step:0', role: 'assistant' },
      { id: 'u2', role: 'user' },
      { id: 'run-1:step:1', role: 'assistant' },
    ]);

    expect(editForkPoint(history, 'u2', branchPointIds(history, false))).toBeUndefined();
  });

  test('skips hidden rows when it looks for what precedes the message', () => {
    const history = conversationOf([
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'h1', role: 'user', hidden: true },
      { id: 'u2', role: 'user' },
    ]);

    expect(editForkPoint(history, 'u2', branchPointIds(history, false))).toBe('a1');
  });
});

describe('lastBranchPoint', () => {
  test('is the last reply a branch can be made from', () => {
    expect(lastBranchPoint(TURNS, branchPointIds(TURNS, false))).toBe('a2');
  });

  test('is nothing while a run is going', () => {
    expect(lastBranchPoint(TURNS, branchPointIds(TURNS, true))).toBeUndefined();
  });
});

describe('the edited text held for a branch', () => {
  test('is taken once, by the branch it was held for', () => {
    holdEdit('branch-1', 'edited');

    expect(takeEdit('branch-2')).toBeUndefined();
    expect(takeEdit('branch-1')).toBe('edited');
    expect(takeEdit('branch-1')).toBeUndefined();
  });
});
