/**
 * What happens to a turn when the person presses one of its recovery controls (COR-2725). Chat owns
 * the presentation of that command: one command in flight per turn, a press that cannot apply to the
 * turn's state does nothing, a receipt that arrives for another session or for a state the turn has
 * left changes nothing, and a command that did not go through is said once, on its own turn.
 *
 * The host owns the command itself, and answers it by returning (or resolving) `false` when it
 * refused it, by throwing when it failed, and by anything else when it went through. Every host
 * callback of a turn is the same shape, so a host that returns nothing is a host whose commands
 * always go through.
 */

import { createSubscriber } from 'svelte/reactivity';

import type { ChatTurnState } from './turn-state.ts';

/** The recovery controls a turn can offer. */
export type TurnCommandKind = 'reconnect' | 'retry' | 'discard' | 'continue' | 'regenerate';

/** How the host answered a command. */
export type TurnCommandResult = 'applied' | 'refused' | 'failed';

/** What a host callback for a turn command may return. */
export type TurnCommandAnswer = void | boolean | Promise<void | boolean>;

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
const TURN_COMMAND_STATES: Readonly<Record<TurnCommandKind, readonly ChatTurnState['kind'][]>> = {
  reconnect: ['reconnecting'],
  retry: ['failed', 'empty'],
  discard: ['stopped'],
  continue: ['stopped'],
  regenerate: ['complete'],
};

/** Whether `command` can act on a turn in `state`. */
export function commandApplies(command: TurnCommandKind, state: ChatTurnState['kind']): boolean {
  return TURN_COMMAND_STATES[command].includes(state);
}

const applies = commandApplies;

type TurnEntry = {
  pending: TurnCommandToken | undefined;
  failure: TurnCommandKind | undefined;
};

/**
 * The commands of the turns of one session. A session switch ({@link setScope}) or a disposal
 * forgets them all, so an answer for a session that is no longer shown is stale.
 */
export class TurnCommands {
  #scope: string;
  readonly #entries = new Map<string, TurnEntry>();
  #update: (() => void) | undefined;
  /** Reads made inside an effect or a derived run again when a command starts, settles or is dropped. */
  readonly #track = createSubscriber((update) => {
    this.#update = update;
    return () => {
      this.#update = undefined;
    };
  });

  constructor(scope: string) {
    this.#scope = scope;
  }

  #changed(): void {
    this.#update?.();
  }

  /** A new session is shown: whatever was in flight or said belongs to the one that went. */
  setScope(scope: string): void {
    if (scope === this.#scope) return;
    this.#scope = scope;
    this.#forget();
  }

  /** The session is gone: every answer that arrives after this is stale. */
  dispose(): void {
    this.#scope = `disposed:${this.#scope}`;
    this.#entries.clear();
  }

  /** Whether `command` can start on a turn in `state`, and starts it when it can. */
  begin(command: TurnCommandKind, turnId: string, state: ChatTurnState): TurnCommandStart {
    if (!applies(command, state.kind)) return { status: 'ignored', reason: 'not-applicable' };
    const entry = this.#entry(turnId);
    if (entry.pending !== undefined) {
      return {
        status: 'ignored',
        reason: entry.pending.command === command ? 'duplicate' : 'busy',
      };
    }
    const token: TurnCommandToken = { command, turnId, scope: this.#scope };
    entry.pending = token;
    entry.failure = undefined;
    this.#changed();
    return { status: 'started', token };
  }

  /**
   * The host's answer to a command. An answer for another session, for a command that was dropped
   * when its turn moved on, or for one already answered is `stale` and changes nothing.
   */
  settle(token: TurnCommandToken, result: TurnCommandResult): 'applied' | 'stale' {
    if (token.scope !== this.#scope) return 'stale';
    const entry = this.#entries.get(token.turnId);
    if (entry?.pending !== token) return 'stale';
    entry.pending = undefined;
    entry.failure = result === 'applied' ? undefined : token.command;
    this.#prune(token.turnId, entry);
    this.#changed();
    return 'applied';
  }

  /** The turn's state moved on: a command it no longer applies to is dropped, and so is what it said. */
  reconcile(turnId: string, state: ChatTurnState): void {
    const entry = this.#entries.get(turnId);
    if (entry === undefined) return;
    let changed = false;
    if (entry.pending !== undefined && !applies(entry.pending.command, state.kind)) {
      entry.pending = undefined;
      changed = true;
    }
    if (entry.failure !== undefined && !applies(entry.failure, state.kind)) {
      entry.failure = undefined;
      changed = true;
    }
    this.#prune(turnId, entry);
    if (changed) this.#changed();
  }

  /**
   * A turn's row is gone, which for an outcome anchor means its outcome ended: what was in flight
   * or said on it belongs to the outcome that went, and an answer for it is stale.
   */
  release(turnId: string): void {
    if (this.#entries.delete(turnId)) this.#changed();
  }

  /** The command in flight on a turn. */
  pending(turnId: string): TurnCommandKind | undefined {
    this.#track();
    return this.#entries.get(turnId)?.pending?.command;
  }

  /** The command that did not go through on a turn, until the next press or a state that drops it. */
  failure(turnId: string): TurnCommandKind | undefined {
    this.#track();
    return this.#entries.get(turnId)?.failure;
  }

  /** The turns that say a command did not go through. */
  failed(): readonly string[] {
    this.#track();
    const turns: string[] = [];
    for (const [turnId, entry] of this.#entries) {
      if (entry.failure !== undefined) turns.push(turnId);
    }
    return turns;
  }

  /**
   * Presses `command` on a turn: starts it, asks the host, and settles it with what the host
   * answered. Resolves what became of the press; a press that was ignored never reaches the host.
   */
  async run(
    command: TurnCommandKind,
    turnId: string,
    state: ChatTurnState,
    host: () => TurnCommandAnswer,
  ): Promise<TurnCommandResult | 'ignored' | 'stale'> {
    const start = this.begin(command, turnId, state);
    if (start.status === 'ignored') return 'ignored';
    let result: TurnCommandResult;
    try {
      result = (await host()) === false ? 'refused' : 'applied';
    } catch {
      result = 'failed';
    }
    return this.settle(start.token, result) === 'stale' ? 'stale' : result;
  }

  #entry(turnId: string): TurnEntry {
    let entry = this.#entries.get(turnId);
    if (entry === undefined) {
      entry = { pending: undefined, failure: undefined };
      this.#entries.set(turnId, entry);
    }
    return entry;
  }

  #prune(turnId: string, entry: TurnEntry): void {
    if (entry.pending === undefined && entry.failure === undefined) this.#entries.delete(turnId);
  }

  #forget(): void {
    if (this.#entries.size === 0) return;
    this.#entries.clear();
    this.#changed();
  }
}
