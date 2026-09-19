import { updateStreamingMessage } from '@corvidae/conversationalist';
import type { ChatPushHandlers } from '../components/chat/adapter/chat-adapter.ts';
import { appendToolCall, appendToolResult } from '../components/chat/builders.ts';
import type { ConversationHistory } from '../components/chat/conversation-model.ts';
import type { TurnState } from './session-controller-run.ts';
import {
  ChatRunFailureError,
  type ChatSessionControllerOptions,
} from './session-controller-support.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';
type SessionEventDependencies = {
  events: AsyncIterable<ChatStreamEvent>;
  controller: AbortController;
  userMessageId: string;
  messageId: string;
  state: TurnState;
  options: ChatSessionControllerOptions;
  emit: (callback: (handlers: ChatPushHandlers) => void) => void;
  update: (conversation: ConversationHistory) => void;
  toolOwners: Map<string, string>;
  pendingApprovals: Set<string>;
  reportError: (error: unknown) => void;
  isCurrent: () => boolean;
  isProtocolFailure: () => boolean;
  markProtocolFailure: () => void;
};

export async function consumeSessionEvents({
  events,
  controller,
  userMessageId,
  messageId,
  state,
  options,
  emit,
  update,
  toolOwners,
  pendingApprovals,
  reportError,
  isCurrent,
  isProtocolFailure,
  markProtocolFailure,
}: SessionEventDependencies): Promise<void> {
  for await (const event of events) {
    if (controller.signal.aborted && !isProtocolFailure()) break;
    // Re-read per event, not once per stream. Every `await` on the iterator
    // is a gap in which a submission, a navigation or a disposal can land,
    // and the frame that comes back after one is exactly the stale callback
    // this guard exists to stop.
    if (!isCurrent()) break;
    switch (event.type) {
      case 'text':
        state.text += event.text;
        emit((handlers) => handlers.onTokenPush(event.text));
        update(updateStreamingMessage(options.getConversation(), messageId, state.text));
        break;
      case 'tool_call':
        update(
          appendToolCall(options.getConversation(), {
            id: event.id,
            name: event.name,
            arguments: event.arguments,
          }),
        );
        toolOwners.set(event.id, userMessageId);
        state.toolCalls.add(event.id);
        state.committed = options.getConversation();
        break;
      case 'tool_result':
        applyToolResult(event, state, options, update, pendingApprovals, reportError);
        break;
      case 'run.error':
      case 'run.tripwire':
        markProtocolFailure();
        controller.abort();
        throw new ChatRunFailureError(event.error);
    }
  }
}

function applyToolResult(
  event: Extract<ChatStreamEvent, { type: 'tool_result' }>,
  state: TurnState,
  options: ChatSessionControllerOptions,
  update: (conversation: ConversationHistory) => void,
  pendingApprovals: Set<string>,
  reportError: (error: unknown) => void,
): void {
  state.toolResultSeen = true;
  state.toolResults.add(event.callId);
  const requiresApproval = event.outcome === 'action_required' && event.action !== undefined;
  state.approvalRequired ||= requiresApproval;
  if (requiresApproval) pendingApprovals.add(event.callId);
  else pendingApprovals.delete(event.callId);
  update(appendToolResult(options.getConversation(), event));
  state.committed = options.getConversation();
  try {
    options.hooks?.onToolResult?.(event);
  } catch (observerError) {
    reportError(observerError);
  }
}
