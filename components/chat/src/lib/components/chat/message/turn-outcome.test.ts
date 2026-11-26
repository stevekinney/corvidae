/**
 * COR-2725: Chat reads the last turn's outcome from what the host knows, so the host keeps no copy of
 * the last-turn, stop-note or retry presentation. One outcome per turn: a dropped stream, a stop the
 * person asked for, a failure partway, an answer that was never written, or none of those.
 */

import { describe, expect, test } from 'bun:test';

import {
  appendAssistantMessage,
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
} from '../builders.ts';
import type { ConversationHistory } from '../conversation-model.ts';
import { CINDER_NOTES_METADATA_KEY, resolveMessageNotes } from '../utilities/index.ts';
import { resolveTurnOutcome, turnStateOf, type TurnOutcomeFacts } from './turn-outcome.ts';

const IDLE: TurnOutcomeFacts = { running: false, now: 1_000 };

function note(
  conversation: ConversationHistory,
  rowId: string,
  entry: Record<string, string | boolean>,
): ConversationHistory {
  const row = conversation.messages[rowId]!;
  return {
    ...conversation,
    messages: {
      ...conversation.messages,
      [rowId]: { ...row, metadata: { ...row.metadata, [CINDER_NOTES_METADATA_KEY]: [entry] } },
    },
  };
}

function answered(): ConversationHistory {
  return appendAssistantMessage(
    appendUserMessage(createConversationHistory({ id: 'c' }), 'Where is order 4398?'),
    'Order 4398 shipped.',
  );
}

function endedOnATool(): ConversationHistory {
  const asked = appendUserMessage(createConversationHistory({ id: 'c' }), 'Look up order 4398');
  const narrated = appendAssistantMessage(asked, 'Let me check the orders.');
  const called = appendToolCall(narrated, {
    id: 'call-1',
    name: 'lookup-order',
    arguments: { orderId: '4398' },
  });
  return appendToolResult(called, { callId: 'call-1', outcome: 'success', content: 'Shipped' });
}

function lastRow(conversation: ConversationHistory) {
  return conversation.messages[conversation.ids.at(-1)!]!;
}

describe('the dropped stream', () => {
  test('reconnects only the last assistant turn, counting the wait in whole seconds', () => {
    const outcome = resolveTurnOutcome(answered(), {
      ...IDLE,
      running: true,
      reconnect: { attempt: 2, attempts: 7, wait: 5_000, nextTryAt: 4_100, runDropped: true },
    });
    const assistant = lastRow(answered());
    expect(turnStateOf(outcome, { ...assistant, id: outcome.assistantId! })).toEqual({
      kind: 'reconnecting',
      attempt: 2,
      attempts: 7,
      nextTryIn: 4,
      wait: 5,
    });
    expect(turnStateOf(outcome, { ...assistant, id: 'an-earlier-reply' })).toBeUndefined();
  });

  test('is no state of the turn when only the first read of the history failed', () => {
    const outcome = resolveTurnOutcome(answered(), {
      ...IDLE,
      reconnect: { attempt: 2, attempts: 7, wait: 5_000, nextTryAt: 4_100, runDropped: false },
    });
    expect(outcome.state).toBeUndefined();
  });
});

describe('the stop line the run left', () => {
  test('is a stopped turn, and the line leaves the conversation', () => {
    const base = answered();
    const conversation = note(base, base.ids.at(-1)!, {
      kind: 'stopped',
      id: 'stopped:run-1',
      reason: 'Stopped by the person.',
    });
    const outcome = resolveTurnOutcome(conversation, IDLE);
    expect(outcome.state).toEqual({ kind: 'stopped' });
    expect(resolveMessageNotes(lastRow(outcome.conversation)) ?? []).toEqual([]);
  });

  test('is a failed turn that says why, once nothing is running', () => {
    const base = answered();
    const conversation = note(base, base.ids.at(-1)!, {
      kind: 'stopped',
      id: 'stopped:run-1',
      reason: 'The provider dropped the connection.',
      failed: true,
    });
    expect(resolveTurnOutcome(conversation, IDLE).state).toEqual({
      kind: 'failed',
      cause: 'The provider dropped the connection.',
    });
    // A run that is going has not stopped: the line is not its state yet.
    const running = resolveTurnOutcome(conversation, { ...IDLE, running: true });
    expect(running.state).toBeUndefined();
    expect(running.conversation).toBe(conversation);
  });

  test('never replaces an earlier reply when the stop belongs to the new message', () => {
    const base = appendUserMessage(answered(), 'Second question');
    const conversation = note(base, base.ids.at(-1)!, {
      kind: 'stopped',
      id: 'stopped:new-run',
      reason: 'The provider stopped.',
      failed: true,
    });
    const outcome = resolveTurnOutcome(conversation, IDLE);
    expect(outcome.stop).toBeUndefined();
    expect(outcome.conversation).toBe(conversation);
    expect(outcome.state).toBeUndefined();
    expect(outcome.assistantId).toBe(conversation.ids[1]);
  });

  test('leaves the notice that a restarted server ended the chat where it is', () => {
    const base = answered();
    const conversation = note(base, base.ids.at(-1)!, {
      kind: 'stopped',
      id: 'ended',
      reason: 'The server restarted.',
      notice: true,
    });
    expect(resolveTurnOutcome(conversation, IDLE).conversation).toBe(conversation);
  });
});

describe('an answer that was never written (R6)', () => {
  test('is the empty state of a turn that ended on a tool, drawn on its last assistant message', () => {
    const conversation = endedOnATool();
    const outcome = resolveTurnOutcome(conversation, IDLE);
    expect(outcome.state).toEqual({ kind: 'empty' });
    expect(outcome.assistantId).toBe(conversation.ids[1]);
  });

  test('is not an outcome while the run goes, a decision waits, or the turn ended on a written answer', () => {
    expect(resolveTurnOutcome(endedOnATool(), { ...IDLE, running: true }).state).toBeUndefined();
    expect(resolveTurnOutcome(endedOnATool(), { ...IDLE, holding: true }).state).toBeUndefined();
    expect(resolveTurnOutcome(answered(), IDLE).state).toBeUndefined();
  });

  test('is not an outcome while a call has no answer or waits on an approval', () => {
    const asked = appendAssistantMessage(
      appendUserMessage(createConversationHistory({ id: 'c' }), 'Refund 4471'),
      'Asking for approval.',
    );
    const unanswered = appendToolCall(asked, {
      id: 'call-1',
      name: 'issue-refund',
      arguments: { orderId: '4471' },
    });
    expect(resolveTurnOutcome(unanswered, IDLE).state).toBeUndefined();
    const parked = appendToolResult(unanswered, {
      callId: 'call-1',
      outcome: 'action_required',
      content: '',
    });
    expect(resolveTurnOutcome(parked, IDLE).state).toBeUndefined();
  });

  test('is the empty answer when the last call failed or was refused: the run ended with nothing to say (COR-2725 decision)', () => {
    const asked = appendAssistantMessage(
      appendUserMessage(createConversationHistory({ id: 'c' }), 'Look up order 4398'),
      'Let me check the orders.',
    );
    const called = appendToolCall(asked, {
      id: 'call-1',
      name: 'lookup-order',
      arguments: { orderId: '4398' },
    });
    const failed = appendToolResult(called, {
      callId: 'call-1',
      outcome: 'error',
      content: null,
      error: { code: 'timeout', category: 'timeout', retryable: true, message: 'Timed out.' },
    });
    expect(resolveTurnOutcome(failed, IDLE).state).toEqual({ kind: 'empty' });
  });

  test('yields to a stop, a failure and a dropped stream: one outcome per turn', () => {
    const base = endedOnATool();
    const stopped = note(base, base.ids[1]!, {
      kind: 'stopped',
      id: 'stopped:run-1',
      reason: 'Stopped by the person.',
    });
    expect(resolveTurnOutcome(stopped, IDLE).state).toEqual({ kind: 'stopped' });
    expect(
      resolveTurnOutcome(base, {
        ...IDLE,
        reconnect: { attempt: 1, attempts: 7, wait: 500, nextTryAt: 1_500, runDropped: true },
      }).state?.kind,
    ).toBe('reconnecting');
  });
});
