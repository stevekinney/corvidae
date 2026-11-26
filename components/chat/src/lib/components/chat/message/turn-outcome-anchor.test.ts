/**
 * COR-2725 (AC1, R3 to R6, and the coordinator's decision that RunStates supersedes rows 20b and
 * 20h): a turn that has no assistant message, because the run only called tools, still has one
 * outcome. Chat draws it after the turn's steps, on an anchor it makes for the turn, whether the
 * run was stopped, failed, finished with nothing to say, or lost its stream; the last call having
 * errored or been refused changes none of that.
 *
 * Each cell is one visible outcome: the state, the id it is drawn on, the stop line it replaces
 * gone from the conversation, and no second state anywhere.
 */

import { describe, expect, test } from 'bun:test';

import {
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
} from '../builders.ts';
import type { ConversationHistory } from '../conversation-model.ts';
import { CINDER_NOTES_METADATA_KEY, resolveMessageNotes } from '../utilities/index.ts';
import {
  resolveTurnOutcome,
  toolOnlyTurnAnchor,
  turnStateOf,
  type TurnOutcomeFacts,
} from './turn-outcome.ts';

const IDLE: TurnOutcomeFacts = { running: false, now: 1_000 };

type Shape = 'tool calls only' | 'last call errored' | 'last call refused';

function turnOf(shape: Shape): ConversationHistory {
  const asked = appendUserMessage(createConversationHistory({ id: 'c' }), 'Look up order 4398');
  const called = appendToolCall(asked, {
    id: 'call-1',
    name: 'lookup-order',
    arguments: { orderId: '4398' },
  });
  switch (shape) {
    case 'tool calls only':
      return appendToolResult(called, { callId: 'call-1', outcome: 'success', content: 'Shipped' });
    case 'last call errored':
      return appendToolResult(called, {
        callId: 'call-1',
        outcome: 'error',
        content: null,
        error: { code: 'timeout', category: 'timeout', retryable: true, message: 'Timed out.' },
      });
    case 'last call refused':
      return appendToolResult(called, {
        callId: 'call-1',
        outcome: 'error',
        content: 'Tool call denied: not now',
      });
  }
}

function withNote(conversation: ConversationHistory, entry: Record<string, string | boolean>) {
  const rowId = conversation.ids.at(-1)!;
  const row = conversation.messages[rowId]!;
  return {
    ...conversation,
    messages: {
      ...conversation.messages,
      [rowId]: { ...row, metadata: { ...row.metadata, [CINDER_NOTES_METADATA_KEY]: [entry] } },
    },
  };
}

const SHAPES: Shape[] = ['tool calls only', 'last call errored', 'last call refused'];

const OUTCOMES = {
  stopped: {
    prepare: (conversation: ConversationHistory) =>
      withNote(conversation, { kind: 'stopped', id: 'stopped:run-1', reason: 'Stopped.' }),
    facts: IDLE,
    expected: { kind: 'stopped' },
  },
  failed: {
    prepare: (conversation: ConversationHistory) =>
      withNote(conversation, {
        kind: 'stopped',
        id: 'stopped:run-1',
        reason: 'The provider dropped the connection.',
        failed: true,
      }),
    facts: IDLE,
    expected: { kind: 'failed', cause: 'The provider dropped the connection.' },
  },
  empty: {
    prepare: (conversation: ConversationHistory) => conversation,
    facts: IDLE,
    expected: { kind: 'empty' },
  },
  reconnecting: {
    prepare: (conversation: ConversationHistory) => conversation,
    facts: {
      ...IDLE,
      running: true,
      reconnect: { attempt: 1, attempts: 7, wait: 5_000, nextTryAt: 4_000, runDropped: true },
    },
    expected: { kind: 'reconnecting', attempt: 1, attempts: 7, nextTryIn: 3, wait: 5 },
  },
} as const;

describe('a turn with no assistant message', () => {
  for (const shape of SHAPES) {
    for (const [name, outcome] of Object.entries(OUTCOMES)) {
      test(`${shape}, ${name}: one outcome, drawn after the steps on the turn's anchor`, () => {
        const conversation = outcome.prepare(turnOf(shape));
        const rows = conversation.ids.map((id) => conversation.messages[id]!);
        const anchor = toolOnlyTurnAnchor(rows);
        expect(anchor?.role).toBe('assistant');
        // The anchor stands for the turn's last row, so it follows the steps.
        expect(anchor?.id).toBe(`${conversation.ids.at(-1)!}:outcome`);

        const resolved = resolveTurnOutcome(conversation, outcome.facts);
        expect(resolved.state).toEqual(outcome.expected);
        expect(resolved.assistantId).toBe(anchor?.id);
        expect(resolved.rowId).toBe(conversation.ids.at(-1));
        expect(turnStateOf(resolved, anchor!)).toEqual(outcome.expected);
        // No real row carries the state, and no other one does.
        for (const id of conversation.ids) {
          expect(turnStateOf(resolved, conversation.messages[id]!)).toBeUndefined();
        }
        // The stop line the state replaces is gone, so it is said once.
        for (const id of resolved.conversation.ids) {
          expect(
            (resolveMessageNotes(resolved.conversation.messages[id]!) ?? []).filter(
              (entry) => entry.kind === 'stopped',
            ),
          ).toEqual([]);
        }
      });
    }

    test(`${shape}, still running or held: no outcome yet`, () => {
      const conversation = turnOf(shape);
      expect(resolveTurnOutcome(conversation, { ...IDLE, running: true }).state).toBeUndefined();
      expect(resolveTurnOutcome(conversation, { ...IDLE, holding: true }).state).toBeUndefined();
    });
  }

  test('has no anchor when the turn has an assistant message, no tool call, or a call still waiting', () => {
    const asked = appendUserMessage(createConversationHistory({ id: 'c' }), 'Hello');
    expect(toolOnlyTurnAnchor([asked.messages[asked.ids[0]!]!])).toBeUndefined();
    const called = appendToolCall(asked, { id: 'c1', name: 'lookup', arguments: {} });
    const parked = appendToolResult(called, {
      callId: 'c1',
      outcome: 'action_required',
      content: '',
    });
    expect(resolveTurnOutcome(parked, IDLE).state).toBeUndefined();
    expect(resolveTurnOutcome(called, IDLE).state).toBeUndefined();
  });
});
