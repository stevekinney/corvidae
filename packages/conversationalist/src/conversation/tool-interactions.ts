import {
  materializeToolCall,
  materializeToolCalls,
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResults,
  materializeToolResultsAsync,
} from 'armorer/protocol';

import {
  type ConversationEnvironment,
  isConversationEnvironmentParameter,
  resolveConversationEnvironment,
} from '../environment';
import { createInvalidInputError } from '../errors';
import type {
  AppendableToolCallInput,
  AppendableToolResult,
  ConversationHistory as Conversation,
  JSONValue,
  MessageInput,
  TokenUsage,
  ToolCall,
  ToolResult,
} from '../types';
import { getOrderedMessages } from '../utilities/message-store';
import { pairToolCallsWithResults } from '../utilities/tool-calls';
import { appendMessages, withMessageId } from './append';
export {
  materializeToolCall,
  materializeToolCalls,
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResults,
  materializeToolResultsAsync,
} from 'armorer/protocol';
export type { MaterializeToolCallOptions } from 'armorer/protocol';

export interface AppendToolCallOptions {
  /** The id the row is committed under, instead of a minted one; plugins still run over it. */
  messageId?: string;
  content?: MessageInput['content'];
  metadata?: Record<string, JSONValue>;
  hidden?: boolean;
  tokenUsage?: TokenUsage;
}

export interface AppendToolResultOptions {
  content?: MessageInput['content'];
  metadata?: Record<string, JSONValue>;
  hidden?: boolean;
  tokenUsage?: TokenUsage;
  signal?: AbortSignal;
}

/**
 * Row ids for a batch append. `messageIds[i]` becomes the id of the i-th row,
 * in input order, instead of a minted one. The array must be exactly as long as
 * the batch, and every id must be new to the conversation.
 */
export interface AppendBatchOptions {
  readonly messageIds?: ReadonlyArray<string> | undefined;
}

export interface ToolInteraction {
  call: ToolCall;
  result?: ToolResult | undefined;
}

/**
 * Appends a tool-call message with the provided tool call metadata.
 */
export function appendToolCall(
  conversation: Conversation,
  toolCall: AppendableToolCallInput,
  options?: AppendToolCallOptions,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedEnvironment = resolveConversationEnvironment(
    isConversationEnvironmentParameter(options) ? options : environment,
  );
  const resolvedOptions = isConversationEnvironmentParameter(options) ? undefined : options;

  return appendMessages(
    conversation,
    withBatchMessageId(
      createToolCallMessageInput(
        materializeToolCall(toolCall, {
          generateId: resolvedEnvironment.randomId,
        }),
        resolvedOptions,
      ),
      resolvedOptions?.messageId,
    ),
    resolvedEnvironment,
  );
}

/**
 * Appends multiple tool-call messages in order.
 */
export function appendToolCalls(
  conversation: Conversation,
  toolCalls: ReadonlyArray<AppendableToolCallInput>,
  environment?: Partial<ConversationEnvironment>,
  batch?: AppendBatchOptions,
): Conversation {
  if (toolCalls.length === 0) {
    return conversation;
  }
  const messageIds = requireBatchMessageIds(batch, toolCalls.length, 'appendToolCalls');

  const resolvedEnvironment = resolveConversationEnvironment(environment);
  const messageInputs = materializeToolCalls(toolCalls, {
    generateId: resolvedEnvironment.randomId,
  }).map((toolCall, index) =>
    withBatchMessageId(createToolCallMessageInput(toolCall, undefined), messageIds?.[index]),
  );

  return appendMessages(conversation, ...messageInputs, resolvedEnvironment);
}

/**
 * Appends a tool-result message with the provided tool result metadata.
 */
export function appendToolResult(
  conversation: Conversation,
  toolResult: AppendableToolResult,
  options?: AppendToolResultOptions,
  environment?: Partial<ConversationEnvironment>,
): Conversation {
  const resolvedOptions = isConversationEnvironmentParameter(options) ? undefined : options;
  const normalizedToolResult = materializeToolResult(toolResult);

  return appendMessages(
    conversation,
    createToolResultMessageInput(normalizedToolResult, resolvedOptions),
    isConversationEnvironmentParameter(options) ? options : environment,
  );
}

/**
 * Appends multiple tool-result messages in order.
 */
export function appendToolResults(
  conversation: Conversation,
  toolResults: ReadonlyArray<AppendableToolResult>,
  environment?: Partial<ConversationEnvironment>,
  batch?: AppendBatchOptions,
): Conversation {
  if (toolResults.length === 0) {
    return conversation;
  }
  const messageIds = requireBatchMessageIds(batch, toolResults.length, 'appendToolResults');

  const messageInputs = materializeToolResults(toolResults).map((toolResult, index) =>
    withBatchMessageId(createToolResultMessageInput(toolResult, undefined), messageIds?.[index]),
  );

  return appendMessages(conversation, ...messageInputs, environment);
}

/**
 * Appends a tool-result message, collecting streaming payloads before the history changes.
 */
export async function appendToolResultAsync(
  conversation: Conversation,
  toolResult: AppendableToolResult,
  options?: AppendToolResultOptions,
  environment?: Partial<ConversationEnvironment>,
): Promise<Conversation> {
  const resolvedOptions = isConversationEnvironmentParameter(options) ? undefined : options;
  const normalizedToolResult = await materializeToolResultAsync(toolResult, {
    signal: resolvedOptions?.signal,
  });

  return appendMessages(
    conversation,
    createToolResultMessageInput(normalizedToolResult, resolvedOptions),
    isConversationEnvironmentParameter(options) ? options : environment,
  );
}

/**
 * Appends multiple tool-result messages, collecting streaming payloads before the history changes.
 */
export async function appendToolResultsAsync(
  conversation: Conversation,
  toolResults: ReadonlyArray<AppendableToolResult>,
  environment?: Partial<ConversationEnvironment>,
  signal?: AbortSignal,
  batch?: AppendBatchOptions,
): Promise<Conversation> {
  if (toolResults.length === 0) {
    return conversation;
  }
  const messageIds = requireBatchMessageIds(batch, toolResults.length, 'appendToolResultsAsync');

  const normalizedToolResults = await materializeToolResultsAsync(toolResults, { signal });

  const messageInputs = normalizedToolResults.map((toolResult, index) =>
    withBatchMessageId(createToolResultMessageInput(toolResult, undefined), messageIds?.[index]),
  );

  return appendMessages(conversation, ...messageInputs, environment);
}

/**
 * Returns tool calls that have no corresponding tool result yet.
 */
export function getPendingToolCalls(conversation: Conversation): ToolCall[] {
  const orderedMessages = getOrderedMessages(conversation);
  const completedCallIdentifiers = new Set<string>();

  for (const message of orderedMessages) {
    if (message.role === 'tool-result' && message.toolResult) {
      completedCallIdentifiers.add(message.toolResult.callId);
    }
  }

  const pendingToolCalls: ToolCall[] = [];
  for (const message of orderedMessages) {
    if (message.role === 'tool-call' && message.toolCall) {
      if (!completedCallIdentifiers.has(message.toolCall.id)) {
        pendingToolCalls.push(message.toolCall);
      }
    }
  }

  return pendingToolCalls;
}

/**
 * Returns tool calls paired with their optional results in message order.
 */
export function getToolInteractions(conversation: Conversation): ToolInteraction[] {
  return pairToolCallsWithResults(getOrderedMessages(conversation));
}

function requireBatchMessageIds(
  batch: AppendBatchOptions | undefined,
  count: number,
  operation: string,
): ReadonlyArray<string> | undefined {
  const messageIds = batch?.messageIds;
  if (messageIds === undefined) return undefined;
  if (messageIds.length !== count) {
    throw createInvalidInputError(
      `${operation} received ${messageIds.length} messageIds for ${count} rows`,
    );
  }
  return messageIds;
}

/** An input carrying an explicit row id; conversation plugins still run over it. */
function withBatchMessageId(input: MessageInput, id: string | undefined): MessageInput {
  return id === undefined ? input : withMessageId(input, id);
}

function createToolCallMessageInput(
  toolCall: ToolCall,
  options?: AppendToolCallOptions,
): MessageInput {
  return {
    role: 'tool-call',
    content: options?.content ?? '',
    metadata: options?.metadata,
    hidden: options?.hidden,
    toolCall,
    tokenUsage: options?.tokenUsage,
  };
}

function createToolResultMessageInput(
  toolResult: ToolResult,
  options?: AppendToolResultOptions,
): MessageInput {
  return {
    role: 'tool-result',
    content: options?.content ?? '',
    metadata: options?.metadata,
    hidden: options?.hidden,
    toolResult,
    tokenUsage: options?.tokenUsage,
  };
}
