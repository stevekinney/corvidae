import {
  appendStreamingMessage,
  finalizeStreamingMessage,
  updateStreamingMessage,
} from '@corvidae/conversationalist';
import type { ChatPushHandlers } from '../components/chat/adapter/chat-adapter.ts';
import { appendToolCall, appendToolResult } from '../components/chat/builders.ts';
import type { ConversationHistory, ToolResult } from '../components/chat/conversation-model.ts';
import { remapMessageId } from './session-controller-rows.ts';
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

export async function consumeSessionEvents(dependencies: SessionEventDependencies): Promise<void> {
  const { events, controller, state, isCurrent, isProtocolFailure, markProtocolFailure } =
    dependencies;
  for await (const event of events) {
    if (controller.signal.aborted && !isProtocolFailure()) break;
    // Re-read per event, not once per stream. Every `await` on the iterator
    // is a gap in which a submission, a navigation or a disposal can land,
    // and the frame that comes back after one is exactly the stale callback
    // this guard exists to stop.
    if (!isCurrent()) break;
    switch (event.type) {
      case 'text':
        // LEGACY and RICH are two projections of the same tokens, and a host
        // that emits both would otherwise have its text counted twice.
        // Whichever vocabulary speaks first owns the row for this turn; the
        // other is dropped rather than merged, because merging two views of
        // one stream produces text that never existed.
        if (state.richTextSeen) break;
        state.legacyTextSeen = true;
        appendAssistantText(dependencies, state.currentAssistantText + event.text, event.text);
        break;
      case 'stream:text-delta':
        if (state.legacyTextSeen) break;
        state.richTextSeen = true;
        appendAssistantText(dependencies, event.accumulated, event.content);
        break;
      case 'tool_call':
        applyToolCall(dependencies, event.id, event.name, event.arguments);
        break;
      case 'tool_result':
        applyToolResult(dependencies, event.callId, event);
        break;
      case 'tool.settled':
        applyToolResult(dependencies, event.toolCallId, event.result);
        break;
      case 'assistant.step.started':
        applyStepStarted(dependencies, event.step, event.messageId);
        break;
      case 'assistant.step.completed':
        // Only the step that is actually open: a late or duplicated
        // completion for a step already closed must not finalize the row the
        // NEXT step is streaming into.
        if (event.step === state.currentStep) finalizeCurrentRow(dependencies);
        break;
      case 'run.error':
      case 'run.tripwire':
        markProtocolFailure();
        controller.abort();
        throw new ChatRunFailureError(event.error);
      default:
        // The remaining `stream:*`, `tool.*` and `run.*` members the codec
        // vocabulary carries have no reducer here yet. They fall through as a
        // no-op rather than crash this loop.
        break;
    }
  }
}

function appendAssistantText(
  { state, options, emit, update }: SessionEventDependencies,
  rowText: string,
  pushed: string,
): void {
  state.text += pushed;
  state.currentAssistantText = rowText;
  emit((handlers) => handlers.onTokenPush(pushed));
  update(
    updateStreamingMessage(
      options.getConversation(),
      state.currentAssistantMessageId,
      state.currentAssistantText,
    ),
  );
}

function applyToolCall(
  { state, options, update, toolOwners, userMessageId }: SessionEventDependencies,
  id: string,
  name: string,
  args: Extract<ChatStreamEvent, { type: 'tool_call' }>['arguments'],
): void {
  if (state.toolCalls.has(id)) return;
  update(appendToolCall(options.getConversation(), { id, name, arguments: args }));
  toolOwners.set(id, userMessageId);
  state.toolCalls.add(id);
  state.committed = options.getConversation();
}

function applyToolResult(
  { state, options, update, pendingApprovals, reportError }: SessionEventDependencies,
  callId: string,
  result: ToolResult,
): void {
  // Keyed by CALL identifier, not by frame: `tool_result` and `tool.settled`
  // are the legacy and rich projections of one settlement, and a host that
  // emits both would otherwise append the same outcome twice — and call the
  // host's own `onToolResult` observer twice for one tool run.
  if (state.toolResults.has(callId)) return;
  state.toolResultSeen = true;
  state.toolResults.add(callId);
  const requiresApproval = result.outcome === 'action_required' && result.action !== undefined;
  state.approvalRequired ||= requiresApproval;
  if (requiresApproval) pendingApprovals.add(callId);
  else pendingApprovals.delete(callId);
  update(appendToolResult(options.getConversation(), result));
  state.committed = options.getConversation();
  try {
    options.hooks?.onToolResult?.(result);
  } catch (observerError) {
    reportError(observerError);
  }
}

function finalizeCurrentRow({ state, options, update }: SessionEventDependencies): void {
  update(finalizeStreamingMessage(options.getConversation(), state.currentAssistantMessageId));
}

/**
 * Opens the row a step's text belongs to, and adopts the host's identifier
 * for it.
 *
 * A NEW step gets a new row, placed after whatever the previous step left
 * behind — which is what puts a follow-up reply below the tool activity it
 * is replying about, rather than back inside the row that already precedes
 * it. The FIRST step reuses the placeholder the run opened, so a
 * single-step response still renders as one assistant turn.
 */
function applyStepStarted(
  dependencies: SessionEventDependencies,
  step: number,
  messageId: string,
): void {
  const { state, options, update } = dependencies;
  if (state.currentStep !== -1 && state.currentStep !== step) {
    finalizeCurrentRow(dependencies);
    const next = appendStreamingMessage(options.getConversation(), 'assistant');
    update(next.conversation);
    state.currentAssistantMessageId = next.messageId;
    state.currentAssistantText = '';
    state.provisionalIds.add(next.messageId);
  }
  const remapped = remapMessageId(
    options.getConversation(),
    state.currentAssistantMessageId,
    messageId,
  );
  if (remapped !== options.getConversation()) {
    state.provisionalIds.delete(state.currentAssistantMessageId);
    state.provisionalIds.add(messageId);
    state.currentAssistantMessageId = messageId;
    update(remapped);
  }
  state.currentStep = step;
}
