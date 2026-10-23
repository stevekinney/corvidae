import { clipText, type SessionInputPayload } from '@lostgradient/operative';

/** The most characters of a schedule's input that {@link scheduleInputPreview} returns. */
export const SCHEDULE_INPUT_PREVIEW_LENGTH = 500;

/**
 * The start of the text a schedule's input sends each fire, at most
 * {@link SCHEDULE_INPUT_PREVIEW_LENGTH} characters (code points, never half a surrogate pair) and
 * ending in `…` when it was cut, so a schedule can be told by what it says. The text parts of a
 * multi-part input are joined with a space; an input of media alone, or of blank text, has none and
 * answers `undefined`. It reads the input it is given, never storage, so a create answers from its
 * own request.
 */
export function scheduleInputPreview(input: SessionInputPayload): string | undefined {
  const text =
    typeof input === 'string'
      ? input
      : input.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(' ');
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const clipped = clipText(trimmed, SCHEDULE_INPUT_PREVIEW_LENGTH);
  if (clipped.length === trimmed.length) return trimmed;
  return `${clipText(trimmed, SCHEDULE_INPUT_PREVIEW_LENGTH - 1)}…`;
}
