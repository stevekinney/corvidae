import { createInvalidInputError } from '../errors';
import { readMediaBody } from '../media-body';
import { splitDataUrl } from '../media-types';
import type { MediaContent, ToolResultPart } from '../multi-modal';
import type { MessageInput, MessagePlugin, ToolResult } from '../types';

/**
 * COR-1634: what a conversation plugin may not change about a tool result's media.
 *
 * A host admits a tool result's media (as managed assets, or as references it authorizes on every
 * read) before the row is appended, and the plugins run after. A plugin that swapped a source for a
 * URL, added a part, or relabeled a media type would put media into the row that nothing admitted.
 * So a plugin may rewrite a result's text parts and a media part's descriptive fields (name, alt,
 * caption, transcript, extracted text, metadata), and the text body of an inline or data-URL
 * source, as the PII plugin redacts one. The media itself stays: the same count and order, each
 * part with the same type and media type, and each source exactly as it was, except that a source
 * whose body is text (readable as characters by {@link readMediaBody}) may have that text changed
 * while its kind, encoding, and data-URL header stay the same. A binary body is never rewritten.
 *
 * Every place that runs plugins goes through {@link runMessagePlugins}, so a path added later
 * cannot run them without the guard.
 */
interface IndexedMedia {
  readonly part: MediaContent;
  /** The part's position in the tool result's own `parts`, which is what an error names. */
  readonly index: number;
}

function mediaParts(toolResult: ToolResult | undefined): IndexedMedia[] {
  return (toolResult?.parts ?? []).flatMap((part: ToolResultPart, index) =>
    part.type === 'text' ? [] : [{ part, index }],
  );
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

/** Whether the source is untouched, or is a text body rewritten in the form it was stored in. */
function sameSource(before: MediaContent, after: MediaContent): boolean {
  if (sameValue(before.source, after.source)) return true;
  if (readMediaBody(before).status !== 'text') return false;
  const { source: from } = before;
  const { source: to } = after;
  if (from.kind === 'inline' && to.kind === 'inline') return from.encoding === to.encoding;
  if (from.kind === 'data-url' && to.kind === 'data-url') {
    return splitDataUrl(from.url)?.header === splitDataUrl(to.url)?.header;
  }
  return false;
}

function problem(
  before: readonly IndexedMedia[],
  after: readonly IndexedMedia[],
): string | undefined {
  if (before.length !== after.length) {
    return `it changed the number of media parts from ${before.length} to ${after.length}`;
  }
  for (const [position, kept] of before.entries()) {
    const next = after[position]!;
    const { index } = kept;
    if (kept.part.type !== next.part.type) {
      return `it changed part ${index} from ${kept.part.type} to ${next.part.type}`;
    }
    if (kept.part.mimeType !== next.part.mimeType) {
      return `it changed the media type of part ${index}`;
    }
    if (!sameSource(kept.part, next.part)) return `it changed the source of part ${index}`;
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

/**
 * Runs the environment's plugins over `input` and checks that they kept a tool result's media.
 * The only way the package runs plugins.
 */
export function runMessagePlugins(
  input: MessageInput,
  plugins: readonly MessagePlugin[],
): MessageInput {
  const processed = plugins.reduce((current, plugin) => plugin(current), input);
  assertPluginsKeptToolResultMedia(input, processed);
  return processed;
}
