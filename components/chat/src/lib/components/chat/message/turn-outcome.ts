/**
 * Where the last turn of a conversation stands, read from what the host knows (COR-2725): whether
 * a run is going, whether its stream dropped, and the stop line the run left on a row. Chat turns
 * those facts into the one {@link ChatTurnState} the turn draws, and removes the stop line the
 * state replaces, so the host keeps no copy of the last-turn, stop-note or retry presentation.
 *
 * The host still owns what only it can know: the Bureau's run status and journal replay, and
 * whether something else (an approval, a question, a failure it shows itself) is holding the turn.
 */

import { isFollowUpMessage } from '../builders.ts';
import type { ConversationHistory, Message } from '../conversation-model.ts';
import type { MessageNoteInfo } from '../utilities/index.ts';
import {
  CINDER_NOTES_METADATA_KEY,
  getMessageText,
  pairToolCallsWithResults,
  resolveMessageNotes,
} from '../utilities/index.ts';
import type { ChatTurnState } from './turn-state.ts';

/** The retry a dropped stream is waiting on. */
export type TurnReconnectFacts = {
  /** The try under way, counting from 1. */
  readonly attempt: number;
  /** How many tries the run makes before it gives up. */
  readonly attempts: number;
  /** The whole wait before the next try, in milliseconds. */
  readonly wait: number;
  /** When the next try starts, in milliseconds since the Unix epoch. */
  readonly nextTryAt: number;
  /** The run's stream, rather than the first read of the history, was interrupted. */
  readonly runDropped: boolean;
};

/** What the host knows about the last turn. */
export type TurnOutcomeFacts = {
  /** A run is going and its text is arriving. */
  readonly running: boolean;
  /** The retry a dropped stream is waiting on, when there is one. */
  readonly reconnect?: TurnReconnectFacts | undefined;
  /** The time the countdown is read at, in milliseconds since the Unix epoch. */
  readonly now: number;
  /** Something other than the run holds the turn (an approval, a question, a failure the host shows): the turn is not finished. */
  readonly holding?: boolean | undefined;
};

/** The state a stop line is worded as, and the row and note Chat replaces with it. */
export type TurnStop = {
  readonly state: Extract<ChatTurnState, { kind: 'stopped' } | { kind: 'failed' }>;
  readonly rowId: string;
  readonly noteId: string;
};

/** The last turn's outcome. */
export type TurnOutcome = {
  /** The conversation with the stop line the outcome draws removed, which is the one Chat renders. */
  readonly conversation: ConversationHistory;
  /** The turn's stop, when its run stopped or failed. */
  readonly stop: TurnStop | undefined;
  /**
   * The message the outcome is drawn on: the last assistant message of the last turn, or the turn's
   * anchor after its steps when it ends on them (a dropped stream stays on the assistant message,
   * whose partial text it mutes).
   */
  readonly assistantId: string | undefined;
  /** The row of the conversation the outcome belongs to: that assistant message, or the turn's last row. */
  readonly rowId: string | undefined;
  /** The state of that message, and `undefined` while the turn is simply writing or finished. */
  readonly state: ChatTurnState | undefined;
};

/** Marks the message that stands for a turn with no assistant message. */
const TURN_OUTCOME_ANCHOR_KEY = 'cinder:turn-outcome-anchor';

/** Whether `message` is the anchor of a tool-only turn's outcome, which is no row of the conversation. */
export function isTurnOutcomeAnchor(message: Message): boolean {
  return typeof message.metadata[TURN_OUTCOME_ANCHOR_KEY] === 'string';
}

/** The last turn's rows, hidden ones left out. */
function lastTurnRows(rows: readonly Message[]): Message[] {
  const shown = rows.filter((row) => !row.hidden);
  return shown.slice(Math.max(0, shown.findLastIndex(opensTurn)));
}

/**
 * What the turn wrote: its rows without the follow-ups the person typed after them, which join the
 * turn but are no part of how it ended.
 */
function bodyOf(turn: readonly Message[]): Message[] {
  return turn.slice(0, turn.findLastIndex((row) => !isFollowUpMessage(row)) + 1);
}

/**
 * The message a turn's outcome is drawn on when the turn ends on its steps (RunStates R3 to R6
 * supersede the rail footnote and the stop note that stood there): the run only called tools, or
 * narrated and then called them, and wrote nothing after. It is no row of the conversation: it
 * stands after the turn's last step, with that row's time, so the turn reads as its text, its
 * steps, then how it ended, whatever the person typed after them. `undefined` for a turn that ends
 * on text, or has no tool call.
 */
function anchorOf(turn: readonly Message[]): Message | undefined {
  const body = bodyOf(turn);
  const last = body.at(-1);
  if (last === undefined) return undefined;
  if (last.role !== 'tool-call' && last.role !== 'tool-result') return undefined;
  if (!body.some((row) => row.role === 'tool-call')) return undefined;
  return {
    id: `${last.id}:outcome`,
    role: 'assistant',
    content: '',
    position: last.position,
    createdAt: last.createdAt,
    hidden: false,
    metadata: { [TURN_OUTCOME_ANCHOR_KEY]: last.id },
  };
}

/** The anchor of the last turn of `rows`, which is how the transcript finds the row to draw. */
export function toolEndedTurnAnchor(rows: readonly Message[]): Message | undefined {
  return anchorOf(lastTurnRows(rows));
}

/**
 * The last turn, segmented once: everything that says where its outcome is drawn (its assistant
 * message, its anchor) and which rows its stop line may sit on comes from here, so no outcome is
 * ever drawn on, or bound to the run of, a row of another turn.
 */
type LastTurn = {
  /** The ids of every row of the turn, hidden ones too. */
  readonly ids: readonly string[];
  /** What the turn wrote, without hidden rows or trailing follow-ups. */
  readonly body: readonly Message[];
  readonly assistantId: string | undefined;
  readonly anchor: Message | undefined;
};

/** The row of the conversation a tool-only turn's anchor stands after. */
function anchoredRowId(anchor: Message): string | undefined {
  const row = anchor.metadata[TURN_OUTCOME_ANCHOR_KEY];
  return typeof row === 'string' ? row : undefined;
}

function rowOf(conversation: ConversationHistory, id: string): Message | undefined {
  return Object.hasOwn(conversation.messages, id) ? conversation.messages[id] : undefined;
}

/** Whether `row` is a message the person opened a turn with: a follow-up joins the turn it went to. */
function opensTurn(row: Message | undefined): boolean {
  return row?.role === 'user' && !row.hidden && !isFollowUpMessage(row);
}

/** The index of the row that opens the last turn: 0 when no row opens one. */
function lastTurnStart(conversation: ConversationHistory): number {
  for (let at = conversation.ids.length - 1; at >= 0; at -= 1) {
    if (opensTurn(rowOf(conversation, conversation.ids[at] ?? ''))) return at;
  }
  return 0;
}

function lastTurn(conversation: ConversationHistory): LastTurn {
  const ids = conversation.ids.slice(lastTurnStart(conversation));
  const turn = ids.flatMap((id) => rowOf(conversation, id) ?? []).filter((row) => !row.hidden);
  return {
    ids,
    body: bodyOf(turn),
    assistantId: bodyOf(turn).findLast((row) => row.role === 'assistant')?.id,
    anchor: anchorOf(turn),
  };
}

/** Reads the last turn's stop line, excluding the notice that a restarted server ended the chat. */
function lastTurnStop(
  conversation: ConversationHistory,
  currentTurn: readonly string[],
): TurnStop | undefined {
  for (const id of currentTurn) {
    const row = rowOf(conversation, id);
    if (row === undefined) continue;
    const note = (resolveMessageNotes(row) ?? []).find(
      (entry): entry is Extract<MessageNoteInfo, { kind: 'stopped' }> =>
        entry.kind === 'stopped' && entry.notice !== true,
    );
    if (note !== undefined)
      return {
        state: note.failed === true ? { kind: 'failed', cause: note.reason } : { kind: 'stopped' },
        rowId: id,
        noteId: note.id,
      };
  }
  return undefined;
}

/** `conversation` without the stop line that `stop` says Chat draws as a turn state. */
function withoutStopLine(
  conversation: ConversationHistory,
  stop: TurnStop | undefined,
): ConversationHistory {
  if (stop === undefined) return conversation;
  const row = rowOf(conversation, stop.rowId);
  if (row === undefined) return conversation;
  const notes = (resolveMessageNotes(row) ?? []).filter((note) => note.id !== stop.noteId);
  return {
    ...conversation,
    messages: {
      ...conversation.messages,
      [stop.rowId]: { ...row, metadata: { ...row.metadata, [CINDER_NOTES_METADATA_KEY]: notes } },
    },
  };
}

function reconnectingState(
  reconnect: TurnReconnectFacts,
  now: number,
): Extract<ChatTurnState, { kind: 'reconnecting' }> {
  return {
    kind: 'reconnecting',
    attempt: reconnect.attempt,
    attempts: reconnect.attempts,
    nextTryIn: Math.max(0, Math.ceil((reconnect.nextTryAt - now) / 1000)),
    wait: Math.max(1, Math.ceil(reconnect.wait / 1000)),
  };
}

/**
 * Whether the last turn ended on tool activity, or on a blank reply, with every call answered and
 * nothing said about its stop: the run finished and wrote no answer. A call with no answer was
 * interrupted, and one that waits on an approval is not finished, so neither is an empty answer.
 */
function endsWithoutAnswer(rows: readonly Message[]): boolean {
  if (!rows.some((row) => row.role === 'assistant' || row.role === 'tool-call')) return false;
  if (rows.some((row) => (resolveMessageNotes(row) ?? []).some((note) => note.kind === 'stopped')))
    return false;
  const last = rows.at(-1);
  const endsOnBlankReply =
    last?.role === 'assistant' && last.toolCall === undefined && getMessageText(last).trim() === '';
  if (last?.role !== 'tool-call' && last?.role !== 'tool-result' && !endsOnBlankReply) return false;
  // Every call has its answer and none waits on a person. A last call that errored, or that the
  // person refused, still ended a run that wrote nothing (COR-2725 decision).
  return pairToolCallsWithResults(rows).every(
    (pair) => pair.result !== undefined && pair.result.outcome !== 'action_required',
  );
}

/**
 * The outcome of the last turn. A stream that dropped is `reconnecting`; otherwise, once nothing is
 * going, the last turn's stop line is the turn's `stopped` or `failed` state and leaves the
 * conversation, and a turn that finished with no answer is `empty`.
 */
export function resolveTurnOutcome(
  conversation: ConversationHistory,
  facts: TurnOutcomeFacts,
): TurnOutcome {
  const turn = lastTurn(conversation);
  // What carries the outcome, found in the last turn and nowhere else: its anchor after its steps,
  // else its own assistant message. A turn with neither (the person's message alone) has nowhere to
  // draw one, so its stop line stays where the run left it.
  const assistantId = turn.anchor?.id ?? turn.assistantId;
  const rowId = turn.anchor === undefined ? turn.assistantId : anchoredRowId(turn.anchor);
  const stop =
    facts.running || assistantId === undefined ? undefined : lastTurnStop(conversation, turn.ids);
  const shown = withoutStopLine(conversation, stop);
  if (facts.reconnect?.runDropped === true) {
    // A dropped stream mutes the partial text of the turn's own assistant message; only a turn with
    // none draws it on the anchor.
    const own = turn.assistantId !== undefined || turn.anchor === undefined;
    return {
      conversation: shown,
      stop,
      assistantId: own ? turn.assistantId : turn.anchor?.id,
      rowId: own ? turn.assistantId : rowId,
      state: reconnectingState(facts.reconnect, facts.now),
    };
  }
  if (stop !== undefined)
    return { conversation: shown, stop, assistantId, rowId, state: stop.state };
  const empty =
    assistantId !== undefined &&
    !facts.running &&
    facts.holding !== true &&
    endsWithoutAnswer(turn.body);
  return {
    conversation: shown,
    stop,
    assistantId,
    rowId,
    state: empty ? { kind: 'empty' } : undefined,
  };
}

/** The turn state of `message` in `outcome`: only the last assistant message of the last turn has one. */
export function turnStateOf(
  outcome: Pick<TurnOutcome, 'assistantId' | 'state'>,
  message: Message,
): ChatTurnState | undefined {
  return message.role === 'assistant' && message.id === outcome.assistantId
    ? outcome.state
    : undefined;
}
