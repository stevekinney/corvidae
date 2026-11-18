/**
 * Which turn Chat draws as reconnecting, and what it says (COR-2283 R3).
 */
import {
  CINDER_NOTES_METADATA_KEY,
  createConversationHistory,
  type Message,
} from '@lostgradient/chat';
import { describe, expect, test } from 'bun:test';

import type { ChatReconnect } from './chat-session.svelte.ts';
import {
  lastAssistantId,
  lastTurnStop,
  reconnectingTurnState,
  turnStateOf,
  withoutStopLine,
} from './turn-states.ts';

const NOW = 1_000_000;
const schedule = (overrides: Partial<ChatReconnect> = {}): ChatReconnect => ({
  attempt: 2,
  attempts: 7,
  wait: 1000,
  nextTryAt: NOW + 400,
  runDropped: true,
  ...overrides,
});
const message = (id: string, role: Message['role']) => ({ id, role }) as Message;

describe('the reconnecting turn', () => {
  test('is the last assistant turn of a run whose stream dropped, with its try, of how many, and the seconds left', () => {
    expect(
      turnStateOf(message('a2', 'assistant'), {
        reconnect: schedule(),
        lastAssistantId: 'a2',
        now: () => NOW,
      }),
    ).toEqual({ kind: 'reconnecting', attempt: 2, attempts: 7, nextTryIn: 1, wait: 1 });
  });

  test('is no turn while the stream is up, for an earlier turn, a person’s message, or a first read that failed', () => {
    const facts = { reconnect: schedule(), lastAssistantId: 'a2', now: () => NOW };
    expect(turnStateOf(message('a2', 'assistant'), { ...facts, reconnect: undefined })).toBe(
      undefined,
    );
    expect(turnStateOf(message('a1', 'assistant'), facts)).toBeUndefined();
    expect(turnStateOf(message('u1', 'user'), facts)).toBeUndefined();
    expect(
      turnStateOf(message('a2', 'assistant'), {
        ...facts,
        reconnect: schedule({ runDropped: false }),
      }),
    ).toBeUndefined();
  });

  test('counts down to zero and never below it', () => {
    expect(reconnectingTurnState(schedule({ nextTryAt: NOW + 7_100, wait: 8000 }), NOW)).toEqual({
      kind: 'reconnecting',
      attempt: 2,
      attempts: 7,
      nextTryIn: 8,
      wait: 8,
    });
    expect(reconnectingTurnState(schedule({ nextTryAt: NOW - 50 }), NOW).nextTryIn).toBe(0);
  });
});

describe('the stopped and failed turn (COR-2437)', () => {
  const noted = (id: string, role: Message['role'], notes?: readonly object[]) =>
    ({
      id,
      role,
      metadata: notes === undefined ? {} : { [CINDER_NOTES_METADATA_KEY]: notes },
    }) as unknown as Message;
  const historyOf = (rows: readonly Message[]) => {
    const base = createConversationHistory({ id: 'c' });
    return {
      ...base,
      ids: rows.map((row) => row.id),
      messages: Object.fromEntries(rows.map((row) => [row.id, row])),
    } as unknown as typeof base;
  };
  const stoppedLine = { kind: 'stopped', id: 'stopped:run', reason: 'The run was stopped.' };
  const failedLine = { kind: 'stopped', id: 'stopped:run', reason: 'It failed.', failed: true };

  test('reads the last turn the person stopped as stopped, and one whose run failed as failed with its line', () => {
    const stopped = historyOf([
      noted('u1', 'user'),
      noted('run:step:0', 'assistant', [stoppedLine]),
    ]);
    expect(lastTurnStop(stopped)).toEqual({
      state: { kind: 'stopped' },
      rowId: 'run:step:0',
      noteId: 'stopped:run',
      ended: false,
    });
    const failed = historyOf([noted('u1', 'user'), noted('run:step:0', 'assistant', [failedLine])]);
    expect(lastTurnStop(failed)?.state).toEqual({ kind: 'failed', cause: 'It failed.' });
  });

  // COR-2437: a turn that went on holds its stopped run's line on record; the continuation that
  // wrote the last reply did not stop, so the turn draws no stop.
  test('reads nothing for a turn that went on after its run stopped', () => {
    const hiddenContinuation: Message = { ...noted('run:continuation', 'user'), hidden: true };
    expect(
      lastTurnStop(
        historyOf([
          noted('u1', 'user'),
          noted('run:step:0', 'assistant', [stoppedLine]),
          hiddenContinuation,
          noted('next:step:0', 'assistant'),
        ]),
      ),
    ).toBeUndefined();
  });

  // The design review of 38cbd2dec, note 2: a chat the server ended kept its old status line while
  // every other stop is Chat's alert. It is a stop, with the notice's sentence as why, and ended.
  test('reads a server’s notice as a stop that says why, and that cannot go on', () => {
    const notice = {
      kind: 'stopped',
      id: 'ended',
      reason: 'This chat has ended. The server stopped it when it restarted.',
      notice: true,
    };
    expect(
      lastTurnStop(historyOf([noted('u1', 'user'), noted('run:step:0', 'assistant', [notice])])),
    ).toEqual({
      state: {
        kind: 'stopped',
        reason: 'This chat has ended. The server stopped it when it restarted.',
      },
      rowId: 'run:step:0',
      noteId: 'ended',
      ended: true,
    });
  });

  test('reads nothing for an earlier turn, or a turn with no reply to draw on', () => {
    expect(
      lastTurnStop(
        historyOf([
          noted('u1', 'user'),
          noted('a1', 'assistant', [stoppedLine]),
          noted('u2', 'user'),
          noted('a2', 'assistant'),
        ]),
      ),
    ).toBeUndefined();
    expect(lastTurnStop(historyOf([noted('u1', 'user', [stoppedLine])]))).toBeUndefined();
  });

  test('takes the line it read off its row, and keeps the row’s other notes', () => {
    const memory = { kind: 'memory', id: 'm', recordId: 'r', collection: 'c', memoryClass: 'x' };
    const history = historyOf([
      noted('u1', 'user'),
      noted('a1', 'assistant', [memory, stoppedLine]),
    ]);
    const stop = lastTurnStop(history);

    const shown = withoutStopLine(history, stop);

    expect(shown.messages['a1']?.metadata?.[CINDER_NOTES_METADATA_KEY]).toEqual([memory]);
    expect(withoutStopLine(history, undefined)).toBe(history);
  });

  test('draws the stop on the last assistant turn, and the reconnect over it while one is under way', () => {
    const facts = { reconnect: undefined, lastAssistantId: 'a2', now: () => NOW };
    expect(
      turnStateOf(message('a2', 'assistant'), { ...facts, stop: { kind: 'stopped' } }),
    ).toEqual({ kind: 'stopped' });
    expect(
      turnStateOf(message('a1', 'assistant'), { ...facts, stop: { kind: 'stopped' } }),
    ).toBeUndefined();
    expect(
      turnStateOf(message('a2', 'assistant'), {
        ...facts,
        reconnect: schedule(),
        stop: { kind: 'stopped' },
      })?.kind,
    ).toBe('reconnecting');
  });
});

describe('the last assistant turn', () => {
  test('is the last assistant row after the person’s last message, or none', () => {
    const conversation = createConversationHistory({ id: 'c' });
    expect(lastAssistantId(conversation)).toBeUndefined();
    const answered = {
      ...conversation,
      ids: ['u1', 'a1', 'a2'],
      messages: {
        u1: message('u1', 'user'),
        a1: message('a1', 'assistant'),
        a2: message('a2', 'assistant'),
      },
    } as unknown as typeof conversation;
    expect(lastAssistantId(answered)).toBe('a2');
    // A turn whose reply has no row yet marks nothing: never the previous turn's finished answer.
    const asked = {
      ...answered,
      ids: ['u1', 'a1', 'u2'],
      messages: { ...answered.messages, u2: message('u2', 'user') },
    } as unknown as typeof conversation;
    expect(lastAssistantId(asked)).toBeUndefined();
  });
});
