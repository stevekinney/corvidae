import { toolResultSchema } from '../schemas';
import type { JSONValue, ToolResult } from '../types';

const canonicalToolResultSchema = toolResultSchema.omit({ callId: true }).strip();

/**
 * Coerces an unknown value into a JSON-serializable value.
 */
export function toJSONValue(value: unknown): JSONValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJSONValue(item));
  }

  // `null` returned above, so this is a non-null, non-array object.
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJSONValue(entry)]),
    );
  }

  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return value.toString();
  }

  return 'undefined';
}

/**
 * Attempts to parse a JSON string, returning undefined on failure.
 */
export function parseJSONValue(value: string): JSONValue | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return toJSONValue(parsed);
  } catch {
    return undefined;
  }
}

/**
 * Converts a tool result to the string a provider message carries. A successful
 * result is its bare content; any other outcome is wrapped in the canonical
 * payload so {@link parseToolResultText} can recover the outcome.
 */
export function stringifyToolResult(result: ToolResult): string {
  const payload =
    result.outcome === 'success'
      ? result.content
      : {
          outcome: result.outcome,
          content: result.content,
          ...(result.error ? { error: result.error } : {}),
          ...(result.action ? { action: result.action } : {}),
        };

  if (typeof payload === 'string') {
    return payload;
  }
  return JSON.stringify(payload);
}

/**
 * Parses the string a provider message carries back into a tool result: the
 * inverse of {@link stringifyToolResult}. Text that is not a canonical payload
 * becomes the content of a successful result.
 */
export function parseToolResultText(callId: string, serialized: string): ToolResult {
  const parsed = parseJSONValue(serialized);

  if (parsed !== undefined && isCanonicalToolResultPayload(parsed)) {
    return fromCanonicalToolResultPayload(callId, parsed);
  }

  return {
    callId,
    outcome: 'success',
    content: parsed ?? serialized,
  };
}

/**
 * Builds a tool result from a payload {@link isCanonicalToolResultPayload}
 * accepted, keeping only the fields a result has.
 */
export function fromCanonicalToolResultPayload(
  callId: string,
  payload: JSONValue & {
    outcome: ToolResult['outcome'];
    content: JSONValue;
    error?: ToolResult['error'];
    action?: ToolResult['action'];
    inputDigest?: string;
    outputDigest?: string;
  },
): ToolResult {
  const parts = canonicalToolResultSchema.safeParse(payload).data?.parts;
  return {
    callId,
    outcome: payload.outcome,
    content: payload.content,
    ...(parts ? { parts } : {}),
    ...(payload.error ? { error: payload.error } : {}),
    ...(payload.action ? { action: payload.action } : {}),
    ...(typeof payload.inputDigest === 'string' ? { inputDigest: payload.inputDigest } : {}),
    ...(typeof payload.outputDigest === 'string' ? { outputDigest: payload.outputDigest } : {}),
  };
}

/**
 * Type guard that checks whether a JSONValue is a canonical tool-result payload
 * (i.e., an object with `outcome` and `content` fields).
 */
export function isCanonicalToolResultPayload(value: JSONValue): value is JSONValue & {
  outcome: ToolResult['outcome'];
  content: JSONValue;
  error?: ToolResult['error'];
  action?: ToolResult['action'];
  inputDigest?: string;
  outputDigest?: string;
} {
  return canonicalToolResultSchema.safeParse(value).success;
}
