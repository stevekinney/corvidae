/**
 * What happens to a turn when the person presses one of its recovery controls (COR-2725). Chat owns
 * the presentation of that command: one command in flight per turn, a press that cannot apply to the
 * turn's state does nothing, a receipt that arrives for another session or for a state the turn has
 * left changes nothing, and a command that did not go through is said once, on its own turn.
 *
 * Main's behaviour before this module: every press reached the host, every receipt was applied.
 */

import type { ChatTurnState } from './turn-state.ts';

/** The recovery controls a turn can offer. */
export type TurnCommandKind = 'reconnect' | 'retry' | 'discard' | 'continue' | 'regenerate';

/** How the host answered a command. */
export type TurnCommandResult = 'applied' | 'refused' | 'failed';

/** Proof that a command was started, handed back to {@link TurnCommands.settle}. */
export type TurnCommandToken = {
  readonly command: TurnCommandKind;
  readonly turnId: string;
  readonly scope: string;
};

/** Whether a press started a command, and why not when it did not. */
export type TurnCommandStart =
  | { readonly status: 'started'; readonly token: TurnCommandToken }
  | { readonly status: 'ignored'; readonly reason: 'duplicate' | 'busy' | 'not-applicable' };

/** The states each command applies to. */
export const TURN_COMMAND_STATES: Readonly<
  Record<TurnCommandKind, readonly ChatTurnState['kind'][]>
> = {
  reconnect: ['reconnecting'],
  retry: ['failed', 'empty'],
  discard: ['stopped'],
  continue: ['stopped'],
  regenerate: ['complete'],
};

export class TurnCommands {
  #scope: string;

  constructor(scope: string) {
    this.#scope = scope;
  }

  /** A new session is shown: whatever was in flight or said belongs to the one that went. */
  setScope(scope: string): void {
    this.#scope = scope;
  }

  begin(command: TurnCommandKind, turnId: string, _state: ChatTurnState): TurnCommandStart {
    return { status: 'started', token: { command, turnId, scope: this.#scope } };
  }

  settle(_token: TurnCommandToken, _result: TurnCommandResult): 'applied' | 'stale' {
    return 'applied';
  }

  /** The turn's state moved on: a command it no longer applies to is dropped. */
  reconcile(_turnId: string, _state: ChatTurnState): void {}

  /** The command in flight on a turn. */
  pending(_turnId: string): TurnCommandKind | undefined {
    return undefined;
  }

  /** The command that did not go through on a turn, until the next press or a state that drops it. */
  failure(_turnId: string): TurnCommandKind | undefined {
    return undefined;
  }
}
