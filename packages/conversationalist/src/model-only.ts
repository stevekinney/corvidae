import type { Message } from './types';

/**
 * The metadata key of a message the model is sent and people are never shown (COR-2437): an
 * instruction the product writes into the conversation, such as the turn that asks a stopped
 * answer to go on. Unlike `hidden`, which keeps a row from the model too, such a row is part of
 * every request to the model, and every view for people (a chat's transcript, its title and
 * preview, an export, a memory or a skill drawn from what the person said) leaves it out.
 */
export const MODEL_ONLY_METADATA_KEY = 'conversationalist:modelOnly';

/** Whether `message` is sent to the model and never shown to people. */
export function isModelOnlyMessage(message: Pick<Message, 'metadata'>): boolean {
  return message.metadata[MODEL_ONLY_METADATA_KEY] === true;
}
