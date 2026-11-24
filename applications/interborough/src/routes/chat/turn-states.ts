import {
  CINDER_NOTES_METADATA_KEY,
  type ChatTurnState,
  type ConversationHistory,
  type Message,
  type MessageNoteInfo,
  resolveMessageNotes,
} from '@lostgradient/chat';

import type { ChatReconnect } from './chat-session.svelte.ts';
import { lastTurnStart } from './tool-activity.ts';

export function turnStateOf(
  message: Message,
  facts: {
    readonly reconnect: ChatReconnect | undefined;
    readonly lastAssistantId: string | undefined;
    readonly now: number;
    readonly stop?: Extract<ChatTurnState, { kind: 'stopped' } | { kind: 'failed' }> | undefined;
  },
): ChatTurnState | undefined {
  if (message.role !== 'assistant' || message.id !== facts.lastAssistantId) return undefined;
  const { reconnect } = facts;
  if (reconnect !== undefined && reconnect.runDropped)
    return {
      kind: 'reconnecting',
      attempt: reconnect.attempt,
      attempts: reconnect.attempts,
      nextTryIn: Math.max(0, Math.ceil((reconnect.nextTryAt - facts.now) / 1000)),
      wait: Math.max(1, Math.ceil(reconnect.wait / 1000)),
    };
  return facts.stop;
}

/** The last stopped or failed turn's state and the note Chat replaces on its row. */
export type TurnStop = {
  readonly state: Extract<ChatTurnState, { kind: 'stopped' } | { kind: 'failed' }>;
  readonly rowId: string;
  readonly noteId: string;
};

/** Reads the last turn's stop line, excluding server-restart notices. */
export function lastTurnStop(conversation: ConversationHistory): TurnStop | undefined {
  const currentTurn = conversation.ids.slice(lastTurnStart(conversation));
  // A stop note may belong to the new person's message when a run ends before producing a reply.
  // Keep it there. Replacing the previous turn's assistant would falsely mark a completed reply
  // failed and would bind recovery controls to its run.
  if (
    !currentTurn.some(
      (id) =>
        Object.hasOwn(conversation.messages, id) && conversation.messages[id]?.role === 'assistant',
    )
  )
    return undefined;
  for (const id of currentTurn) {
    const row = Object.hasOwn(conversation.messages, id) ? conversation.messages[id] : undefined;
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

/** Removes the stop line whose content Chat renders as a turn state. */
export function withoutStopLine(
  conversation: ConversationHistory,
  stop: TurnStop | undefined,
): ConversationHistory {
  if (stop === undefined) return conversation;
  const row = conversation.messages[stop.rowId];
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

export function lastAssistantId(conversation: ConversationHistory): string | undefined {
  for (let index = conversation.ids.length - 1; index >= 0; index -= 1) {
    const id = conversation.ids[index];
    if (id === undefined || !Object.hasOwn(conversation.messages, id)) continue;
    if (conversation.messages[id]?.role === 'assistant') return id;
  }
  return undefined;
}
