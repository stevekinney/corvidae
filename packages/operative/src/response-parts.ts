import type { MediaContent, MultiModalContent } from 'conversationalist';

/**
 * Pure helpers for the ordered output parts of a model response. The loop's single
 * settle function, the row commit and the durable reconstruction all go through these,
 * so "what the parts say" is defined once.
 */

/** A media part whose bytes are still carried inline: not yet a managed asset. */
export type InlineMediaContent = MediaContent & {
  readonly source: Extract<MediaContent['source'], { kind: 'inline' }>;
};

function isMediaPart(part: MultiModalContent): part is MediaContent {
  return (
    part.type === 'image' ||
    part.type === 'audio' ||
    part.type === 'video' ||
    part.type === 'document' ||
    part.type === 'file'
  );
}

/**
 * The parts of a response that carries only `content`: one text part, or none when the
 * text is empty. This is what a hook that returns `content` without `parts` produces.
 */
export function deriveParts(content: string): readonly MultiModalContent[] {
  return content === '' ? [] : [{ type: 'text', text: content }];
}

/** The in-order concatenation of the text parts. Every other part contributes nothing. */
export function concatenateTextParts(parts: readonly MultiModalContent[]): string {
  let text = '';
  for (const part of parts) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}

/** True when `content` is exactly what the text parts concatenate to. */
export function partsMatchContent(parts: readonly MultiModalContent[], content: string): boolean {
  return concatenateTextParts(parts) === content;
}

/**
 * What a row stores for these parts. Exactly one text part without citations keeps the
 * string shorthand (that text is part 0); anything else, including a single cited text
 * part, stores the parts array, so a part's index is its position in the row's content.
 */
export function rowContentForParts(
  parts: readonly MultiModalContent[],
): string | MultiModalContent[] {
  const [only] = parts;
  if (parts.length === 1 && only?.type === 'text' && only.citations === undefined) {
    return only.text;
  }
  return [...parts];
}

/** The media parts that still carry inline bytes, with their position in `parts`. */
export function inlineMediaParts(
  parts: readonly MultiModalContent[],
): Array<{ index: number; part: InlineMediaContent }> {
  const found: Array<{ index: number; part: InlineMediaContent }> = [];
  for (const [index, part] of parts.entries()) {
    if (isMediaPart(part) && part.source.kind === 'inline') {
      found.push({ index, part: part as InlineMediaContent });
    }
  }
  return found;
}

/** True when any part is media. */
export function hasMediaPart(parts: readonly MultiModalContent[]): boolean {
  return parts.some(isMediaPart);
}

/** True when any part is something other than plain text. */
export function hasNonTextPart(parts: readonly MultiModalContent[]): boolean {
  return parts.some((part) => part.type !== 'text');
}

/**
 * The run-wide parts: every step's parts in step order, then the parts of an
 * `onMaximumSteps` replacement row when the run's final row is one. A final row that
 * is just the last step's row is already in `steps`, so it is never added twice.
 */
export function runWideParts(input: {
  readonly steps: ReadonlyArray<{ readonly parts: readonly MultiModalContent[] }>;
  readonly lastParts: readonly MultiModalContent[];
  readonly finalRowIsReplacement: boolean;
}): readonly MultiModalContent[] {
  const parts: MultiModalContent[] = [];
  for (const step of input.steps) parts.push(...step.parts);
  if (input.finalRowIsReplacement) parts.push(...input.lastParts);
  return parts;
}
