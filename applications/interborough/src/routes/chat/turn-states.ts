/**
 * Where the chat's turns stand, as Chat's `messageTurnState` draws them (COR-2283 R3 to R6): the
 * turn whose stream dropped is `reconnecting`, with the try the session scheduled, how many it
 * makes, and the seconds until the next one, so Chat reads "Connection lost. Reconnecting,
 * attempt 2 of 7. Next try in 4s." by the composer, with Retry.
 *
 * The last turn the person stopped is `stopped`, and the last turn whose run failed is `failed`,
 * with the sentence its status line would have said (`stop-line.ts`) as the cause (COR-2437): Chat
 * draws each on the turn, with Discard beside a stopped one and Retry in a failed one's alert, so
 * the status line that said it is taken off the row and is not drawn a second time. A turn the
 * server ended when it restarted keeps its notice, and an earlier turn keeps its line.
 */
import {
  type ChatTurnState,
  CINDER_NOTES_METADATA_KEY,
  type ConversationHistory,
  type Message,
  type MessageNoteInfo,
  resolveMessageNotes,
} from '@lostgradient/chat';

import type { ChatReconnect } from './chat-session.svelte.ts';
import { lastTurnStart } from './tool-activity.ts';

/** The `reconnecting` state of the turn whose stream dropped, at `now`. */
export function reconnectingTurnState(
  schedule: ChatReconnect,
  now: number,
): Extract<ChatTurnState, { kind: 'reconnecting' }> {
  return {
    kind: 'reconnecting',
    attempt: schedule.attempt,
    attempts: schedule.attempts,
    nextTryIn: Math.max(0, Math.ceil((schedule.nextTryAt - now) / 1000)),
    wait: Math.max(1, Math.ceil(schedule.wait / 1000)),
  };
}

/** What the page knows that decides a turn's state. */
export interface TurnFacts {
  /** The try the session scheduled while it reconnects, or `undefined` while the stream is up. */
  readonly reconnect: ChatReconnect | undefined;
  /** The id of the transcript's last assistant message, the one a dropped stream was writing. */
  readonly lastAssistantId: string | undefined;
  /**
   * Now, in milliseconds since the epoch, for the countdown. Read only for the reconnecting turn,
   * so a page whose clock ticks re-renders that turn alone, not every turn each second.
   */
  readonly now: () => number;
  /** How the last turn ended when the person stopped it or its run failed (`lastTurnStop`). */
  readonly stop?: TurnStop['state'] | undefined;
}

/**
 * The state of `message`: `reconnecting` for the last assistant turn while the session retries the
 * dropped stream of a run it was reading, `stopped` or `failed` for it once its run ended so, and
 * `undefined` (as Chat sees it) for every other turn and while a first read of the thread is
 * retried.
 */
export function turnStateOf(message: Message, facts: TurnFacts): ChatTurnState | undefined {
  if (message.role !== 'assistant' || message.id !== facts.lastAssistantId) return undefined;
  if (facts.reconnect?.runDropped === true) {
    return reconnectingTurnState(facts.reconnect, facts.now());
  }
  return facts.stop;
}

/** How the last turn ended, and the status line on its row that said so. */
export type TurnStop = {
  readonly state: Extract<ChatTurnState, { kind: 'stopped' } | { kind: 'failed' }>;
  /** The row the status line is on. */
  readonly rowId: string;
  /** The status line's note. */
  readonly noteId: string;
};

/**
 * How the last turn of `conversation` ended, read from its status line: `stopped` for a run the
 * person stopped, `failed` (its line's sentence as the cause) for one that failed, or `undefined`
 * when it did neither, when the turn has no reply for Chat to draw the state on, or when the line
 * is the notice of a chat the server ended.
 */
export function lastTurnStop(conversation: ConversationHistory): TurnStop | undefined {
  if (lastAssistantId(conversation) === undefined) return undefined;
  for (const id of conversation.ids.slice(lastTurnStart(conversation))) {
    const row = Object.hasOwn(conversation.messages, id) ? conversation.messages[id] : undefined;
    if (row === undefined) continue;
    const note = (resolveMessageNotes(row) ?? []).find(
      (entry): entry is Extract<MessageNoteInfo, { kind: 'stopped' }> =>
        entry.kind === 'stopped' && entry.notice !== true,
    );
    if (note === undefined) continue;
    return {
      state: note.failed === true ? { kind: 'failed', cause: note.reason } : { kind: 'stopped' },
      rowId: id,
      noteId: note.id,
    };
  }
  return undefined;
}

/** `conversation` without the status line `stop` read, which Chat draws on the turn instead. */
export function withoutStopLine(
  conversation: ConversationHistory,
  stop: TurnStop | undefined,
): ConversationHistory {
  if (stop === undefined) return conversation;
  const row = Object.hasOwn(conversation.messages, stop.rowId)
    ? conversation.messages[stop.rowId]
    : undefined;
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

/**
 * The id of the last assistant message of the last turn of `conversation`, after the person's last
 * message, or `undefined` when that turn has none yet: a stream that drops before the reply has a
 * row never marks the previous turn's finished answer.
 */
export function lastAssistantId(conversation: ConversationHistory): string | undefined {
  for (let index = conversation.ids.length - 1; index >= 0; index -= 1) {
    const id = conversation.ids[index];
    if (id === undefined || !Object.hasOwn(conversation.messages, id)) continue;
    const row = conversation.messages[id];
    // A hidden row (the turn a page reads a run it joined under) is not the person's message.
    if (row?.role === 'user' && !row.hidden) return undefined;
    if (row?.role === 'assistant') return id;
  }
  return undefined;
}
