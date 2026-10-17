import { EventType, type Event as AGUIEvent } from '@ag-ui/core';
import {
  newBlock,
  protocolError,
  reserveSlot,
  wire,
  type MapperState,
  type ReasoningMessage,
} from './ag-ui-transport-state.ts';
import type { ChatStreamEvent } from './stream-event-codec.ts';

/**
 * Reasoning has two levels, and the two sets of ids are independent.
 * `REASONING_START` and `REASONING_END` name a span, which becomes one
 * `thinking` block on the wire. `REASONING_MESSAGE_*` events name a message
 * inside the open span, and a span may hold several; each becomes a reasoning
 * message of its own in the terminal conversation.
 */
export function* startSpan(state: MapperState, spanId: string): Generator<ChatStreamEvent> {
  if (state.spans.has(spanId)) throw protocolError(`Reasoning ${spanId} started twice.`);
  const block = newBlock(state, spanId, 'thinking', '');
  state.spans.set(spanId, { block });
  yield { type: 'stream:block-start', block: { ...block }, ...wire(state) };
}

export function* endSpan(state: MapperState, spanId: string): Generator<ChatStreamEvent> {
  const span = state.spans.get(spanId);
  if (span === undefined) throw protocolError(`Reasoning ${spanId} ended before REASONING_START.`);
  const open = [...state.reasoningMessages.entries()].find(
    ([, message]) => message.span === span && message.open,
  );
  if (open !== undefined)
    throw protocolError(`Reasoning ${spanId} ended while its message ${open[0]} was still open.`);
  state.spans.delete(spanId);
  yield { type: 'stream:block-complete', block: { ...span.block, complete: true }, ...wire(state) };
}

export function startMessage(state: MapperState, messageId: string): ReasoningMessage {
  const span = [...state.spans.values()].at(-1);
  if (span === undefined)
    throw protocolError(`Reasoning message ${messageId} started outside a REASONING_START span.`);
  if (state.reasoningMessages.has(messageId))
    throw protocolError(`Reasoning message ${messageId} started twice.`);
  const message = { span, slot: reserveSlot(state), content: '', open: true };
  state.reasoningMessages.set(messageId, message);
  return message;
}

function openMessage(state: MapperState, messageId: string, action: string): ReasoningMessage {
  const message = state.reasoningMessages.get(messageId);
  if (message === undefined || !message.open)
    throw protocolError(`Reasoning ${action} arrived outside message ${messageId}.`);
  return message;
}

export function* messageDelta(
  state: MapperState,
  messageId: string,
  delta: string,
): Generator<ChatStreamEvent> {
  const message = openMessage(state, messageId, 'content');
  message.content += delta;
  message.span.block.content += delta;
  yield {
    type: 'stream:block-delta',
    block: { ...message.span.block },
    delta,
    ...wire(state),
  };
}

export function endMessage(state: MapperState, messageId: string): void {
  const message = openMessage(state, messageId, 'end');
  message.open = false;
  const encryptedValue = state.encryptedValues.get(messageId);
  message.slot.message = {
    id: messageId,
    role: 'reasoning',
    content: message.content,
    ...(encryptedValue === undefined ? {} : { encryptedValue }),
  };
}

export function* messageChunk(
  state: MapperState,
  event: Extract<AGUIEvent, { type: EventType.REASONING_MESSAGE_CHUNK }>,
): Generator<ChatStreamEvent> {
  const messageId = event.messageId ?? state.reasoningLane;
  if (messageId === undefined)
    throw protocolError('The first REASONING_MESSAGE_CHUNK must carry a messageId.');
  if (state.reasoningLane !== messageId) {
    closeReasoningLane(state);
    startMessage(state, messageId);
    state.reasoningLane = messageId;
  }
  if (event.delta !== undefined && event.delta.length > 0)
    yield* messageDelta(state, messageId, event.delta);
}

export function closeReasoningLane(state: MapperState): void {
  const messageId = state.reasoningLane;
  if (messageId === undefined) return;
  state.reasoningLane = undefined;
  endMessage(state, messageId);
}

/**
 * Records the encrypted value for a reasoning message, by the message's own id.
 * It can arrive before the message ends or after, so it is both remembered and
 * applied to a message already written.
 */
export function recordEncryptedValue(
  state: MapperState,
  messageId: string,
  encryptedValue: string,
): void {
  state.encryptedValues.set(messageId, encryptedValue);
  const written = state.reasoningMessages.get(messageId)?.slot;
  if (written?.message?.role === 'reasoning')
    written.message = { ...written.message, encryptedValue };
}
