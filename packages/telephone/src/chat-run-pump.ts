import {
  StepCompletedEvent,
  ToolErrorBubbleEvent,
  ToolPolicyDeniedBubbleEvent,
  ToolProgressBubbleEvent,
  ToolSettledBubbleEvent,
  ToolsExecutedEvent,
  ToolStartedBubbleEvent,
  type AgentRun,
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

import type { ChatStreamEvent } from '@lostgradient/chat/stream-events';
import type { ToolExecutionResult, ToolResult } from 'armorer';

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
    message: SAFE_CHAT_FAILURE_MESSAGE,
  };
  if (envelope.status === 'tripwire') return { type: 'run.tripwire', error: serialized };
  return { type: 'run.error', error: serialized };
}

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

function writeRunEvent(
  event: unknown,
  writer: ChatStreamWriter,
  filteredToolCalls: Set<string>,
): void {
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
  if (event instanceof StepCompletedEvent) {
    writeStepCompletedEvent(event, writer, filteredToolCalls);
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

async function finishRun(
  run: AgentRun<unknown, boolean>,
  writer: ChatStreamWriter,
): Promise<ChatRunEnvelope> {
  const result = await run.result();
  if (FAILURE_FINISH_REASONS.has(result.finishReason)) {
    const envelope = classifyChatRunFailure(result.error, result.finishReason);
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

/**
 * Consumes one `AgentRun`'s event stream, projecting tool lifecycle events and
 * each step's tool calls and results into `writer` as they happen, then derives
 * the ONE terminal `run.*` frame from `run.result()`.
 *
 * The terminal frame comes from `run.result()`, not from Operative's own
 * `run.completed`/`run.error` events, because for a failed run Operative fires
 * BOTH (`run.error`, then `run.completed` with `finishReason: 'error'`) —
 * mirroring those would put two terminals on the wire. `run.result()` is the
 * one authoritative outcome, and the writer refuses a second terminal anyway.
 *
 * `tool.settled` is sourced from `ToolsExecutedEvent.results` rather than from
 * Operative's `ToolSettledBubbleEvent`: the bubble's `result` is the tool's RAW
 * return value, not the `ToolResult` the wire wants, and an approval-paused
 * call never gets a bubble at all.
 *
 * ALWAYS RESOLVES, never rejects, and always writes exactly one terminal frame.
 * The renderer's decoder treats a stream that ends without a terminal frame as
 * a truncated response, so a rejection escaping here would surface to the
 * person as a protocol error rather than as the failure that actually occurred.
 */
export async function pumpChatRun(
  run: AgentRun<unknown, boolean>,
  writer: ChatStreamWriter,
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
    return await finishRun(run, writer);
  } catch (cause) {
    const finishReason =
      cause instanceof Error && cause.name === 'AbortError' ? 'aborted' : 'error';
    const envelope = classifyChatRunFailure(cause, finishReason);
    writer.write(toTerminalFailureFrame(envelope));
    return envelope;
  }
}
