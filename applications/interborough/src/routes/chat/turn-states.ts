/**
 * Where the chat's turns stand, as Chat's `messageTurnState` draws them (COR-2283 R3 to R6): the
 * turn whose stream dropped is `reconnecting`, with the try the session scheduled, how many it
 * makes, and the seconds until the next one, so Chat reads "Connection lost. Reconnecting,
 * attempt 2 of 7. Next try in 4s." by the composer, with Retry.
 *
 * A turn the person stopped, or that failed, keeps the line the page writes under it
 * (`stop-line.ts`), with its own Retry: those are not drawn a second time here.
 */
import type { ChatTurnState, ConversationHistory, Message } from '@lostgradient/chat';

import type { ChatReconnect } from './chat-session.svelte.ts';

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
  /** Now, in milliseconds since the epoch, for the countdown. */
  readonly now: number;
}

/**
 * The state of `message`: `reconnecting` for the last assistant turn while the session retries the
 * dropped stream of a run it was reading, and `undefined` (as Chat sees it) for every other turn
 * and while a first read of the thread is retried.
 */
export function turnStateOf(message: Message, facts: TurnFacts): ChatTurnState | undefined {
  if (message.role !== 'assistant' || message.id !== facts.lastAssistantId) return undefined;
  if (facts.reconnect === undefined || !facts.reconnect.runDropped) return undefined;
  return reconnectingTurnState(facts.reconnect, facts.now);
}

/** The id of the last assistant message of `conversation`, or `undefined` when there is none. */
export function lastAssistantId(conversation: ConversationHistory): string | undefined {
  for (let index = conversation.ids.length - 1; index >= 0; index -= 1) {
    const id = conversation.ids[index];
    if (id === undefined || !Object.hasOwn(conversation.messages, id)) continue;
    if (conversation.messages[id]?.role === 'assistant') return id;
  }
  return undefined;
}
