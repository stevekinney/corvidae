import { isMediaContent, multiModalContentSchema } from 'conversationalist';

import type { SessionInputPayload, UserAdmissibleContent } from './types';

/**
 * Why a media part's source cannot come from a caller, or `undefined` when it can. An
 * `mcp-resource` source names a resource on a server a tool result linked it from; Bureau reads it
 * through the host's MCP reader as the run's principal, so a caller must not choose the server and
 * URI. Only a tool result introduces one (COR-1634).
 */
export function callerSourceProblem(part: {
  readonly source?: { readonly kind: string };
}): string | undefined {
  return part.source?.kind === 'mcp-resource'
    ? 'an mcp-resource source can come only from a tool result, not from caller input'
    : undefined;
}

function parsePart(part: unknown, index: number): UserAdmissibleContent {
  // The content schema is the single definition of a valid part, so a stored
  // part is read back by the same rules that admitted it.
  const parsed = multiModalContentSchema.safeParse(part);
  if (!parsed.success) {
    throw new TypeError(
      `Session input payload part ${index} is not valid content: ${parsed.error.message}`,
      { cause: parsed.error },
    );
  }
  const content = parsed.data;
  if (isMediaContent(content)) {
    const problem = callerSourceProblem(content);
    if (problem !== undefined) {
      throw new TypeError(`Session input payload part ${index} is not admissible: ${problem}.`);
    }
    return content;
  }
  if (content.type === 'text' && content.citations === undefined) {
    return { type: 'text', text: content.text };
  }
  throw new TypeError(
    `Session input payload part ${index} has an unsupported type; only text and media are admissible.`,
  );
}

/**
 * Narrows a persisted value to a {@link SessionInputPayload}, or throws.
 *
 * A session input is stored as plain data, and whatever reads it back (an
 * untyped caller, a record written by another version) cannot be trusted to
 * match the type. A malformed value is refused where it is read rather than
 * failing a run later, inside a step. Parts are checked with the conversation
 * content schema, so every media part a run accepts is read back unchanged.
 */
export function parseSessionInputPayload(value: unknown): SessionInputPayload {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) {
    throw new TypeError('A session input payload must be a string or an array of content parts.');
  }
  if (value.length === 0) {
    throw new TypeError('A session input payload must not be an empty list of content parts.');
  }
  return value.map((part: unknown, index) => parsePart(part, index));
}

/** Whether `value` is a payload {@link parseSessionInputPayload} would read. */
export function isSessionInputPayload(value: unknown): value is SessionInputPayload {
  try {
    parseSessionInputPayload(value);
    return true;
  } catch {
    return false;
  }
}
