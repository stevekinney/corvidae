/**
 * The conversation as a `MESSAGES_SNAPSHOT` carries it, and the rows a start
 * request adds to it.
 *
 * Both go through Conversationalist's AG-UI mapping, which this module only
 * guards: it takes `thinking` and `redacted_thinking` parts out of the
 * conversation before it is exported, because `toAGUIMessages` writes a
 * `thinking` part as a plaintext `reasoning` message (and throws on a
 * `redacted_thinking` one), which would put chain-of-thought on the wire.
 *
 * @module ag-ui-messages
 */

import type { Message as AgUiMessage } from '@ag-ui/core';
import {
  agUiConversationAdapter,
  type ConversationHistory,
  type Message,
  mergeAGUIMessages,
} from 'conversationalist';

/** A conversation with every reasoning part taken out of every row. */
export function withoutReasoning(history: ConversationHistory): ConversationHistory {
  const messages: Record<string, Message> = {};
  for (const [id, message] of Object.entries(history.messages)) {
    if (typeof message.content === 'string') {
      messages[id] = message;
      continue;
    }
    const kept = message.content.filter(
      (part) => part.type !== 'thinking' && part.type !== 'redacted_thinking',
    );
    messages[id] = kept.length === message.content.length ? message : { ...message, content: kept };
  }
  return { ...history, messages };
}

/** The `messages` of a `MESSAGES_SNAPSHOT` for `history`, with no reasoning in it. */
export function snapshotMessages(history: ConversationHistory): AgUiMessage[] {
  return agUiConversationAdapter.export(withoutReasoning(history));
}

/**
 * The rows `messages` adds to `history`: every message whose id `history` lacks.
 * A client sends its whole thread with each start, so the rows it already holds
 * are skipped, not refused.
 */
export function rowsAddedBy(history: ConversationHistory, messages: ReadonlyArray<AgUiMessage>) {
  const merged = mergeAGUIMessages(history, messages);
  const known = new Set(history.ids);
  return merged.ids.filter((id) => !known.has(id)).map((id) => merged.messages[id]!);
}
