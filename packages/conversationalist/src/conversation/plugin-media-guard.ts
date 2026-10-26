import { createInvalidInputError } from '../errors';
import type { MediaContent, ToolResultPart } from '../multi-modal';
import type { ToolResult } from '../types';

/**
 * COR-1634: what a conversation plugin may not change about a tool result's media.
 *
 * A host admits a tool result's media (as managed assets, or as references it authorizes on every
 * read) before the row is appended, and the plugins run after. A plugin that swapped a source for a
 * URL, added a part, or relabeled a media type would put media into the row that nothing admitted.
 * So a plugin may rewrite a result's text parts and a media part's descriptive fields (name, alt,
 * caption, transcript, extracted text, metadata), and the body of an inline or data-URL source (the
 * PII plugin redacts one), but the media parts themselves stay: the same count and order, each
 * with the same type and media type, and each source of the same kind, a locator unchanged.
 */
function mediaParts(toolResult: ToolResult | undefined): MediaContent[] {
  return (toolResult?.parts ?? []).filter(
    (part: ToolResultPart): part is MediaContent => part.type !== 'text',
  );
}

function sameSource(before: MediaContent['source'], after: MediaContent['source']): boolean {
  if (before.kind !== after.kind) return false;
  // The body of an inline or data-URL source is the part's content, which redaction rewrites;
  // every other kind names bytes elsewhere, and where it names is what admission governed.
  if (before.kind === 'inline' || before.kind === 'data-url') return true;
  return sameValue(before, after);
}

/** Structural equality of two JSON values, independent of object key order. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    );
  }
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  );
}

function problem(
  before: readonly MediaContent[],
  after: readonly MediaContent[],
): string | undefined {
  if (before.length !== after.length) {
    return `it changed the number of media parts from ${before.length} to ${after.length}`;
  }
  for (const [index, kept] of before.entries()) {
    const next = after[index]!;
    if (kept.type !== next.type)
      return `it changed media part ${index} from ${kept.type} to ${next.type}`;
    if (kept.mimeType !== next.mimeType) return `it changed the media type of part ${index}`;
    if (!sameSource(kept.source, next.source)) return `it changed the source of part ${index}`;
  }
  return undefined;
}

/**
 * Throws when a plugin changed the media of a tool result between `before` and `after` (see the
 * rules above). Inputs that are not tool results are not checked.
 */
export function assertPluginsKeptToolResultMedia(
  before: { readonly role: string; readonly toolResult?: ToolResult | undefined },
  after: { readonly role: string; readonly toolResult?: ToolResult | undefined },
): void {
  if (before.role !== 'tool-result' || before.toolResult === undefined) return;
  const reason = problem(mediaParts(before.toolResult), mediaParts(after.toolResult));
  if (reason !== undefined) {
    throw createInvalidInputError(
      `A conversation plugin changed the media of a tool result: ${reason}. A plugin may rewrite text and descriptive fields, not the media itself.`,
      { callId: before.toolResult.callId },
    );
  }
}
