import type { ChatAdapter, ChatToolResult } from '../components/chat/adapter/chat-adapter.ts';
import { removeMessage } from '../components/chat/builders.ts';
import type { ConversationHistory, ToolResult } from '../components/chat/conversation-model.ts';
import type { ChatAttachment } from '../components/chat/input/chat-attachment.ts';
import {
  decodeChatStreamEvents,
  guardChatStreamEvents,
  type ChatSerializedRunError,
  type ChatStreamEvent,
} from './stream-event-codec.ts';

/** Error raised when a transport emits a terminal `run.error` or `run.tripwire` frame. */
export class ChatRunFailureError extends Error {
  readonly runError: ChatSerializedRunError;

  constructor(runError: ChatSerializedRunError) {
    super(runError.message);
    this.name = 'ChatRunFailureError';
    this.runError = runError;
  }
}

/** Context supplied to each transport turn. */
export type ChatSessionRequest = {
  conversation: ConversationHistory;
  signal: AbortSignal;
  turn: number;
  attachments: ChatAttachment[];
};
/** Supported transport return values, decoded lazily by the controller. */
export type ChatSessionTransportResult =
  AsyncIterable<ChatStreamEvent> | ReadableStream<Uint8Array> | Response;
/** Produces a stream for one controller turn. */
export type ChatSessionTransport = (
  request: ChatSessionRequest,
) => ChatSessionTransportResult | Promise<ChatSessionTransportResult>;
/** Optional observers and approval handlers for controller lifecycle events. */
export type ChatSessionHooks = {
  onToolResult?: (result: ChatToolResult) => void;
  approveToolCall?: (toolCallId: string) => Promise<ToolResult | undefined>;
  denyToolCall?: (toolCallId: string) => Promise<ToolResult | undefined>;
  onError?: (error: unknown) => void;
  onStreamingChange?: (streaming: boolean) => void;
};
export type ChatSessionControllerOptions = {
  transport: ChatSessionTransport;
  getConversation: () => ConversationHistory;
  setConversation: (conversation: ConversationHistory) => void;
  maxContinuationTurns?: number;
  hooks?: ChatSessionHooks;
};
export type ChatSessionController = {
  adapter: ChatAdapter;
  stop: () => Promise<void>;
  dispose: () => void;
};

export async function decodeTransportResult(
  result: ChatSessionTransportResult,
  onProtocolError: (error: unknown) => void,
): Promise<AsyncIterable<ChatStreamEvent>> {
  const decodeOptions = { onProtocolError };
  if (result instanceof Response) {
    if (!result.ok || !result.body) throw new Error(await result.text());
    return decodeChatStreamEvents(result.body, decodeOptions);
  }
  if (result instanceof ReadableStream) return decodeChatStreamEvents(result, decodeOptions);
  return guardChatStreamEvents(result, decodeOptions);
}

export function cleanIncompleteToolRows(
  history: ConversationHistory,
  userMessageId?: string,
): ConversationHistory {
  const start = userMessageId ? history.ids.indexOf(userMessageId) : -1;
  const suffix = history.ids.slice(start + 1);
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const id of suffix) {
    const message = history.messages[id];
    if (message?.role === 'tool-call' && message.toolCall) calls.add(message.toolCall.id);
    if (message?.role === 'tool-result' && message.toolResult)
      results.add(message.toolResult.callId);
  }
  const incomplete = suffix.filter((id) => {
    const message = history.messages[id];
    return (
      (message?.role === 'tool-call' && message.toolCall && !results.has(message.toolCall.id)) ||
      (message?.role === 'tool-result' &&
        message.toolResult &&
        !calls.has(message.toolResult.callId))
    );
  });
  return incomplete.toReversed().reduce((current, id) => removeMessage(current, id), history);
}

export function pruneMessageAttachments(
  history: ConversationHistory,
  attachments: Map<string, ChatAttachment[]>,
  resolvedApprovalOwners: Set<string>,
): void {
  const retainedOwners = new Set<string>();
  const callOwners = new Map<string, string>();
  let latestUserMessageId: string | undefined;
  for (const id of history.ids) {
    const message = history.messages[id];
    latestUserMessageId = recordAttachmentOwnership(
      id,
      message,
      latestUserMessageId,
      retainedOwners,
      callOwners,
    );
  }
  for (const owner of resolvedApprovalOwners) retainedOwners.add(owner);
  for (const id of attachments.keys()) {
    if (!retainedOwners.has(id)) attachments.delete(id);
  }
}

function recordAttachmentOwnership(
  id: string,
  message: ConversationHistory['messages'][string] | undefined,
  latestUserMessageId: string | undefined,
  retainedOwners: Set<string>,
  callOwners: Map<string, string>,
): string | undefined {
  if (message?.role === 'user') {
    retainedOwners.add(id);
    return id;
  }
  recordToolCallOwner(message, latestUserMessageId, callOwners);
  recordToolResultOwner(message, callOwners, retainedOwners);
  return latestUserMessageId;
}

function recordToolCallOwner(
  message: ConversationHistory['messages'][string] | undefined,
  latestUserMessageId: string | undefined,
  callOwners: Map<string, string>,
): void {
  if (message?.role === 'tool-call' && message.toolCall && latestUserMessageId)
    callOwners.set(message.toolCall.id, latestUserMessageId);
}

function recordToolResultOwner(
  message: ConversationHistory['messages'][string] | undefined,
  callOwners: Map<string, string>,
  retainedOwners: Set<string>,
): void {
  if (message?.role !== 'tool-result' || message.toolResult?.outcome !== 'action_required') return;
  const owner = callOwners.get(message.toolResult.callId);
  if (message.toolResult.action && owner) retainedOwners.add(owner);
}
