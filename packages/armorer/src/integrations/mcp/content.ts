import { isSpecType, type CallToolResult, type ContentBlock } from '@modelcontextprotocol/server';

import {
  assertToolResultParts,
  isToolContent,
  toolContent,
  ToolResultError,
  type JSONObject,
} from '../../protocol';
import type { ToolResultLike } from '../../types';
import { mcpBlocksToParts, partsToMcpBlocks } from './parts';

/**
 * Maps Armorer tool results to MCP `CallToolResult`s (server direction) and
 * MCP results back to tool values (client direction).
 *
 * Both directions keep MCP content blocks — text, image, audio, embedded
 * resource, resource link — in their protocol order. A tool that returns
 * parts (`toolContent`) or blocks has them sent as blocks, never serialized
 * into a text block that merely looks like JSON; a remote result that carries
 * non-text blocks reaches the Armorer caller as ordered tool-result parts.
 */

type CallToolResultShape = {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

const CALL_TOOL_RESULT_KEYS = new Set(['content', 'structuredContent', 'isError', '_meta']);

/** Reports whether `value` is a non-empty array of valid MCP content blocks. */
export function isContentBlockArray(value: unknown): value is ContentBlock[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((block) => isSpecType.ContentBlock(block))
  );
}

/**
 * Reports whether `value` is already a `CallToolResult`-shaped object: a
 * `content` array of valid blocks plus only the result's own optional keys.
 * This is what {@link parseMcpCallResult} hands back for a mixed result that
 * also carries structured content, so re-exposing that value over MCP keeps
 * both parts intact.
 */
function isCallToolResultShape(value: unknown): value is CallToolResultShape {
  if (!isRecord(value) || !Array.isArray(value['content'])) return false;
  if (!Object.keys(value).every((key) => CALL_TOOL_RESULT_KEYS.has(key))) return false;
  const content: unknown[] = value['content'];
  if (!content.every((block) => isSpecType.ContentBlock(block))) return false;
  const structured = value['structuredContent'];
  if (structured !== undefined && !isRecord(structured)) return false;
  const meta = value['_meta'];
  if (meta !== undefined && !isRecord(meta)) return false;
  const isError = value['isError'];
  return isError === undefined || typeof isError === 'boolean';
}

/** Converts an Armorer tool result into an MCP `CallToolResult` (server direction). */
export function toCallToolResult(result: ToolResultLike): CallToolResult {
  if (result.outcome === 'error') {
    // An error that carries parts sends them, in order, flagged as an error.
    if (result.parts !== undefined) {
      assertToolResultParts(result.parts);
      const structured = toStructuredContent(result.content);
      return {
        content: partsToMcpBlocks(result.parts),
        ...(structured === undefined ? {} : { structuredContent: structured }),
        isError: true,
      };
    }
    const message = result.error?.message ?? stringifyResult(result.content);
    return { content: toTextContent(message), isError: true };
  }

  // A materialized or persisted result carries its parts on `parts`, not inside a raw value.
  if (result.parts !== undefined && !isToolContent(getExecutionValue(result))) {
    assertToolResultParts(result.parts);
    const structured = toStructuredContent(result.content);
    return {
      content: partsToMcpBlocks(result.parts),
      ...(structured === undefined ? {} : { structuredContent: structured }),
    };
  }
  const executionValue = getExecutionValue(result);
  if (isToolContent(executionValue)) {
    const structured = toStructuredContent(executionValue.value);
    return {
      content: partsToMcpBlocks(executionValue.parts),
      ...(structured === undefined ? {} : { structuredContent: structured }),
    };
  }
  if (isContentBlockArray(executionValue)) {
    return { content: [...executionValue] };
  }
  if (isCallToolResultShape(executionValue)) {
    return {
      content: [...executionValue.content],
      ...(executionValue.structuredContent !== undefined
        ? { structuredContent: executionValue.structuredContent }
        : {}),
      ...(executionValue.isError !== undefined ? { isError: executionValue.isError } : {}),
      ...(executionValue._meta !== undefined ? { _meta: executionValue._meta } : {}),
    };
  }

  const content = toTextContent(stringifyResult(executionValue));
  const structured = toStructuredContent(executionValue);
  return structured ? { content, structuredContent: structured } : { content };
}

/**
 * Converts an MCP `CallToolResult` into the value an Armorer tool returns
 * (client direction).
 *
 * - An error result throws with its text. When it also holds a non-text
 *   block, the throw is a {@link ToolResultError} carrying every block as an
 *   ordered part, so the failure keeps its images and resources.
 * - A result with any non-text block returns `toolContent`: every block as an
 *   ordered tool-result part, with `structuredContent` (when the server sent
 *   it) as the value beside them. A `resource_link` becomes an
 *   `mcp-resource` reference to `options.serverId`.
 * - A text-only result with `structuredContent` returns the structured value
 *   (the text is its mirror).
 * - Otherwise text blocks are returned as text, parsed as JSON when they
 *   hold JSON (the inverse of the server direction's text mirror).
 */
export function parseMcpCallResult(
  result: CallToolResult,
  options: { serverId?: string | undefined } = {},
): unknown {
  const content: ContentBlock[] = Array.isArray(result.content) ? result.content : [];
  const hasNonTextBlock = content.some((block) => !isTextContentBlock(block));
  if (result.isError) {
    throw hasNonTextBlock
      ? errorWithParts(result, content, options.serverId)
      : new Error(extractMcpErrorMessage(result));
  }
  if (hasNonTextBlock) {
    const parts = mcpBlocksToParts(content, options.serverId);
    return result.structuredContent === undefined
      ? toolContent(parts)
      : toolContent(parts, { value: result.structuredContent as JSONObject });
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  if (!content.length) {
    return undefined;
  }
  const textBlocks = content.filter(isTextContentBlock);
  const [first] = textBlocks;
  if (textBlocks.length === 1 && first) {
    return parseTextContent(first.text);
  }
  return textBlocks.map((block) => parseTextContent(block.text));
}

export function toTextContent(text: string): CallToolResult['content'] {
  if (!text.length) return [];
  return [{ type: 'text' as const, text }];
}

/**
 * An error result's blocks as a {@link ToolResultError}. A block that cannot become a part (a
 * `resource_link` without a `serverId`) leaves the plain text error: the failure is still reported.
 */
function errorWithParts(
  result: CallToolResult,
  content: ContentBlock[],
  serverId: string | undefined,
): Error {
  const message = extractMcpErrorMessage(result);
  try {
    const parts = mcpBlocksToParts(content, serverId);
    return new ToolResultError(
      message,
      result.structuredContent === undefined
        ? toolContent(parts)
        : toolContent(parts, { value: result.structuredContent as JSONObject }),
    );
  } catch {
    return new Error(message);
  }
}

function extractMcpErrorMessage(result: CallToolResult): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter(isTextContentBlock)
    .map((block) => block.text)
    .join('\n');
  return text.trim().length ? text : 'MCP tool call failed.';
}

function parseTextContent(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isTextContentBlock(value: unknown): value is { type: 'text'; text: string } {
  return isRecord(value) && value['type'] === 'text' && typeof value['text'] === 'string';
}

function stringifyResult(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}

function getExecutionValue(result: ToolResultLike): unknown {
  if ('result' in result) {
    return result.result;
  }
  return result.content;
}

function toStructuredContent(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
