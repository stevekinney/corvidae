import { EventType, type Event as AGUIEvent, type ToolMessage } from '@ag-ui/core';
import { fromAGUIToolMessage } from 'conversationalist';
import { isJSONValue } from '../components/chat/builders.ts';
import type { JSONValue } from '../components/chat/conversation-model.ts';
import {
  newBlock,
  protocolError,
  reserveSlot,
  wire,
  type MapperState,
} from './ag-ui-transport-state.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

export function* startStep(state: MapperState, stepName: string): Generator<ChatStreamEvent> {
  if (state.openSteps.has(stepName)) throw protocolError(`Step ${stepName} started twice.`);
  const block = newBlock(state, `step:${stepName}:${state.blockIndex}`, 'metadata', stepName);
  state.openSteps.set(stepName, block);
  yield { type: 'stream:block-start', block: { ...block }, ...wire(state) };
}

export function* finishStep(state: MapperState, stepName: string): Generator<ChatStreamEvent> {
  const block = state.openSteps.get(stepName);
  if (block === undefined) throw protocolError(`Step ${stepName} finished without starting.`);
  state.openSteps.delete(stepName);
  yield { type: 'stream:block-complete', block: { ...block, complete: true }, ...wire(state) };
}

export function* startText(
  state: MapperState,
  messageId: string,
  role: string,
): Generator<ChatStreamEvent> {
  if (state.openText.has(messageId) || state.foreignText.has(messageId))
    throw protocolError(`Text message ${messageId} started twice.`);
  if (role !== 'assistant') {
    state.foreignText.add(messageId);
    return;
  }
  const assistantText = { text: '' };
  state.assistantTexts.push(assistantText);
  const open = { step: state.step++, text: '', slot: reserveSlot(state), assistantText };
  state.openText.set(messageId, open);
  yield { type: 'assistant.step.started', step: open.step, messageId, ...wire(state) };
}

export function* textDelta(
  state: MapperState,
  messageId: string,
  delta: string,
): Generator<ChatStreamEvent> {
  const open = state.openText.get(messageId);
  if (open === undefined) {
    if (state.foreignText.has(messageId)) return;
    throw protocolError(`Text content arrived for unopened message ${messageId}.`);
  }
  open.text += delta;
  open.assistantText.text = open.text;
  yield {
    type: 'stream:text-delta',
    content: delta,
    accumulated: open.text,
    messageId,
    ...wire(state),
  };
}

export function* endText(state: MapperState, messageId: string): Generator<ChatStreamEvent> {
  const open = state.openText.get(messageId);
  if (open === undefined) {
    if (state.foreignText.delete(messageId)) return;
    throw protocolError(`Text message ${messageId} ended without starting.`);
  }
  state.openText.delete(messageId);
  if (open.text.length > 0)
    open.slot.message = { id: messageId, role: 'assistant', content: open.text };
  yield { type: 'assistant.step.completed', step: open.step, messageId, ...wire(state) };
}

export function* textChunk(
  state: MapperState,
  event: Extract<AGUIEvent, { type: EventType.TEXT_MESSAGE_CHUNK }>,
): Generator<ChatStreamEvent> {
  const messageId = event.messageId ?? state.textLane?.messageId;
  if (messageId === undefined)
    throw protocolError('The first TEXT_MESSAGE_CHUNK of a message must carry a messageId.');
  if (state.textLane?.messageId === messageId) {
    // A continuation may repeat what the opener said, but not change it.
    if (event.role !== undefined && event.role !== state.textLane.role)
      throw protocolError(
        `TEXT_MESSAGE_CHUNK for ${messageId} changed its role from ${state.textLane.role} to ${event.role}.`,
      );
  } else {
    yield* closeTextLane(state);
    const role = event.role ?? 'assistant';
    yield* startText(state, messageId, role);
    state.textLane = { messageId, role };
  }
  if (event.delta !== undefined && event.delta.length > 0)
    yield* textDelta(state, messageId, event.delta);
}

export function* closeTextLane(state: MapperState): Generator<ChatStreamEvent> {
  const lane = state.textLane;
  if (lane === undefined) return;
  state.textLane = undefined;
  yield* endText(state, lane.messageId);
}

export function* startCall(
  state: MapperState,
  toolCallId: string,
  name: string,
  parentMessageId: string | undefined,
): Generator<ChatStreamEvent> {
  if (state.openCalls.has(toolCallId) || state.settledCalls.has(toolCallId))
    throw protocolError(`Tool call ${toolCallId} started twice.`);
  state.openCalls.set(toolCallId, { name, args: '', slot: reserveSlot(state), parentMessageId });
  yield { type: 'stream:tool-call-start', toolName: name, blockId: toolCallId, ...wire(state) };
}

export function* callDelta(
  state: MapperState,
  toolCallId: string,
  delta: string,
): Generator<ChatStreamEvent> {
  const call = state.openCalls.get(toolCallId);
  if (call === undefined) throw protocolError(`Arguments arrived for unopened call ${toolCallId}.`);
  call.args += delta;
  // Cumulative, like every other producer of this frame.
  yield {
    type: 'stream:tool-call-delta',
    toolName: call.name,
    blockId: toolCallId,
    partialArguments: call.args,
    ...wire(state),
  };
}

export function* endCall(state: MapperState, toolCallId: string): Generator<ChatStreamEvent> {
  const call = state.openCalls.get(toolCallId);
  if (call === undefined) throw protocolError(`Tool call ${toolCallId} ended without starting.`);
  state.openCalls.delete(toolCallId);
  state.settledCalls.add(toolCallId);
  const args = parseArguments(call.args);
  const entry = {
    id: toolCallId,
    type: 'function' as const,
    function: { name: call.name, arguments: call.args === '' ? '{}' : call.args },
  };
  // A call belongs to the assistant message that made it when that message has
  // already ended, so the two come back as one message under one id. Otherwise
  // the call is a message of its own, under an id that cannot be the parent's:
  // a message with no text gives its first call its own id.
  const parent = state.slots.find(
    (slot) => slot.message?.role === 'assistant' && slot.message.id === call.parentMessageId,
  );
  if (parent?.message?.role === 'assistant') {
    parent.message = { ...parent.message, toolCalls: [...(parent.message.toolCalls ?? []), entry] };
  } else {
    call.slot.message = { id: `${toolCallId}:message`, role: 'assistant', toolCalls: [entry] };
  }
  yield {
    type: 'stream:tool-call-complete',
    toolName: call.name,
    blockId: toolCallId,
    arguments: args,
    ...wire(state),
  };
  yield { type: 'tool_call', id: toolCallId, name: call.name, arguments: args, ...wire(state) };
}

export function* callChunk(
  state: MapperState,
  event: Extract<AGUIEvent, { type: EventType.TOOL_CALL_CHUNK }>,
): Generator<ChatStreamEvent> {
  const toolCallId = event.toolCallId ?? state.callLane?.toolCallId;
  if (toolCallId === undefined)
    throw protocolError('The first TOOL_CALL_CHUNK of a call must carry a toolCallId.');
  if (state.callLane?.toolCallId === toolCallId) {
    if (event.toolCallName !== undefined && event.toolCallName !== state.callLane.name)
      throw protocolError(
        `TOOL_CALL_CHUNK for ${toolCallId} changed its toolCallName from ${state.callLane.name} to ${event.toolCallName}.`,
      );
  } else {
    yield* closeCallLane(state);
    if (event.toolCallName === undefined)
      throw protocolError(`The first TOOL_CALL_CHUNK of ${toolCallId} must carry a toolCallName.`);
    yield* startCall(state, toolCallId, event.toolCallName, event.parentMessageId);
    state.callLane = { toolCallId, name: event.toolCallName };
  }
  if (event.delta !== undefined && event.delta.length > 0)
    yield* callDelta(state, toolCallId, event.delta);
}

export function* closeCallLane(state: MapperState): Generator<ChatStreamEvent> {
  const lane = state.callLane;
  if (lane === undefined) return;
  state.callLane = undefined;
  yield* endCall(state, lane.toolCallId);
}

function parseArguments(args: string): JSONValue {
  if (args === '') return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return isJSONValue(parsed) ? parsed : args;
  } catch {
    // Kept as written, like the conversation model does: the arguments are
    // the model's, and a malformed string is data about what it produced.
    return args;
  }
}

export function* callResult(
  state: MapperState,
  event: Extract<AGUIEvent, { type: EventType.TOOL_CALL_RESULT }>,
): Generator<ChatStreamEvent> {
  if (!state.settledCalls.has(event.toolCallId))
    throw protocolError(`A result arrived for tool call ${event.toolCallId}, which has not ended.`);
  const message: ToolMessage = {
    id: event.messageId,
    role: 'tool',
    toolCallId: event.toolCallId,
    content: event.content,
  };
  state.slots.push({ message });
  yield { type: 'tool_result', ...fromAGUIToolMessage(message), ...wire(state) };
}
