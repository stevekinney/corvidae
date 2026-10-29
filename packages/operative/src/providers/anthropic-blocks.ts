import type { BlockAccumulatorState, JSONValue, MultiModalContent } from 'conversationalist';

import type { AnthropicMessageResponse } from './anthropic-types.ts';
import { ProviderContractError } from './errors.ts';
import type { GenerateResponse } from './types.ts';

type AnthropicBlock = AnthropicMessageResponse['content'][number];

/**
 * The server-tool result block types Anthropic returns, each a content part of the same `type`
 * carrying `tool_use_id` and an opaque `content`. `tool_search_tool_result` is deliberately absent:
 * the request never enables that tool, so reaching one is a contract error, not a part.
 */
const SERVER_TOOL_RESULT_TYPES: ReadonlySet<string> = new Set([
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
]);

/** Block types a stream may open that carry no model output. */
export const ANTHROPIC_CONTROL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'message_start',
  'message_delta',
  'message_stop',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'ping',
]);

/** True for a block type the adapter maps to a content part (not a client tool call). */
export function isAnthropicPartBlock(type: string): boolean {
  return (
    type === 'text' ||
    type === 'thinking' ||
    type === 'redacted_thinking' ||
    type === 'server_tool_use' ||
    type === 'container_upload' ||
    SERVER_TOOL_RESULT_TYPES.has(type)
  );
}

/**
 * Maps one Anthropic response block to a content part. Returns `undefined` for a block that is not
 * a part (a client `tool_use`, which becomes a tool call, or an empty text block, which Anthropic
 * would reject on replay). Anything the mapping table does not list throws a
 * {@link ProviderContractError}; the caller supplies the block's position and the response's usage.
 */
export function anthropicPartFromBlock(
  block: AnthropicBlock,
  context: { readonly position: number; readonly usage: GenerateResponse['usage'] },
): MultiModalContent | undefined {
  switch (block.type) {
    case 'text': {
      if (!block.text) return undefined;
      return Array.isArray(block.citations)
        ? { type: 'text', text: block.text, citations: block.citations as JSONValue }
        : { type: 'text', text: block.text };
    }
    case 'thinking':
      return { type: 'thinking', thinking: block.thinking ?? '', signature: block.signature ?? '' };
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: block.data ?? '' };
    case 'tool_use':
      return undefined;
    case 'server_tool_use':
      return {
        type: 'server_tool_use',
        id: block.id ?? '',
        name: block.name ?? '',
        input: (block.input ?? {}) as JSONValue,
      };
    case 'container_upload':
      return { type: 'container_upload', file_id: block.file_id ?? '' };
    default:
      if (SERVER_TOOL_RESULT_TYPES.has(block.type)) {
        return {
          type: block.type as 'web_search_tool_result',
          tool_use_id: block.tool_use_id ?? '',
          content: (block.content ?? null) as JSONValue,
        };
      }
      throw new ProviderContractError({
        provider: 'anthropic',
        reason: 'unlisted-block',
        blockType: block.type,
        partIndex: context.position,
        usage: context.usage,
      });
  }
}

/** Maps a response's blocks to its ordered parts, throwing on the first block outside the table. */
export function anthropicPartsFromBlocks(
  blocks: AnthropicMessageResponse['content'],
  usage: GenerateResponse['usage'],
): MultiModalContent[] {
  const parts: MultiModalContent[] = [];
  for (const [position, block] of blocks.entries()) {
    const part = anthropicPartFromBlock(block, { position, usage });
    if (part !== undefined) parts.push(part);
  }
  return parts;
}

/** The accumulator state a block opens with, or `undefined` for a block that is not a content part. */
export function anthropicOpeningState(
  block: NonNullable<import('./anthropic-types.ts').AnthropicStreamEvent['content_block']>,
): BlockAccumulatorState | undefined {
  switch (block.type) {
    case 'text':
      return { type: 'text', buffer: block.text ?? '' };
    case 'thinking':
      return { type: 'thinking', buffer: block.thinking ?? '', signature: block.signature ?? '' };
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: block.data ?? '' };
    case 'server_tool_use':
      return {
        type: 'server_tool_use',
        id: block.id ?? '',
        name: block.name ?? '',
        inputBuffer: '',
      };
    case 'container_upload':
      return { type: 'container_upload', file_id: block.file_id ?? '' };
    case 'web_search_tool_result':
      return {
        type: 'web_search_tool_result',
        tool_use_id: block.tool_use_id ?? '',
        content: (block.content ?? null) as JSONValue,
      };
    case 'web_fetch_tool_result':
    case 'code_execution_tool_result':
    case 'bash_code_execution_tool_result':
    case 'text_editor_code_execution_tool_result':
      return {
        type: block.type,
        tool_use_id: block.tool_use_id ?? '',
        content: (block.content ?? null) as JSONValue,
      };
    default:
      return undefined;
  }
}
