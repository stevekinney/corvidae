import type { Message as AGUIMessage } from '@ag-ui/core';
import type { ConversationHistory } from '../components/chat/conversation-model.ts';
import { AGUIChatTransportError } from './ag-ui-transport-error.ts';
import type { ChatStreamBlock } from './stream-event-codec.ts';

/** The wire version these frames speak: the first one with `run.started` and message identity. */
export const WIRE_VERSION = 3;

/**
 * The run id of the `run.started` frame written ahead of a `RUN_ERROR` that
 * arrives before any `RUN_STARTED`. A version 3 stream opens with that frame,
 * and a failure before the run began has no run to name.
 */
export const UNSTARTED_RUN_ID = 'ag-ui:unstarted';

/**
 * A place in the terminal conversation, reserved when a message starts and
 * filled when it ends, so messages land in the order they began even when they
 * end in another order.
 */
export type Slot = { message: AGUIMessage | undefined };

export type OpenText = { step: number; text: string; slot: Slot; assistantText: { text: string } };
export type OpenCall = {
  name: string;
  args: string;
  slot: Slot;
  parentMessageId: string | undefined;
};
export type ReasoningSpan = { block: ChatStreamBlock };
export type ReasoningMessage = { span: ReasoningSpan; slot: Slot; content: string; open: boolean };

/** Everything the mapping remembers about one run, and nothing about any other. */
export type MapperState = {
  /** History the run's messages are merged into; grown by each `MESSAGES_SNAPSHOT`. */
  base: ConversationHistory;
  /** Messages the run produced since `base`, in the order they started. */
  slots: Slot[];
  /** Every assistant message's text, in the order the messages started, for `run.completed.content`. */
  assistantTexts: Array<{ text: string }>;
  sequence: number;
  runId: string | undefined;
  threadId: string | undefined;
  finished: boolean;
  step: number;
  blockIndex: number;
  openText: Map<string, OpenText>;
  /** Text messages from a role the session already owns (user, developer, system). */
  foreignText: Set<string>;
  /** The message a `TEXT_MESSAGE_CHUNK` run is extending, with the role it opened with. */
  textLane: { messageId: string; role: string } | undefined;
  openCalls: Map<string, OpenCall>;
  settledCalls: Set<string>;
  /** The call a `TOOL_CALL_CHUNK` run is extending, with the name it opened with. */
  callLane: { toolCallId: string; name: string } | undefined;
  openSteps: Map<string, ChatStreamBlock>;
  /** Reasoning spans, keyed by the span id `REASONING_START` and `REASONING_END` name. */
  spans: Map<string, ReasoningSpan>;
  /** Reasoning messages, keyed by their own ids, across every span of the run. */
  reasoningMessages: Map<string, ReasoningMessage>;
  reasoningLane: string | undefined;
  encryptedValues: Map<string, string>;
};

export function createMapperState(base: ConversationHistory): MapperState {
  return {
    base,
    slots: [],
    assistantTexts: [],
    sequence: 0,
    runId: undefined,
    threadId: undefined,
    finished: false,
    step: 0,
    blockIndex: 0,
    openText: new Map(),
    foreignText: new Set(),
    textLane: undefined,
    openCalls: new Map(),
    settledCalls: new Set(),
    callLane: undefined,
    openSteps: new Map(),
    spans: new Map(),
    reasoningMessages: new Map(),
    reasoningLane: undefined,
    encryptedValues: new Map(),
  };
}

/** The envelope for the next frame; calling it in frame order keeps `sequence` increasing. */
export function wire(state: MapperState): { wireVersion: typeof WIRE_VERSION; sequence: number } {
  return { wireVersion: WIRE_VERSION, sequence: state.sequence++ };
}

export function protocolError(message: string): AGUIChatTransportError {
  return new AGUIChatTransportError('protocol', message);
}

/** Reserves the next place in the terminal conversation. */
export function reserveSlot(state: MapperState): Slot {
  const slot: Slot = { message: undefined };
  state.slots.push(slot);
  return slot;
}

export function newBlock(
  state: MapperState,
  id: string,
  type: ChatStreamBlock['type'],
  content: string,
): ChatStreamBlock {
  return { id, type, index: state.blockIndex++, content, complete: false };
}
