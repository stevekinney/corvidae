import {
  EventType,
  type Event as AGUIEvent,
  type ToolCall as AGUIToolCall,
  type ToolMessage,
} from '@ag-ui/core';
import { fromAGUIToolMessage } from 'conversationalist';
import { isJSONValue } from '../components/chat/builders.ts';
import type { JSONValue } from '../components/chat/conversation-model.ts';
import {
  newBlock,
  protocolError,
  reserveSlot,
  wire,
  type MapperState,
  type OpenCall,
  type OpenText,
  type Slot,
  type WireText,
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
  if (state.startedText.has(messageId))
    throw protocolError(`Text message ${messageId} started twice.`);
  state.startedText.add(messageId);
  if (role !== 'assistant') {
    state.foreignText.add(messageId);
    return;
  }
  const assistantText = { text: '' };
  state.assistantTexts.push(assistantText);
  const queued: WireText = {
    messageId,
    step: state.step++,
    deltas: [],
    emitted: false,
    ended: false,
  };
  state.wireQueue.push(queued);
  state.openText.set(messageId, {
    text: '',
    slot: reserveSlot(state),
    assistantText,
    wire: queued,
    calls: [],
  });
  yield* drainWire(state);
}

/**
 * Writes what the wire is ready for: the head of the queue opens its step and
 * releases the deltas it held, and closes it if it has already ended, and then
 * the next message gets its turn.
 */
function* drainWire(state: MapperState): Generator<ChatStreamEvent> {
  for (let head = state.wireQueue[0]; head !== undefined; head = state.wireQueue[0]) {
    if (!head.emitted) {
      head.emitted = true;
      yield {
        type: 'assistant.step.started',
        step: head.step,
        messageId: head.messageId,
        ...wire(state),
      };
      let accumulated = '';
      for (const delta of head.deltas) {
        accumulated += delta;
        yield textDeltaFrame(state, head.messageId, delta, accumulated);
      }
      head.deltas = [];
    }
    if (!head.ended) return;
    yield {
      type: 'assistant.step.completed',
      step: head.step,
      messageId: head.messageId,
      ...wire(state),
    };
    state.wireQueue.shift();
  }
}

function textDeltaFrame(
  state: MapperState,
  messageId: string,
  content: string,
  accumulated: string,
): ChatStreamEvent {
  return { type: 'stream:text-delta', content, accumulated, messageId, ...wire(state) };
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
  if (open.wire.emitted) yield textDeltaFrame(state, messageId, delta, open.text);
  else open.wire.deltas.push(delta);
}

export function* endText(state: MapperState, messageId: string): Generator<ChatStreamEvent> {
  const open = state.openText.get(messageId);
  if (open === undefined) {
    if (state.foreignText.delete(messageId)) return;
    throw protocolError(`Text message ${messageId} ended without starting.`);
  }
  state.openText.delete(messageId);
  open.wire.ended = true;
  writeAssistantMessage(state, messageId, open);
  yield* drainWire(state);
}

/**
 * Fills the slot reserved for an assistant message with what it said and the
 * calls that were made on it. If a call already filed a message under this id
 * (it ended before the message even started), the text joins that message.
 */
function writeAssistantMessage(state: MapperState, messageId: string, open: OpenText): void {
  const content = open.text.length > 0 ? { content: open.text } : {};
  const earlier = findAssistantSlot(state, messageId);
  if (earlier?.message?.role === 'assistant') {
    const toolCalls = [...(earlier.message.toolCalls ?? []), ...open.calls];
    earlier.message = {
      ...earlier.message,
      ...content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
    return;
  }
  if (open.text.length === 0 && open.calls.length === 0) return;
  open.slot.message = {
    id: messageId,
    role: 'assistant',
    ...content,
    ...(open.calls.length > 0 ? { toolCalls: open.calls } : {}),
  };
}

function findAssistantSlot(state: MapperState, messageId: string): Slot | undefined {
  return state.slots.find(
    (slot) => slot.message?.role === 'assistant' && slot.message.id === messageId,
  );
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
  const entry: AGUIToolCall = {
    id: toolCallId,
    type: 'function',
    function: { name: call.name, arguments: call.args === '' ? '{}' : call.args },
  };
  fileCall(state, call, entry);
  yield {
    type: 'stream:tool-call-complete',
    toolName: call.name,
    blockId: toolCallId,
    arguments: args,
    ...wire(state),
  };
  yield { type: 'tool_call', id: toolCallId, name: call.name, arguments: args, ...wire(state) };
}

/**
 * Files a finished call under the assistant message that made it, so the call
 * gets the row id a snapshot of the same thread gives it. A call names its
 * parent message; the message may still be streaming (the call joins it when it
 * ends), may have ended (the call joins it now), or may never have said a word
 * (the call is then that message, under the parent's id, and later calls naming
 * the same parent join it). A call that names no parent is a message of its own.
 */
function fileCall(state: MapperState, call: OpenCall, entry: AGUIToolCall): void {
  const parentId = call.parentMessageId;
  if (parentId === undefined) {
    call.slot.message = { id: `${entry.id}:message`, role: 'assistant', toolCalls: [entry] };
    return;
  }
  const streaming = state.openText.get(parentId);
  if (streaming !== undefined) {
    streaming.calls.push(entry);
    return;
  }
  const held = findAssistantSlot(state, parentId);
  if (held?.message?.role === 'assistant') {
    held.message = { ...held.message, toolCalls: [...(held.message.toolCalls ?? []), entry] };
    return;
  }
  call.slot.message = { id: parentId, role: 'assistant', toolCalls: [entry] };
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
