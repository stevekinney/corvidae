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

/**
 * A conversation whose rows hold only text parts, for the roles `roles` names (every role when
 * omitted). An AG-UI assistant message carries text only, so `toAGUIMessages` throws on a
 * server-tool, `container_upload` or generated-image part. A snapshot is a view of the thread, so
 * those parts are left out of it rather than failing it; the row itself stays, with its text.
 */
function textOnly(
  history: ConversationHistory,
  roles?: ReadonlySet<Message['role']>,
): ConversationHistory {
  const messages: Record<string, Message> = {};
  for (const [id, message] of Object.entries(history.messages)) {
    if (typeof message.content === 'string' || (roles && !roles.has(message.role))) {
      messages[id] = message;
      continue;
    }
    const kept = message.content.filter((part) => part.type === 'text');
    messages[id] = kept.length === message.content.length ? message : { ...message, content: kept };
  }
  return { ...history, messages };
}

/**
 * The `messages` of a `MESSAGES_SNAPSHOT` for `history`, with no reasoning in it. It never throws
 * for a part the AG-UI mapping cannot carry (COR-713): an assistant row keeps its text, and should
 * any other row still be refused, every row is reduced to its text.
 */
export function snapshotMessages(history: ConversationHistory): AgUiMessage[] {
  const visible = withoutReasoning(history);
  try {
    return agUiConversationAdapter.export(textOnly(visible, new Set(['assistant'])));
  } catch {
    return agUiConversationAdapter.export(textOnly(visible));
  }
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
