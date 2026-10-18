import type { ConversationHistory, Message } from './conversation-model.ts';

/**
 * Conversation builders re-exported from Chat's direct Conversationalist
 * dependency. Keeping these at the Chat boundary gives consumers one stable
 * import surface while Chat and Conversationalist share the same transcript
 * types and runtime implementation.
 */

export {
  appendAssistantMessage,
  appendMessages,
  appendToolCall,
  appendToolCalls,
  appendToolResult,
  appendToolResultAsync,
  appendToolResults,
  appendToolResultsAsync,
  appendUserMessage,
  buildMessage,
  createConversationHistory,
  isConversationHistory,
  isJSONValue,
  isMediaContent,
  isStreamingMessage,
  isTokenUsage,
  isToolResult,
  mediaDisplayUrl,
  prependMessages,
  renderMediaPlaceholder,
} from 'conversationalist';

// Branch-rewind builders — the operation Chat's own `editMessage` adapter
// command asks consumers to perform ("rewind to just before the edited
// message, discard the superseded branch, re-send"). `rewindBeforeMessage` is
// the form edit flows usually want, since the adapter hands them a message id.
export { rewindBeforeMessage, rewindBeforePosition } from 'conversationalist';
export type { RewindOptions } from 'conversationalist';

// Streaming transcript helpers — canonical placeholder lifecycle for content
// that is still arriving from a transport.
export {
  appendStreamingMessage,
  cancelStreamingMessage,
  finalizeStreamingMessage,
  updateStreamingMessage,
} from 'conversationalist';

// Transcript mutation helpers—canonical in-place edits (update, remove,
// hide/show, replace a tool result) that keep message identity, role, order,
// and creation time intact. Every helper is a no-op (returns the original
// history unchanged) when given an unknown message or tool-call identifier.
export {
  removeMessage,
  replaceToolResult,
  setMessageHidden,
  updateMessage,
} from 'conversationalist';
export type { MessageUpdate } from 'conversationalist';

const DELIVERY_STATUS_METADATA_KEY = '_deliveryStatus';

/**
 * Transient metadata key the session controller stamps on a message the user
 * sent while a run was working. Such a row never owns the run: ownership stays
 * with the turn that opened it.
 */
export const FOLLOW_UP_METADATA_KEY = '_followUp';

/** Whether a message is a follow-up row the controller appended during a run. */
export function isFollowUpMessage(message: Message | undefined): boolean {
  return message?.metadata?.[FOLLOW_UP_METADATA_KEY] === true;
}

function markMessageDeliveryStatus(
  history: ConversationHistory,
  messageId: string,
  status: 'failed' | 'sending',
): ConversationHistory {
  const message = history.messages[messageId];
  if (!message || message.metadata?.[DELIVERY_STATUS_METADATA_KEY] === status) return history;

  return {
    ...history,
    messages: {
      ...history.messages,
      [messageId]: {
        ...message,
        metadata: { ...message.metadata, [DELIVERY_STATUS_METADATA_KEY]: status },
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

/** Mark a message as failed so Chat renders its retry affordance. */
export function markMessageDeliveryFailed(
  history: ConversationHistory,
  messageId: string,
): ConversationHistory {
  return markMessageDeliveryStatus(history, messageId, 'failed');
}

/**
 * Mark a message as sent but not yet acknowledged, so Chat renders it with a
 * pending state. Clear it with {@link clearMessageDeliveryStatus} once the
 * transport acknowledges the message, or replace it with
 * {@link markMessageDeliveryFailed} when the transport rejects it.
 */
export function markMessageDeliveryPending(
  history: ConversationHistory,
  messageId: string,
): ConversationHistory {
  return markMessageDeliveryStatus(history, messageId, 'sending');
}

/** Clear a message's pending or failed delivery marker after the transport acknowledges it. */
export function clearMessageDeliveryStatus(
  history: ConversationHistory,
  messageId: string,
): ConversationHistory {
  const message = history.messages[messageId];
  if (!message || !message.metadata || !(DELIVERY_STATUS_METADATA_KEY in message.metadata)) {
    return history;
  }

  const metadata = { ...message.metadata };
  delete metadata[DELIVERY_STATUS_METADATA_KEY];
  return {
    ...history,
    messages: { ...history.messages, [messageId]: { ...message, metadata } },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * @deprecated Use {@link createConversationHistory}. This alias is retained
 * as the explicit migration path for consumers upgrading to Conversationalist 0.5.
 */
export { createConversationHistory as createConversation } from 'conversationalist';

/**
 * Stamps a message as a follow-up. Used by the session controller on the rows
 * it appends during a run; Chat's `_followUp` marker is transient metadata and
 * is stripped on export.
 */
export function markMessageFollowUp(
  history: ConversationHistory,
  messageId: string,
): ConversationHistory {
  const message = history.messages[messageId];
  if (!message || isFollowUpMessage(message)) return history;
  return {
    ...history,
    messages: {
      ...history.messages,
      [messageId]: {
        ...message,
        metadata: { ...message.metadata, [FOLLOW_UP_METADATA_KEY]: true },
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Turns a follow-up row into an ordinary turn: drops the follow-up marker and
 * any pending or failed delivery status in one write.
 */
export function promoteFollowUpMessage(
  history: ConversationHistory,
  messageId: string,
): ConversationHistory {
  const message = history.messages[messageId];
  if (!message) return history;
  const metadata = { ...message.metadata };
  delete metadata[FOLLOW_UP_METADATA_KEY];
  delete metadata[DELIVERY_STATUS_METADATA_KEY];
  return {
    ...history,
    messages: { ...history.messages, [messageId]: { ...message, metadata } },
    updatedAt: new Date().toISOString(),
  };
}
