import { createConversationHistory } from '../components/chat/builders.ts';
import type { ConversationHistory } from '../components/chat/conversation-model.ts';
import { mapAGUIEventsToChatStream } from './ag-ui-transport.ts';
import { guardChatStreamEvents, type ChatStreamEvent } from './stream-event-codec.ts';

export const thread = { threadId: 'thread-1', runId: 'run-1' };
export const runStarted = { type: 'RUN_STARTED', ...thread };
export const runFinished = { type: 'RUN_FINISHED', ...thread };

export function emptyConversation(): ConversationHistory {
  return createConversationHistory({ id: 'ag-ui' });
}

/**
 * Maps events to frames, as the controller would receive them: through the
 * stream guard, so every test that reads frames also proves they are valid on
 * the wire (opening, identity, ordering, and terminal rules included).
 */
export async function frames(
  events: unknown[],
  conversation: ConversationHistory = emptyConversation(),
): Promise<ChatStreamEvent[]> {
  return Array.fromAsync(
    guardChatStreamEvents(mapAGUIEventsToChatStream(events, { conversation })),
  );
}

/** Runs a stream that must fail, and returns what it failed with. */
export async function failure(events: unknown[]): Promise<unknown> {
  try {
    await frames(events);
  } catch (error) {
    return error;
  }
  throw new Error('Expected the stream to fail');
}

/** A frame without the envelope the mapper stamps, so tests compare the body. */
export function body(frame: ChatStreamEvent): Record<string, unknown> {
  const { wireVersion: _wireVersion, sequence: _sequence, ...rest } = frame;
  return rest;
}

/** Every frame's body, from `RUN_STARTED` through the terminal. */
export async function bodies(
  events: unknown[],
  conversation?: ConversationHistory,
): Promise<Record<string, unknown>[]> {
  const all = await frames(events, conversation);
  return all.map(body);
}

/** The terminal conversation's `[role, content]` pairs. */
export function transcript(conversation: ConversationHistory): Array<[string, unknown]> {
  return conversation.ids.map((id): [string, unknown] => {
    const message = conversation.messages[id];
    return [message?.role ?? 'missing', message?.content];
  });
}

export function completedConversation(all: ChatStreamEvent[]): ConversationHistory {
  const terminal = all.at(-1);
  if (terminal?.type !== 'run.completed') throw new Error('Expected run.completed');
  return terminal.conversation;
}

/**
 * Frames reduced to what is deterministic: bodies, with the terminal's
 * conversation replaced by its transcript, because rows get fresh identifiers
 * and timestamps every time they are assembled.
 */
export function shape(all: ChatStreamEvent[]): Record<string, unknown>[] {
  return all.map((frame) =>
    frame.type === 'run.completed'
      ? { ...body(frame), conversation: transcript(frame.conversation) }
      : body(frame),
  );
}
