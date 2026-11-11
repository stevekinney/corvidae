/**
 * COR-2283: the states an assistant turn moves through (rows R2 to R6 of the run-states board),
 * the transitions between them, what each state draws, and the words each state says.
 */

import { describe, expect, test } from 'bun:test';

import { DEFAULT_TURN_LABELS, resolveTurnLabels } from './turn-labels.ts';
import {
  advanceTurnState,
  effectiveTurnState,
  isChatTurnState,
  presentTurnState,
  reconnectWaitFraction,
  type ChatTurnEvent,
  type ChatTurnState,
} from './turn-state.ts';

const streaming: ChatTurnState = { kind: 'streaming' };
const reconnecting: ChatTurnState = {
  kind: 'reconnecting',
  attempt: 2,
  attempts: 5,
  nextTryIn: 8,
  wait: 10,
};
const stopped: ChatTurnState = { kind: 'stopped' };
const failed: Extract<ChatTurnState, { kind: 'failed' }> = {
  kind: 'failed',
  cause: 'The model provider dropped the connection.',
  keeps: 'Retry keeps the text above.',
};
const empty: ChatTurnState = { kind: 'empty' };
const complete: ChatTurnState = { kind: 'complete' };

const lost: ChatTurnEvent = {
  type: 'connection-lost',
  attempt: 2,
  attempts: 5,
  nextTryIn: 8,
  wait: 10,
};

describe('advanceTurnState', () => {
  // Every transition the board's rows name, from the state the row starts in.
  const transitions: ReadonlyArray<[string, ChatTurnState, ChatTurnEvent, ChatTurnState]> = [
    ['R3: a stream that drops starts reconnecting', streaming, lost, reconnecting],
    [
      'R3: a failed try schedules the next one',
      reconnecting,
      { type: 'connection-lost', attempt: 3, attempts: 5, nextTryIn: 16 },
      { kind: 'reconnecting', attempt: 3, attempts: 5, nextTryIn: 16 },
    ],
    [
      'R3: a stream that comes back streams again',
      reconnecting,
      { type: 'reconnected' },
      streaming,
    ],
    ['R4: Stop while streaming stops the turn', streaming, { type: 'stop' }, stopped],
    ['R4: Stop while reconnecting stops the turn', reconnecting, { type: 'stop' }, stopped],
    ['R4: Continue picks a stopped turn up again', stopped, { type: 'continue' }, streaming],
    [
      'R5: a run that fails while streaming leaves a failed turn',
      streaming,
      { type: 'fail', cause: failed.cause, keeps: failed.keeps },
      failed,
    ],
    [
      'R5: a run that gives up reconnecting leaves a failed turn',
      reconnecting,
      { type: 'fail', cause: 'Five tries failed.' },
      { kind: 'failed', cause: 'Five tries failed.' },
    ],
    ['R5: Retry runs a failed turn again', failed, { type: 'retry' }, streaming],
    [
      'R6: a run that ends with no answer leaves an empty turn',
      streaming,
      { type: 'finish', answered: false },
      empty,
    ],
    ['R6: Try again asks an empty turn again', empty, { type: 'retry' }, streaming],
    [
      'a run that ends with an answer completes',
      streaming,
      { type: 'finish', answered: true },
      complete,
    ],
    [
      'a stream that drains after reconnecting completes',
      reconnecting,
      { type: 'finish', answered: true },
      complete,
    ],
  ];

  for (const [name, from, event, to] of transitions) {
    test(name, () => {
      expect(advanceTurnState(from, event)).toEqual(to);
    });
  }

  test('an event that does not apply leaves the state as it was', () => {
    const stale: ReadonlyArray<[ChatTurnState, ChatTurnEvent]> = [
      [complete, lost],
      [stopped, lost],
      [failed, { type: 'reconnected' }],
      [streaming, { type: 'reconnected' }],
      [complete, { type: 'stop' }],
      [streaming, { type: 'continue' }],
      [failed, { type: 'continue' }],
      [complete, { type: 'retry' }],
      [stopped, { type: 'retry' }],
      [complete, { type: 'fail', cause: 'late' }],
      [stopped, { type: 'finish', answered: true }],
      [failed, { type: 'finish', answered: false }],
    ];
    for (const [state, event] of stale) {
      expect(advanceTurnState(state, event)).toBe(state);
    }
  });
});

describe('presentTurnState', () => {
  test('R2: a streaming turn ends in a caret and has no line yet', () => {
    expect(presentTurnState(streaming)).toEqual({
      line: false,
      caret: true,
      muted: false,
      regenerate: false,
    });
  });

  test('R3: a reconnecting turn is muted, with no caret and no line', () => {
    expect(presentTurnState(reconnecting)).toEqual({
      line: false,
      caret: false,
      muted: true,
      regenerate: false,
    });
  });

  test('R4 and R5: a stopped or failed turn keeps its line and offers no Regenerate', () => {
    for (const state of [stopped, failed]) {
      expect(presentTurnState(state)).toEqual({
        line: true,
        caret: false,
        muted: false,
        regenerate: false,
      });
    }
  });

  test('R6: an empty turn has no line, so no time stands alone under it', () => {
    expect(presentTurnState(empty).line).toBe(false);
  });

  test('a complete turn has its line and offers Regenerate', () => {
    expect(presentTurnState(complete)).toEqual({
      line: true,
      caret: false,
      muted: false,
      regenerate: true,
    });
  });
});

describe('effectiveTurnState', () => {
  test('the host’s well-formed state wins over what Chat sees', () => {
    expect(effectiveTurnState(stopped, true, true)).toEqual(stopped);
    expect(effectiveTurnState(reconnecting, true, false)).toEqual(reconnecting);
  });

  test('without one, a turn streams while text arrives or it is marked unfinished, and completes after', () => {
    expect(effectiveTurnState(undefined, true, false)).toEqual(streaming);
    expect(effectiveTurnState(undefined, false, true)).toEqual(streaming);
    expect(effectiveTurnState(undefined, false, false)).toEqual(complete);
  });

  test('a malformed state falls back as if the host gave none', () => {
    const malformed = { kind: 'reconnecting', attempt: 6, attempts: 5, nextTryIn: 3 };
    expect(effectiveTurnState(malformed as unknown as ChatTurnState, false, false)).toEqual(
      complete,
    );
  });
});

describe('isChatTurnState', () => {
  test('accepts every state the union names', () => {
    for (const state of [streaming, reconnecting, stopped, failed, empty, complete]) {
      expect(isChatTurnState(state)).toBe(true);
    }
    expect(isChatTurnState({ kind: 'failed', cause: 'Timed out.' })).toBe(true);
  });

  test('rejects a value that is not a turn state', () => {
    for (const value of [
      undefined,
      null,
      'streaming',
      {},
      { kind: 'paused' },
      { kind: 'failed' },
      { kind: 'failed', cause: 'x', keeps: 3 },
      { kind: 'reconnecting', attempt: 0, attempts: 5, nextTryIn: 3 },
      { kind: 'reconnecting', attempt: 1.5, attempts: 5, nextTryIn: 3 },
      { kind: 'reconnecting', attempt: 1, attempts: 5, nextTryIn: -1 },
      { kind: 'reconnecting', attempt: 1, attempts: 5, nextTryIn: 3, wait: 'soon' },
    ]) {
      expect(isChatTurnState(value)).toBe(false);
    }
  });
});

describe('reconnectWaitFraction', () => {
  test('the bar drains from full to empty over the wait', () => {
    expect(
      reconnectWaitFraction({
        kind: 'reconnecting',
        attempt: 1,
        attempts: 3,
        nextTryIn: 10,
        wait: 10,
      }),
    ).toBe(1);
    expect(
      reconnectWaitFraction({
        kind: 'reconnecting',
        attempt: 1,
        attempts: 3,
        nextTryIn: 4,
        wait: 10,
      }),
    ).toBe(0.4);
    expect(
      reconnectWaitFraction({
        kind: 'reconnecting',
        attempt: 1,
        attempts: 3,
        nextTryIn: 0,
        wait: 10,
      }),
    ).toBe(0);
  });

  test('without a wait the bar starts full, and a zero wait is empty', () => {
    expect(
      reconnectWaitFraction({ kind: 'reconnecting', attempt: 1, attempts: 3, nextTryIn: 6 }),
    ).toBe(1);
    expect(
      reconnectWaitFraction({ kind: 'reconnecting', attempt: 1, attempts: 3, nextTryIn: 0 }),
    ).toBe(0);
  });
});

describe('turn labels', () => {
  test('R3: the reconnecting warning reads exactly as the board writes it', () => {
    expect(DEFAULT_TURN_LABELS.reconnecting(2, 5, 8)).toBe(
      'Connection lost. Reconnecting, attempt 2 of 5. Next try in 8 s.',
    );
  });

  test('R4 to R7: the default words, with no middle dot as a separator', () => {
    expect(DEFAULT_TURN_LABELS.stopped).toBe('Stopped by you, partial answer');
    expect(DEFAULT_TURN_LABELS.incomplete).toBe('This answer is incomplete.');
    expect(DEFAULT_TURN_LABELS.empty).toBe('The agent finished without writing an answer.');
    expect(DEFAULT_TURN_LABELS.tryAgain).toBe('Try again');
    expect(DEFAULT_TURN_LABELS.stepPosition(2, 3)).toBe('Step 2 of 3');
    expect(DEFAULT_TURN_LABELS.stepsDone(2, 3)).toBe('2 of 3 steps');
    expect(DEFAULT_TURN_LABELS.retryStep).toBe('Retry this step');
    expect(DEFAULT_TURN_LABELS.copyError).toBe('Copy error');
    for (const value of Object.values(DEFAULT_TURN_LABELS)) {
      const text = typeof value === 'function' ? value(1, 2, 3) : value;
      expect(text).not.toContain(String.fromCodePoint(0xb7));
    }
  });

  test('a host replaces any word and keeps the rest', () => {
    const labels = resolveTurnLabels({
      stepsDone: (done, total) => `Checked ${done} of ${total} sources`,
    });
    expect(labels.stepsDone(2, 3)).toBe('Checked 2 of 3 sources');
    expect(labels.retryStep).toBe('Retry this step');
    expect(resolveTurnLabels(undefined)).toBe(DEFAULT_TURN_LABELS);
  });
});
