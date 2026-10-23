import type { ContentPart, ToolMessage } from '@ag-ui/core';
import { ContentPartSchema } from '@ag-ui/core/schemas';
import type { JSONValue, ToolResult } from '../../types';
import {
  fromCanonicalToolResultPayload,
  isCanonicalToolResultPayload,
  toJSONValue,
} from '../shared';

/**
 * Where a tool message carries the exact `ToolResult` it was written from.
 *
 * A `tool` message has a text body and an optional `error` string, which is
 * not enough to tell a success whose content is a string that looks like JSON
 * from a result that was serialized, or a success object shaped like a failure
 * from a failure. So export writes the structured result here whenever the
 * body and `error` would not recover it, and import trusts nothing else: a
 * body is only ever text or parts, and a result from any other AG-UI backend
 * is a success whose content is that body, or a failure when `error` is set.
 */
export const TOOL_RESULT_METADATA_KEY = 'conversationalist:toolResult';

function isContentPartArray(value: unknown): value is ContentPart[] {
  return ContentPartSchema.array().safeParse(value).success;
}

/**
 * The tool message for a result. A result whose content is AG-UI parts that
 * include media travels as those parts; anything else travels as text, with
 * the structured result in metadata whenever the text and `error` would not
 * recover it.
 */
export function toAGUIToolMessage(
  id: string,
  result: Readonly<ToolResult>,
  metadata: Record<string, unknown>,
): ToolMessage {
  const parts = isContentPartArray(result.content) ? result.content : undefined;
  const hasMedia = parts?.some((part) => part.type !== 'text') === true;
  const content = hasMedia && parts !== undefined ? parts : textOf(result.content);
  const plain =
    result.outcome === 'success' &&
    !hasExtras(result) &&
    (typeof result.content === 'string' || hasMedia);
  const { content: _content, callId: _callId, ...structured } = result;
  return {
    id,
    role: 'tool',
    toolCallId: result.callId,
    content,
    ...(result.error ? { error: result.error.message } : {}),
    ...(plain
      ? Object.keys(metadata).length > 0
        ? { metadata }
        : {}
      : {
          metadata: {
            ...metadata,
            [TOOL_RESULT_METADATA_KEY]: { ...structured, content: result.content },
          },
        }),
  };
}

function hasExtras(result: Readonly<ToolResult>): boolean {
  return (
    result.parts !== undefined ||
    result.error !== undefined ||
    result.action !== undefined ||
    result.inputDigest !== undefined ||
    result.outputDigest !== undefined ||
    result.providerCallId !== undefined
  );
}

function textOf(content: JSONValue): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/**
 * Converts one AG-UI `tool` message to the tool result it carries; the inverse
 * of how {@link toAGUIMessages} writes a result.
 *
 * A message this adapter wrote carries its structured result in metadata and
 * gets exactly that result back. Any other message is a success whose content
 * is its text, never re-parsed as JSON, or, when it carries media, the JSON of
 * its parts; and it is a failure when its `error` field is set.
 */
export function fromAGUIToolMessage(message: ToolMessage): ToolResult {
  const embedded = readEmbeddedResult(message);
  if (embedded !== undefined) return embedded;
  const content = fromBody(message.content);
  if (message.error === undefined)
    return { callId: message.toolCallId, outcome: 'success', content };
  return {
    callId: message.toolCallId,
    outcome: 'error',
    content,
    error: {
      code: 'ag-ui.tool-error',
      category: 'internal',
      retryable: false,
      message: message.error,
    },
  };
}

function readEmbeddedResult(message: ToolMessage): ToolResult | undefined {
  const embedded = toJSONValue(message.metadata?.[TOOL_RESULT_METADATA_KEY]);
  return isCanonicalToolResultPayload(embedded)
    ? fromCanonicalToolResultPayload(message.toolCallId, embedded)
    : undefined;
}

function fromBody(content: ToolMessage['content']): JSONValue {
  if (typeof content === 'string') return content;
  if (content.every((part) => part.type === 'text'))
    return content.map((part) => (part.type === 'text' ? part.text : '')).join('\n\n');
  return toJSONValue(content);
}

/** Metadata for a tool-result row: the message's own, without the embedded result. */
export function withoutEmbeddedResult(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  const { [TOOL_RESULT_METADATA_KEY]: _embedded, ...rest } = metadata;
  return rest;
}
