import {
  appendStreamingMessage,
  cancelStreamingMessage,
  finalizeStreamingMessage,
  updateStreamingMessage,
} from 'conversationalist';
import type { ChatPushHandlers } from '../components/chat/adapter/chat-adapter.ts';
import { appendToolCall, appendToolResult } from '../components/chat/builders.ts';
import type { ConversationHistory, ToolResult } from '../components/chat/conversation-model.ts';
import { remapMessageId } from './session-controller-rows.ts';
import type { TurnState } from './session-controller-run.ts';
import {
  ChatRunFailureError,
  type ChatElicitationActivity,
  type ChatSessionControllerOptions,
  type ChatToolActivity,
} from './session-controller-support.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

/**
 * The `stream:*` frames deliberately left unreduced. Every other
 * `ChatStreamEvent` type has its own `case` in the switch below; the grouped
 * `case` that handles these is held to this tuple with `satisfies`, so a
 * label missing here fails `typecheck`.
 */
export const IGNORED_STREAM_EVENT_TYPES = [
  'stream:block-start',
  'stream:block-delta',
  'stream:block-complete',
  'stream:tool-call-start',
  'stream:tool-call-delta',
  'stream:tool-call-complete',
  'stream:usage',
  'stream:complete',
  'stream:error',
] as const satisfies readonly Exclude<
  Extract<ChatStreamEvent['type'], `stream:${string}`>,
  'stream:text-delta'
>[];

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
  elicitations: Map<string, ChatElicitationActivity>;
  reportError: (error: unknown) => void;
  isCurrent: () => boolean;
  isProtocolFailure: () => boolean;
  markProtocolFailure: () => void;
};

export async function consumeSessionEvents(dependencies: SessionEventDependencies): Promise<void> {
  const { events, controller, isCurrent, isProtocolFailure } = dependencies;
  for await (const event of events) {
    if (controller.signal.aborted && !isProtocolFailure()) break;
    // Re-read per event, not once per stream. Every `await` on the iterator
    // is a gap in which a submission, a navigation or a disposal can land,
    // and the frame that comes back after one is exactly the stale callback
    // this guard exists to stop.
    if (!isCurrent()) break;
    reduceEvent(dependencies, event);
  }
}

/**
 * Reduces one frame into turn state.
 *
 * The return type is the exhaustiveness check. Every `case` returns `true`
 * and there is deliberately no `default:`, so a `ChatStreamEvent` type with
 * no `case` lets control reach the end of the function, which TypeScript
 * rejects (TS2366) at `typecheck` time. A `never` assertion after the switch
 * would be flagged as unreachable code instead of checking anything.
 */
function reduceEvent(dependencies: SessionEventDependencies, event: ChatStreamEvent): true {
  const { controller, state, markProtocolFailure } = dependencies;
  switch (event.type) {
    case 'text':
      // LEGACY and RICH are two projections of the same tokens, and a host
      // that emits both would otherwise have its text counted twice.
      // Whichever vocabulary speaks first owns the row for this turn; the
      // other is dropped rather than merged, because merging two views of
      // one stream produces text that never existed.
      if (state.richTextSeen) return true;
      state.legacyTextSeen = true;
      appendAssistantText(dependencies, state.currentAssistantText + event.text, event.text);
      return true;
    case 'stream:text-delta':
      if (state.legacyTextSeen) return true;
      state.richTextSeen = true;
      appendAssistantText(dependencies, event.accumulated, event.content);
      return true;
    case 'tool_call':
      applyToolCall(dependencies, event.id, event.name, event.arguments);
      return true;
    case 'tool_result':
      applyToolResult(dependencies, event.callId, event);
      return true;
    case 'tool.settled':
      // A settlement is only reducible once the call it settles has a row.
      // `tool.settled` reports that a tool FINISHED EXECUTING, which a
      // producer can know before the step owning the call has completed —
      // so it legitimately reaches the wire ahead of the `tool_call` frame.
      // Appending a result for a call the transcript cannot see is rejected
      // by the conversation model itself, so an early settlement is left to
      // the transcript-ordered `tool_result` that follows the call.
      if (!state.toolCalls.has(event.toolCallId)) return true;
      applyToolResult(dependencies, event.toolCallId, event.result);
      return true;
    case 'tool.started':
    case 'tool.progress':
    case 'tool.error':
    case 'tool.policy-denied':
      applyToolActivity(dependencies, event);
      return true;
    case 'elicitation.requested':
    case 'elicitation.resolved':
      applyElicitation(dependencies, event);
      return true;
    case 'assistant.step.started':
      applyStepStarted(dependencies, event.step, event.messageId);
      return true;
    case 'run.completed':
      // Recorded, not applied. Reconciliation happens once, after the
      // stream has closed, so a frame that follows the terminal cannot be
      // reduced into a history the terminal has already replaced.
      state.terminalConversation = event.conversation;
      return true;
    case 'run.aborted':
      // Recorded, not applied, for the same reason as `run.completed`. The
      // controller is deliberately NOT aborted here: the stream guard
      // rejects any frame after the terminal, and that rejection only
      // reads as a protocol failure while the controller is still live.
      // Aborting would turn a trailing bad frame into a silent cancellation.
      state.runAborted = event.reason === undefined ? {} : { reason: event.reason };
      return true;
    case 'assistant.step.completed':
      // Only the step that is actually open: a late or duplicated
      // completion for a step already closed must not finalize the row the
      // NEXT step is streaming into.
      if (event.step === state.currentStep) settleCurrentRow(dependencies);
      return true;
    case 'run.error':
    case 'run.tripwire':
      markProtocolFailure();
      controller.abort();
      throw new ChatRunFailureError(event.error);
    case 'stream:block-start':
    case 'stream:block-delta':
    case 'stream:block-complete':
    case 'stream:tool-call-start':
    case 'stream:tool-call-delta':
    case 'stream:tool-call-complete':
    case 'stream:usage':
    case 'stream:complete':
    case 'stream:error':
      // Intentionally ignored, and the compiler holds this list to the
      // tuple above. Text arrives as `text`/`stream:text-delta`; a tool call
      // becomes a row only from `tool_call`, which carries the same
      // arguments; usage and the final conversation arrive on
      // `run.completed`; and `stream:error` is a raw echo that the host
      // always follows with one terminal `run.error`, so reducing it too
      // would report the failure twice.
      event.type satisfies (typeof IGNORED_STREAM_EVENT_TYPES)[number];
      return true;
  }
}

type ToolActivityEvent = Extract<
  ChatStreamEvent,
  { type: 'tool.started' | 'tool.progress' | 'tool.error' | 'tool.policy-denied' }
>;

function toolActivityOf(event: ToolActivityEvent): ChatToolActivity {
  const identity = { toolCallId: event.toolCallId, toolName: event.toolName };
  switch (event.type) {
    case 'tool.started':
      return { ...identity, status: 'started' };
    case 'tool.progress':
      return {
        ...identity,
        status: 'progress',
        ...(event.percent === undefined ? {} : { percent: event.percent }),
        ...(event.message === undefined ? {} : { message: event.message }),
      };
    case 'tool.error':
      return { ...identity, status: 'error', error: event.error };
    case 'tool.policy-denied':
      return {
        ...identity,
        status: 'policy-denied',
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      };
  }
}

/**
 * Records a `tool.*` activity frame per call and tells the observer.
 *
 * Activity is keyed by `toolCallId` alone and never needs a transcript row:
 * a producer writes these frames while the tool executes, ahead of the
 * `tool_call` that gives the call a row. It also never writes
 * `toolCalls`, `toolResults`, or the approval state, so it cannot change
 * whether the turn continues.
 *
 * Terminal-sticky: a call that errored, was denied, or already settled takes
 * no further activity, so a late `tool.progress` cannot resurrect it.
 */
function applyToolActivity(dependencies: SessionEventDependencies, event: ToolActivityEvent): void {
  const { state, options, reportError } = dependencies;
  const id = event.toolCallId;
  const current = state.toolActivity.get(id);
  if (state.toolResults.has(id)) return;
  if (current?.status === 'error' || current?.status === 'policy-denied') return;
  if (event.type === 'tool.started' && current !== undefined) return;
  const activity = toolActivityOf(event);
  // Recorded BEFORE the observer runs, so a throwing observer cannot roll it back.
  state.toolActivity.set(id, activity);
  try {
    options.hooks?.onToolActivity?.(activity);
  } catch (observerError) {
    reportError(observerError);
  }
}

/**
 * Records an `elicitation.*` frame by `requestId` and tells the observer.
 *
 * Kept entirely apart from approval: a resolution reports the human's answer,
 * not tool settlement, so neither frame touches `approvalRequired` or
 * `pendingApprovals`. Request identity is immutable, so a repeated request is
 * ignored, and a resolution with nothing pending to settle is dropped. A
 * resolved request is retained rather than removed so duplicates are seen.
 */
function applyElicitation(
  { elicitations, options, reportError }: SessionEventDependencies,
  event: Extract<ChatStreamEvent, { type: 'elicitation.requested' | 'elicitation.resolved' }>,
): void {
  const existing = elicitations.get(event.requestId);
  let activity: ChatElicitationActivity;
  if (event.type === 'elicitation.requested') {
    if (existing !== undefined) return;
    activity = {
      status: 'requested',
      requestId: event.requestId,
      message: event.message,
      ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
      ...(event.action === undefined ? {} : { action: event.action }),
    };
  } else {
    if (existing?.status !== 'requested') return;
    activity = {
      status: 'resolved',
      requestId: event.requestId,
      accepted: event.accepted,
      ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
    };
  }
  elicitations.set(event.requestId, activity);
  try {
    options.hooks?.onElicitation?.(activity);
  } catch (observerError) {
    reportError(observerError);
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
  const next = appendToolCall(options.getConversation(), { id, name, arguments: args });
  update(next);
  recordProvisionalRow(state, next, (message) => message.toolCall?.id === id);
  toolOwners.set(id, userMessageId);
  state.toolCalls.add(id);
  state.committed = options.getConversation();
}

/**
 * Remembers the row a builder just appended so a terminal snapshot can
 * replace it. The row's own identifier is the client's, minted by the
 * builder; the terminal names the same content under the host's.
 */
function recordProvisionalRow(
  state: TurnState,
  history: ConversationHistory,
  matches: (message: ConversationHistory['messages'][string]) => boolean,
): void {
  const row = history.ids.findLast((id) => {
    const message = history.messages[id];
    return message !== undefined && matches(message);
  });
  if (row !== undefined) state.provisionalIds.add(row);
}

function applyToolResult(
  dependencies: SessionEventDependencies,
  callId: string,
  result: ToolResult,
): void {
  const { state, options, update, pendingApprovals, reportError } = dependencies;
  // Keyed by CALL identifier, not by frame: `tool_result` and `tool.settled`
  // are the legacy and rich projections of one settlement, and a host that
  // emits both would otherwise append the same outcome twice — and call the
  // host's own `onToolResult` observer twice for one tool run.
  if (state.toolResults.has(callId)) return;
  state.provisionalIds.add(callId);
  state.toolResultSeen = true;
  state.toolResults.add(callId);
  const requiresApproval = result.outcome === 'action_required' && result.action !== undefined;
  state.approvalRequired ||= requiresApproval;
  if (requiresApproval) pendingApprovals.add(callId);
  else pendingApprovals.delete(callId);
  const next = appendToolResult(options.getConversation(), result);
  update(next);
  recordProvisionalRow(state, next, (message) => message.toolResult?.callId === callId);
  state.committed = options.getConversation();
  try {
    options.hooks?.onToolResult?.(result);
  } catch (observerError) {
    reportError(observerError);
  }
}

/**
 * Settles the row the current step was streaming into.
 *
 * An EMPTY row is cancelled rather than finalized, the same rule the end of a
 * turn applies. A step that only called a tool — the model reaching for
 * `remember_note` without saying anything first — owns no prose, so it owns
 * no row; finalizing it would leave an empty assistant bubble above the tool
 * activity that nothing will ever fill.
 */
function settleCurrentRow({ state, options, update }: SessionEventDependencies): void {
  const conversation = options.getConversation();
  if (state.currentAssistantText) {
    update(finalizeStreamingMessage(conversation, state.currentAssistantMessageId));
    return;
  }
  update(cancelStreamingMessage(conversation, state.currentAssistantMessageId));
  // The row is gone, so a terminal snapshot has nothing to replace here.
  state.provisionalIds.delete(state.currentAssistantMessageId);
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
    settleCurrentRow(dependencies);
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
