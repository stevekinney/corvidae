/**
 * Where an assistant turn stands (COR-2283): writing, waiting on a dropped stream, stopped by the
 * person, failed partway, finished with no answer, or finished. The state lives on the turn it
 * describes, so a recovery control (Retry now, Continue, Discard, Retry, Try again) sits beside the
 * text it acts on rather than in the composer.
 *
 * The host owns the state, because only the host knows why a run stopped and what a retry keeps;
 * {@link advanceTurnState} is the transition table it can drive the state with, and
 * {@link presentTurnState} is what each state draws.
 */

/**
 * Where an assistant turn stands.
 *
 * - `streaming`: text is arriving. The reply ends in a caret, and no line of time or actions sits
 *   under it yet.
 * - `reconnecting`: the stream dropped and the run is trying again. The partial text reads muted
 *   with no caret, and a warning on the turn says which try this is and when the next one starts,
 *   with Retry now and a bar that drains until then.
 * - `stopped`: the person stopped the run. A neutral pill says the answer is partial, with Discard
 *   and Continue.
 * - `failed`: the run failed after writing part of the answer. A danger alert says the answer is
 *   incomplete, why, and what Retry keeps, with Retry.
 * - `empty`: the run finished without writing an answer. A dashed row says so, with the turn's time
 *   and Try again, in place of the line of time and actions.
 * - `complete`: the answer is finished.
 */
export type ChatTurnState =
  | { kind: 'streaming' }
  | {
      kind: 'reconnecting';
      /** The try under way, counting from 1. */
      attempt: number;
      /** How many tries the run makes before it gives up. */
      attempts: number;
      /** Whole seconds until the next try. */
      nextTryIn: number;
      /**
       * The whole wait before the next try, in seconds, which the bar under the warning drains
       * from. Defaults to `nextTryIn`, so a host that sets only `nextTryIn` draws a full bar.
       */
      wait?: number | undefined;
    }
  | { kind: 'stopped' }
  | {
      kind: 'failed';
      /** Why the answer stopped partway, in plain words, such as "The model provider dropped the connection." */
      cause: string;
      /** What Retry keeps, such as "Retry keeps the text above and the 2 steps that finished." Defaults to the `retryKeeps` label. */
      keeps?: string | undefined;
    }
  | { kind: 'empty' }
  | { kind: 'complete' };

/** The name of one {@link ChatTurnState}. */
export type ChatTurnStateKind = ChatTurnState['kind'];

/**
 * Something that happens to a turn, which {@link advanceTurnState} turns into its next state.
 *
 * - `connection-lost`: the stream dropped, or a try failed and the next is scheduled.
 * - `reconnected`: the stream is back, whether by itself or after Retry now.
 * - `stop`: the person stopped the run.
 * - `continue`: the person chose Continue on a stopped turn.
 * - `retry`: the person chose Retry on a failed turn, or Try again on an empty one.
 * - `fail`: the run failed.
 * - `finish`: the run ended; `answered` says whether it wrote any answer.
 *
 * Discard is not an event: the host removes the discarded turn from the conversation.
 */
export type ChatTurnEvent =
  | {
      type: 'connection-lost';
      /** The try under way, counting from 1. */
      attempt: number;
      /** How many tries the run makes before it gives up. */
      attempts: number;
      /** Whole seconds until the next try. */
      nextTryIn: number;
      /** The whole wait before the next try, in seconds. */
      wait?: number | undefined;
    }
  | { type: 'reconnected' }
  | { type: 'stop' }
  | { type: 'continue' }
  | { type: 'retry' }
  | {
      type: 'fail';
      /** Why the answer stopped partway, in plain words. */
      cause: string;
      /** What Retry keeps. */
      keeps?: string | undefined;
    }
  | {
      type: 'finish';
      /** Whether the run wrote any answer. */
      answered: boolean;
    };

/** Whether a turn is still under way: writing, or waiting to write again. */
function isLive(state: ChatTurnState): boolean {
  return state.kind === 'streaming' || state.kind === 'reconnecting';
}

/**
 * The state a turn moves to when `event` happens to it. An event that does not apply to the state
 * (Continue on a turn that is not stopped, a lost connection on a finished turn) leaves the state
 * as it was, so a late or repeated event never moves a turn backwards.
 */
export function advanceTurnState(state: ChatTurnState, event: ChatTurnEvent): ChatTurnState {
  switch (event.type) {
    case 'connection-lost': {
      if (!isLive(state)) return state;
      const next: ChatTurnState = {
        kind: 'reconnecting',
        attempt: event.attempt,
        attempts: event.attempts,
        nextTryIn: event.nextTryIn,
      };
      return event.wait === undefined ? next : { ...next, wait: event.wait };
    }
    case 'reconnected':
      return state.kind === 'reconnecting' ? { kind: 'streaming' } : state;
    case 'stop':
      return isLive(state) ? { kind: 'stopped' } : state;
    case 'continue':
      return state.kind === 'stopped' ? { kind: 'streaming' } : state;
    case 'retry':
      return state.kind === 'failed' || state.kind === 'empty' ? { kind: 'streaming' } : state;
    case 'fail': {
      if (!isLive(state)) return state;
      return event.keeps === undefined
        ? { kind: 'failed', cause: event.cause }
        : { kind: 'failed', cause: event.cause, keeps: event.keeps };
    }
    case 'finish':
      if (!isLive(state)) return state;
      return event.answered ? { kind: 'complete' } : { kind: 'empty' };
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

/** What a turn draws in each state. */
export type ChatTurnPresentation = {
  /** Whether the line of time and actions (Copy, Quote) sits under the turn. */
  line: boolean;
  /** Whether a reply that is streaming ends in a caret. */
  caret: boolean;
  /** Whether the text reads muted, as text that may not be the final answer. */
  muted: boolean;
  /** Whether the turn offers Regenerate, when the host supplies it. */
  regenerate: boolean;
};

/** What a turn in `state` draws: its line, its caret, muted text and Regenerate. */
export function presentTurnState(state: ChatTurnState): ChatTurnPresentation {
  switch (state.kind) {
    case 'streaming':
      return { line: false, caret: true, muted: false, regenerate: false };
    case 'reconnecting':
      return { line: false, caret: false, muted: true, regenerate: false };
    case 'stopped':
      return { line: true, caret: false, muted: false, regenerate: false };
    case 'failed':
      return { line: true, caret: false, muted: false, regenerate: false };
    // The empty row carries the turn's time itself, so no line stands under it with a lone time.
    case 'empty':
      return { line: false, caret: false, muted: false, regenerate: false };
    case 'complete':
      return { line: true, caret: false, muted: false, regenerate: true };
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

function isCount(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum;
}

function isOptionalText(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/**
 * Narrows a host's value to a well-formed {@link ChatTurnState}. A reconnecting state needs whole
 * counts with the try no later than the last one, and a failed one needs a cause; anything else
 * is not a turn state, and the turn falls back to what Chat can see for itself.
 */
export function isChatTurnState(value: unknown): value is ChatTurnState {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false;
  const candidate = value as Record<string, unknown>;
  switch (candidate['kind']) {
    case 'streaming':
    case 'stopped':
    case 'empty':
    case 'complete':
      return true;
    case 'reconnecting':
      return (
        isCount(candidate['attempt'], 1) &&
        isCount(candidate['attempts'], 1) &&
        (candidate['attempt'] as number) <= (candidate['attempts'] as number) &&
        isCount(candidate['nextTryIn'], 0) &&
        (candidate['wait'] === undefined || isCount(candidate['wait'], 0))
      );
    case 'failed':
      return typeof candidate['cause'] === 'string' && isOptionalText(candidate['keeps']);
    default:
      return false;
  }
}

/**
 * The state a turn is drawn in: the host's `declared` state when it gave a well-formed one, and
 * otherwise what Chat can see for itself, `streaming` while text arrives or the message is still
 * marked as streaming, and `complete` after that.
 */
export function effectiveTurnState(
  declared: ChatTurnState | undefined,
  streaming: boolean,
  unfinished: boolean,
): ChatTurnState {
  if (declared !== undefined && isChatTurnState(declared)) return declared;
  return streaming || unfinished ? { kind: 'streaming' } : { kind: 'complete' };
}

/**
 * How full the bar under a reconnecting turn's warning is, from 1 when the wait starts to 0 when
 * the next try begins.
 */
export function reconnectWaitFraction(
  state: Extract<ChatTurnState, { kind: 'reconnecting' }>,
): number {
  const wait = state.wait ?? state.nextTryIn;
  if (wait <= 0) return 0;
  return Math.min(1, Math.max(0, state.nextTryIn / wait));
}
