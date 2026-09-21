import type { ToolExecutionResult, ToolResult } from 'armorer';
import type { ChatStreamEvent } from '@lostgradient/chat';
import {
  ElicitationRequestedEvent,
  ElicitationResolvedEvent,
  StepCompletedEvent,
  ToolErrorBubbleEvent,
  ToolPolicyDeniedBubbleEvent,
  ToolProgressBubbleEvent,
  ToolSettledBubbleEvent,
  ToolsExecutedEvent,
  ToolStartedBubbleEvent,
  type AgentRun,
  type ConversationHistory,
} from '@lostgradient/operative';
import {
  classifyChatRunFailure,
  SAFE_CHAT_FAILURE_MESSAGE,
  type ChatRunEnvelope,
  type ChatSerializedRunError,
  type ChatStreamFrame,
  type ChatStreamWriter,
} from './chat-agent.ts';
import { toJSONValue } from './json-value.ts';
import {
  SERVER_OWNED_PERSISTENCE_FAILURE_MESSAGE,
  serverOwnedPersistenceFailureHint,
} from './server-owned-snapshot.ts';

type ChatToolResult = Extract<ChatStreamEvent, { type: 'tool.settled' }>['result'];
const FILTERED_TOOL_RESULT = 'Tool execution skipped by beforeToolExecution hook';
const FILTERED_TOOL_CONTENT = 'This call did not run, and reported no result.';

const FAILURE_FINISH_REASONS = new Set([
  'error',
  'aborted',
  'tripwire',
  'budget-exceeded',
  'elicitation-denied',
  'maximum-steps',
]);
function toChatToolResult(
  result: ToolResult & Pick<ToolExecutionResult, 'pendingApproval'>,
): ChatToolResult {
  return {
    callId: result.callId,
    outcome: result.outcome,
    content: result.content,
    ...(result.error ? { error: result.error } : {}),
    ...(result.action ? { action: result.action } : {}),
    ...(result.pendingApproval ? { pendingApproval: toJSONValue(result.pendingApproval) } : {}),
  };
}

function toTerminalFailureFrame(
  envelope: Extract<ChatRunEnvelope, { ok: false }>,
): ChatStreamFrame {
  if (envelope.status === 'aborted') return { type: 'run.aborted', reason: envelope.error.message };
  const serialized: ChatSerializedRunError = {
    name: 'Error',
    ...envelope.error,
  };
  serialized.message =
    serialized.message === SERVER_OWNED_PERSISTENCE_FAILURE_MESSAGE
      ? serialized.message
      : SAFE_CHAT_FAILURE_MESSAGE;
  if (envelope.status === 'tripwire') return { type: 'run.tripwire', error: serialized };
  return { type: 'run.error', error: serialized };
}

type BeforeFailure = (input: {
  conversation: ConversationHistory;
  error: ChatSerializedRunError;
}) => Promise<void>;

function syntheticFilteredResult(callId: string): ChatToolResult {
  return { callId, outcome: 'error', content: FILTERED_TOOL_CONTENT };
}

function writeSyntheticSettlement(
  writer: ChatStreamWriter,
  toolCallId: string,
  toolName: string,
  result: ChatToolResult,
): void {
  writer.write({ type: 'tool.settled', toolCallId, toolName, result });
  writer.write({ type: 'tool_result', ...result });
}

function writeToolsExecutedEvent(event: ToolsExecutedEvent, writer: ChatStreamWriter): void {
  for (const result of event.results) {
    writer.write({
      type: 'tool.settled',
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      result: toChatToolResult(result),
    });
  }
}

function writeStepToolCalls(event: StepCompletedEvent, writer: ChatStreamWriter): void {
  for (const toolCall of event.toolCalls) {
    writer.write({
      type: 'tool_call',
      id: toolCall.id,
      name: toolCall.name,
      arguments: toJSONValue(toolCall.arguments),
    });
  }
}

function writeStepToolResults(
  event: StepCompletedEvent,
  writer: ChatStreamWriter,
  filteredToolCalls: ReadonlySet<string>,
): void {
  const resultsByCallId = new Map(event.results.map((result) => [result.callId, result]));
  for (const toolCall of event.toolCalls) {
    if (filteredToolCalls.has(toolCall.id)) {
      writeSyntheticSettlement(
        writer,
        toolCall.id,
        toolCall.name,
        syntheticFilteredResult(toolCall.id),
      );
      continue;
    }
    const result = resultsByCallId.get(toolCall.id);
    if (result) {
      writer.write({ type: 'tool_result', ...toChatToolResult(result) });
      continue;
    }
    writeSyntheticSettlement(
      writer,
      toolCall.id,
      toolCall.name,
      syntheticFilteredResult(toolCall.id),
    );
  }
}

function writeStepCompletedEvent(
  event: StepCompletedEvent,
  writer: ChatStreamWriter,
  filteredToolCalls: ReadonlySet<string>,
): void {
  writeStepToolCalls(event, writer);
  writeStepToolResults(event, writer, filteredToolCalls);
}

function writeToolBubbleEvent(event: unknown, writer: ChatStreamWriter): boolean {
  if (event instanceof ToolStartedBubbleEvent) {
    writer.write({ type: 'tool.started', toolCallId: event.toolCallId, toolName: event.toolName });
    return true;
  }
  if (event instanceof ToolProgressBubbleEvent) {
    writer.write({
      type: 'tool.progress',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(event.percent !== undefined ? { percent: event.percent } : {}),
      ...(event.message !== undefined ? { message: event.message } : {}),
    });
    return true;
  }
  if (event instanceof ToolErrorBubbleEvent) {
    writer.write({
      type: 'tool.error',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      error: toJSONValue(event.error),
    });
    return true;
  }
  if (event instanceof ToolPolicyDeniedBubbleEvent) {
    writer.write({
      type: 'tool.policy-denied',
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(event.reason !== undefined ? { reason: event.reason } : {}),
    });
    return true;
  }
  return false;
}

function isFilteredToolSettledBubble(event: unknown): event is ToolSettledBubbleEvent {
  return (
    event instanceof ToolSettledBubbleEvent &&
    (event.result === FILTERED_TOOL_RESULT || event.error === FILTERED_TOOL_RESULT)
  );
}

/**
 * Mirrors Operative's own elicitation lifecycle onto the wire.
 *
 * `ElicitationRequestedEvent` is dispatched BEFORE the `onElicitation`
 * callback is awaited (`run-step-support.ts`), which is what makes a live
 * question possible at all: this frame is written while the run is still
 * parked, so a client learns the question exists on the stream it already has
 * open rather than by asking whether one appeared.
 *
 * `elicitation.resolved` reports THE HUMAN'S ANSWER and nothing else. It is
 * deliberately not synthesized from a tool result, and a tool result is
 * deliberately not treated as an answer: a denied call still settles
 * afterwards through `tool.settled`, and a question can be answered while its
 * tool is still executing. Two events, written from the two events.
 *
 * `action` is NOT emitted. Operative's event says a question was asked, not
 * whether it is an approval or a request for input, and inventing that
 * distinction here would put a claim on the wire the run never made.
 */
function writeElicitationEvent(event: unknown, writer: ChatStreamWriter): boolean {
  if (event instanceof ElicitationRequestedEvent) {
    writer.write({
      type: 'elicitation.requested',
      requestId: event.requestId,
      ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
      message: event.message,
    });
    return true;
  }
  if (event instanceof ElicitationResolvedEvent) {
    writer.write({
      type: 'elicitation.resolved',
      requestId: event.requestId,
      ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
      accepted: event.accepted,
    });
    return true;
  }
  return false;
}

function writeRunEvent(
  event: unknown,
  writer: ChatStreamWriter,
  filteredToolCalls: Set<string>,
): void {
  if (writeElicitationEvent(event, writer)) return;
  if (writeToolBubbleEvent(event, writer)) return;
  if (isFilteredToolSettledBubble(event)) {
    // The bubble arrives before StepCompletedEvent supplies the canonical call
    // frame. Defer settlement so consumers never see a result for an unknown call.
    filteredToolCalls.add(event.toolCallId);
    return;
  }
  if (event instanceof ToolsExecutedEvent) {
    writeToolsExecutedEvent(event, writer);
    return;
  }
  if (event instanceof StepCompletedEvent)
    writeStepCompletedEvent(event, writer, filteredToolCalls);
}

function persistenceFailureEnvelope(): Extract<ChatRunEnvelope, { ok: false }> {
  return {
    ok: false,
    status: 'error',
    error: {
      kind: 'generate',
      code: 'UNKNOWN',
      message: SERVER_OWNED_PERSISTENCE_FAILURE_MESSAGE,
      retryable: false,
    },
  };
}

function latestUserMessageId(conversation: ConversationHistory): string | undefined {
  return [...conversation.ids]
    .toReversed()
    .find((messageId) => conversation.messages[messageId]?.role === 'user');
}

async function persistFailureBeforeTerminal(
  writer: ChatStreamWriter,
  envelope: Extract<ChatRunEnvelope, { ok: false }>,
  result: Awaited<ReturnType<AgentRun<unknown, boolean>['result']>>,
  beforeFailure: BeforeFailure | undefined,
): Promise<Extract<ChatRunEnvelope, { ok: false }>> {
  if (envelope.status === 'aborted' || beforeFailure === undefined) return envelope;
  const serialized: ChatSerializedRunError = {
    name: result.error instanceof Error ? result.error.name : 'Error',
    ...envelope.error,
  };
  try {
    await beforeFailure({ conversation: result.conversation.current, error: serialized });
    return envelope;
  } catch {
    const failedUserMessageId = latestUserMessageId(result.conversation.current);
    if (failedUserMessageId !== undefined && failedUserMessageId.length > 0) {
      writer.write({
        type: 'stream:error',
        error: toJSONValue(serverOwnedPersistenceFailureHint(failedUserMessageId)),
      });
    }
    return persistenceFailureEnvelope();
  }
}

async function finishRun(
  run: AgentRun<unknown, boolean>,
  writer: ChatStreamWriter,
  beforeFailure: BeforeFailure | undefined,
): Promise<ChatRunEnvelope> {
  const result = await run.result();
  if (FAILURE_FINISH_REASONS.has(result.finishReason)) {
    const classified = classifyChatRunFailure(result.error, result.finishReason);
    const envelope = await persistFailureBeforeTerminal(writer, classified, result, beforeFailure);
    writer.write(toTerminalFailureFrame(envelope));
    return envelope;
  }
  writer.write({
    type: 'run.completed',
    conversation: result.conversation.current,
    content: result.content,
    usage: result.usage,
    finishReason: result.finishReason,
  });
  return {
    ok: true,
    status: 'completed',
    content: result.content,
    ...('output' in result ? { output: result.output } : {}),
  };
}

function rejectedResultEnvelope(
  cause: unknown,
  beforeFailure: BeforeFailure | undefined,
): Extract<ChatRunEnvelope, { ok: false }> {
  const finishReason = cause instanceof Error && cause.name === 'AbortError' ? 'aborted' : 'error';
  const envelope = classifyChatRunFailure(cause, finishReason);
  return envelope.status !== 'aborted' && beforeFailure !== undefined
    ? persistenceFailureEnvelope()
    : envelope;
}

/**
 * Consumes one `AgentRun`'s event stream, projecting tool lifecycle events
 * and each step's tool calls and results into `writer` as they happen, then
 * derives the ONE terminal `run.*` frame — and the envelope the route uses
 * to decide how to end the response — from `run.result()`.
 *
 * The terminal frame is derived from `run.result()`, not from Operative's
 * own `run.completed`/`run.error` events, because for a failed run Operative
 * fires BOTH (`run.error`, then `run.completed` with `finishReason: 'error'`)
 * — mirroring those would put two terminals on the wire. `run.result()` is
 * the one authoritative outcome, and the writer refuses a second terminal
 * regardless.
 *
 * `tool.settled` is sourced from `ToolsExecutedEvent.results` rather than
 * from Operative's `ToolSettledBubbleEvent` for two reasons originally verified against
 * 0.8.0 and retained by the current installed-package regression suite: the bubble's `result` is the tool's RAW return value, not the
 * `ToolResult` the wire wants, and an approval-paused call never gets a
 * bubble at all — only `tools.executed` carries its `action_required`
 * result with the `pendingApproval` descriptor the client needs.
 *
 * `run.result()` is documented ("Any pending `result()` promise rejects with
 * an abort reason") to reject on abort, but empirically (verified against
 * the installed package directly) it RESOLVES for both an abort and a
 * generate failure, carrying `finishReason: 'aborted' | 'error'` and a real
 * `AgentRunError` on `.error`. The outer try/catch stays anyway as a genuine
 * defensive fallback — an escaped rejection here becomes an unhandled
 * promise rejection in the route's pump, the same hazard class the
 * pre-Operative loop's `'abort'` listener existed to prevent — so this
 * function is correct whichever path a given failure takes.
 */
export async function pumpChatRun(
  run: AgentRun<unknown, boolean>,
  writer: ChatStreamWriter,
  options: {
    beforeFailure?: BeforeFailure;
  } = {},
): Promise<ChatRunEnvelope> {
  const filteredToolCalls = new Set<string>();

  try {
    for await (const event of run) writeRunEvent(event, writer, filteredToolCalls);
  } catch (cause) {
    // Iteration failing is secondary to `run.result()`, which is the
    // authoritative terminal outcome — fall through and let it decide.
    void cause;
  }

  try {
    return await finishRun(run, writer, options.beforeFailure);
  } catch (cause) {
    const envelope = rejectedResultEnvelope(cause, options.beforeFailure);
    writer.write(toTerminalFailureFrame(envelope));
    return envelope;
  }
}
