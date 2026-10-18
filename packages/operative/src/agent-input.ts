/**
 * Agent input helpers (COR-716).
 *
 * `AgentInput` is a `SessionInputPayload` (a string, or an ordered list of
 * user-admissible text and media parts) or `{ conversation }`. Every start path
 * validates it once, snapshots it so the run and the caller's object are
 * independent, and turns a payload into exactly one `user` message. Nothing here
 * substitutes an empty string, keeps only the text, or rewrites a media part as
 * prose.
 */
import type { Conversation, ConversationHistory, MultiModalContent } from 'conversationalist';
import { isMediaContent, multiModalContentSchema } from 'conversationalist';

import type { SessionInputPayload } from './durable/types';
import { AgentContractError } from './errors';
import type { AgentInput } from './runnable-agent';

/** Whether an input is the `{ conversation }` form. */
export function isConversationInput(
  input: AgentInput,
): input is { conversation: ConversationHistory } {
  return typeof input === 'object' && !Array.isArray(input) && 'conversation' in input;
}

/**
 * Throws an `AgentContractError` for an input that cannot start a run: an empty
 * part list, or a part that is not user-admissible (provider-generated blocks,
 * text carrying citations, or a part that fails the content schema). A
 * `{ conversation }` input must hold a `ConversationHistory`.
 */
export function assertAgentInput(input: unknown): asserts input is AgentInput {
  if (typeof input === 'string') return;
  if (Array.isArray(input)) {
    assertPartList(input);
    return;
  }
  if (typeof input === 'object' && input !== null && 'conversation' in input) {
    // Shallow on purpose: the `Conversation` constructor validates the history
    // in full when the run starts. This only refuses a value that cannot be one.
    const { conversation } = input;
    if (typeof conversation !== 'object' || conversation === null || Array.isArray(conversation)) {
      throw new AgentContractError('Agent input { conversation } must hold a ConversationHistory');
    }
    return;
  }
  throw new AgentContractError(
    'Agent input must be a string, an array of content parts, or { conversation }',
  );
}

function assertPartList(parts: readonly unknown[]): void {
  if (parts.length === 0) {
    throw new AgentContractError('Agent input must not be an empty list of content parts');
  }
  parts.forEach((candidate, index) => {
    const parsed = multiModalContentSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new AgentContractError(`Agent input part ${index} is not valid content`, parsed.error);
    }
    const part = parsed.data;
    const admissible =
      isMediaContent(part) || (part.type === 'text' && part.citations === undefined);
    if (!admissible) {
      throw new AgentContractError(
        `Agent input part ${index} (${part.type}) is not user-admissible content`,
      );
    }
  });
}

/**
 * Snapshots an input synchronously, so a later mutation of the caller's object
 * cannot reach a run that has already been requested.
 */
export function snapshotAgentInput(input: AgentInput): AgentInput {
  if (typeof input === 'string') return input;
  if (isConversationInput(input)) return { conversation: structuredClone(input.conversation) };
  return structuredClone(input);
}

/** Snapshots a session payload: a string is immutable, a part array is cloned. */
export function snapshotPayload(input: SessionInputPayload): SessionInputPayload {
  return typeof input === 'string' ? input : structuredClone(input);
}

/** Appends a payload to a conversation as exactly one `user` message, parts in order. */
export function appendAgentInput(conversation: Conversation, input: SessionInputPayload): void {
  if (typeof input === 'string') {
    conversation.appendUserMessage(input);
    return;
  }
  const parts: MultiModalContent[] = input.map((part): MultiModalContent =>
    part.type === 'text' ? { type: 'text', text: part.text } : structuredClone(part),
  );
  conversation.appendUserMessage(parts);
}
