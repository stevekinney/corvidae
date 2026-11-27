/**
 * COR-2725: the outcome matrix. Every input a turn's recovery can meet, crossed with every state a
 * turn can be in, names the one visible outcome and whether the same input repeated is a no-op.
 *
 * Visible outcomes are `idle` (nothing is pending or said), `busy:<command>` (one command in
 * flight, its control disabled) and `failed:<command>` (one line on the turn says it did not go
 * through). Each cell is `[after the input, after the same input repeated]`.
 */

import { describe, expect, test } from 'bun:test';

import { TurnCommands, type TurnCommandKind } from './turn-commands.ts';
import { advanceTurnState, type ChatTurnState } from './turn-state.ts';

const STATES = {
  streaming: { kind: 'streaming' },
  reconnecting: { kind: 'reconnecting', attempt: 2, attempts: 5, nextTryIn: 8, wait: 10 },
  stopped: { kind: 'stopped' },
  failed: { kind: 'failed', cause: 'The provider dropped the connection.' },
  empty: { kind: 'empty' },
  complete: { kind: 'complete' },
} as const satisfies Record<string, ChatTurnState>;
type StateName = keyof typeof STATES;

const TURN = 'turn-1';

/** What a person sees on the turn. */
function visible(commands: TurnCommands): string {
  const pending = commands.pending(TURN);
  if (pending !== undefined) return `busy:${pending}`;
  const failure = commands.failure(TURN);
  return failure === undefined ? 'idle' : `failed:${failure}`;
}

function commandsFor(state: StateName): TurnCommands {
  const commands = new TurnCommands('session-a');
  commands.reconcile(TURN, STATES[state]);
  return commands;
}

/** The first command that applies to a state, which the inputs that need a command in flight use. */
function applicableTo(state: StateName): TurnCommandKind | undefined {
  const commands: TurnCommandKind[] = ['reconnect', 'retry', 'discard', 'continue', 'regenerate'];
  return commands.find(
    (command) => new TurnCommands('probe').begin(command, TURN, STATES[state]).status === 'started',
  );
}

/** One person's press of `command`, then the same press again. */
function press(state: StateName, command: TurnCommandKind): [string, string] {
  const commands = commandsFor(state);
  commands.begin(command, TURN, STATES[state]);
  const first = visible(commands);
  commands.begin(command, TURN, STATES[state]);
  return [first, visible(commands)];
}

type Input =
  | 'reconnect'
  | 'retry'
  | 'discard'
  | 'continue'
  | 'regenerate'
  | 'cancellation'
  | 'stale completion after a session switch'
  | 'late receipt'
  | 'duplicate reconnect';

const DRIVERS: Record<Input, (state: StateName) => [string, string]> = {
  reconnect: (state) => press(state, 'reconnect'),
  retry: (state) => press(state, 'retry'),
  discard: (state) => press(state, 'discard'),
  continue: (state) => press(state, 'continue'),
  regenerate: (state) => press(state, 'regenerate'),
  // The person stops the run while a command is in flight: the host's `stop` event moves the turn.
  cancellation: (state) => {
    const commands = commandsFor(state);
    const command = applicableTo(state);
    if (command !== undefined) commands.begin(command, TURN, STATES[state]);
    const stopped = advanceTurnState(STATES[state], { type: 'stop' });
    commands.reconcile(TURN, stopped);
    const first = visible(commands);
    commands.reconcile(TURN, stopped);
    return [first, visible(commands)];
  },
  // The host answers a command after the person moved to another session.
  'stale completion after a session switch': (state) => {
    const commands = commandsFor(state);
    const command = applicableTo(state);
    if (command === undefined) return [visible(commands), visible(commands)];
    const started = commands.begin(command, TURN, STATES[state]);
    commands.setScope('session-b');
    commands.reconcile(TURN, STATES[state]);
    if (started.status === 'started') commands.settle(started.token, 'failed');
    const first = visible(commands);
    if (started.status === 'started') commands.settle(started.token, 'failed');
    return [first, visible(commands)];
  },
  // The host answers a command after the turn already moved to a state the command no longer fits.
  'late receipt': (state) => {
    const commands = commandsFor(state);
    const command = applicableTo(state);
    if (command === undefined) return [visible(commands), visible(commands)];
    const started = commands.begin(command, TURN, STATES[state]);
    commands.reconcile(TURN, state === 'complete' ? STATES.streaming : STATES.complete);
    if (started.status === 'started') commands.settle(started.token, 'failed');
    const first = visible(commands);
    if (started.status === 'started') commands.settle(started.token, 'failed');
    return [first, visible(commands)];
  },
  // The person presses Retry now twice, and the host then answers once.
  'duplicate reconnect': (state) => {
    const commands = commandsFor(state);
    const first = commands.begin('reconnect', TURN, STATES[state]);
    const second = commands.begin('reconnect', TURN, STATES[state]);
    if (first.status === 'started') commands.settle(first.token, 'applied');
    // One started command at most, however many presses.
    return [
      `${first.status}/${second.status === 'ignored' ? second.reason : second.status}`,
      visible(commands),
    ];
  },
};

/** The matrix: `[after the input, after it repeated]` for each state, as a person sees the turn. */
const MATRIX: Record<Input, Record<StateName, [string, string]>> = {
  reconnect: {
    streaming: ['idle', 'idle'],
    reconnecting: ['busy:reconnect', 'busy:reconnect'],
    stopped: ['idle', 'idle'],
    failed: ['idle', 'idle'],
    empty: ['idle', 'idle'],
    complete: ['idle', 'idle'],
  },
  retry: {
    streaming: ['idle', 'idle'],
    reconnecting: ['idle', 'idle'],
    stopped: ['idle', 'idle'],
    failed: ['busy:retry', 'busy:retry'],
    empty: ['busy:retry', 'busy:retry'],
    complete: ['idle', 'idle'],
  },
  discard: {
    streaming: ['idle', 'idle'],
    reconnecting: ['idle', 'idle'],
    stopped: ['busy:discard', 'busy:discard'],
    failed: ['idle', 'idle'],
    empty: ['idle', 'idle'],
    complete: ['idle', 'idle'],
  },
  continue: {
    streaming: ['idle', 'idle'],
    reconnecting: ['idle', 'idle'],
    stopped: ['busy:continue', 'busy:continue'],
    failed: ['idle', 'idle'],
    empty: ['idle', 'idle'],
    complete: ['idle', 'idle'],
  },
  regenerate: {
    streaming: ['idle', 'idle'],
    reconnecting: ['idle', 'idle'],
    stopped: ['idle', 'idle'],
    failed: ['idle', 'idle'],
    empty: ['idle', 'idle'],
    complete: ['busy:regenerate', 'busy:regenerate'],
  },
  // Stopping the run drops a reconnect in flight; a stopped turn keeps its Discard or Continue.
  cancellation: {
    streaming: ['idle', 'idle'],
    reconnecting: ['idle', 'idle'],
    stopped: ['busy:discard', 'busy:discard'],
    failed: ['busy:retry', 'busy:retry'],
    empty: ['busy:retry', 'busy:retry'],
    complete: ['busy:regenerate', 'busy:regenerate'],
  },
  'stale completion after a session switch': {
    streaming: ['idle', 'idle'],
    reconnecting: ['idle', 'idle'],
    stopped: ['idle', 'idle'],
    failed: ['idle', 'idle'],
    empty: ['idle', 'idle'],
    complete: ['idle', 'idle'],
  },
  'late receipt': {
    streaming: ['idle', 'idle'],
    reconnecting: ['idle', 'idle'],
    stopped: ['idle', 'idle'],
    failed: ['idle', 'idle'],
    empty: ['idle', 'idle'],
    complete: ['idle', 'idle'],
  },
  'duplicate reconnect': {
    streaming: ['ignored/not-applicable', 'idle'],
    reconnecting: ['started/duplicate', 'idle'],
    stopped: ['ignored/not-applicable', 'idle'],
    failed: ['ignored/not-applicable', 'idle'],
    empty: ['ignored/not-applicable', 'idle'],
    complete: ['ignored/not-applicable', 'idle'],
  },
};

describe('the outcome matrix', () => {
  for (const input of Object.keys(MATRIX) as Input[]) {
    for (const state of Object.keys(STATES) as StateName[]) {
      test(`${input} on a ${state} turn: ${MATRIX[input][state].join(', then ')}`, () => {
        expect(DRIVERS[input](state)).toEqual(MATRIX[input][state]);
      });
    }
  }
});

describe('a command that did not go through', () => {
  test('is said once on its own turn, replaced by the next press, and cleared by success', () => {
    const commands = commandsFor('failed');
    const first = commands.begin('retry', TURN, STATES.failed);
    if (first.status !== 'started') throw new Error('The press was ignored.');
    expect(commands.settle(first.token, 'failed')).toBe('applied');
    expect(visible(commands)).toBe('failed:retry');
    // A receipt cannot be applied twice.
    expect(commands.settle(first.token, 'applied')).toBe('stale');
    expect(visible(commands)).toBe('failed:retry');

    const second = commands.begin('retry', TURN, STATES.failed);
    if (second.status !== 'started') throw new Error('The press was ignored.');
    expect(visible(commands)).toBe('busy:retry');
    expect(commands.settle(second.token, 'applied')).toBe('applied');
    expect(visible(commands)).toBe('idle');
  });

  test('is cleared when the turn moves to a state the command no longer fits', () => {
    const commands = commandsFor('stopped');
    const started = commands.begin('continue', TURN, STATES.stopped);
    if (started.status !== 'started') throw new Error('The press was ignored.');
    commands.settle(started.token, 'refused');
    expect(visible(commands)).toBe('failed:continue');
    commands.reconcile(TURN, STATES.streaming);
    expect(visible(commands)).toBe('idle');
  });

  test('failed() names every turn that says one, and none once it is cleared or the turn moves on', () => {
    const commands = new TurnCommands('session-a');
    commands.reconcile('turn-a', STATES.stopped);
    commands.reconcile('turn-b', STATES.failed);
    commands.reconcile('turn-c', STATES.stopped);
    expect(commands.failed()).toEqual([]);

    const a = commands.begin('continue', 'turn-a', STATES.stopped);
    const b = commands.begin('retry', 'turn-b', STATES.failed);
    const c = commands.begin('discard', 'turn-c', STATES.stopped);
    if (a.status !== 'started' || b.status !== 'started' || c.status !== 'started') {
      throw new Error('A press was ignored.');
    }
    // A command in flight is not a refusal.
    expect(commands.failed()).toEqual([]);
    commands.settle(a.token, 'refused');
    commands.settle(b.token, 'failed');
    commands.settle(c.token, 'applied');
    expect(commands.failed()).toEqual(['turn-a', 'turn-b']);

    commands.reconcile('turn-a', STATES.streaming);
    expect(commands.failed()).toEqual(['turn-b']);
    commands.release('turn-b');
    expect(commands.failed()).toEqual([]);
  });

  test('one command in flight keeps the other controls of its turn from starting another', () => {
    const commands = commandsFor('stopped');
    expect(commands.begin('continue', TURN, STATES.stopped).status).toBe('started');
    expect(commands.begin('discard', TURN, STATES.stopped)).toEqual({
      status: 'ignored',
      reason: 'busy',
    });
  });
});
