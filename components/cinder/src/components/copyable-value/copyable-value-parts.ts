/**
 * Where an address may break. An address has no spaces, so its places to break are its own
 * punctuation, in two ranks:
 *
 * - A _part_ ends after a run of slashes, colons, question marks, ampersands and equals signs, so
 *   `http://`, a host and a port, and each path segment stay whole until one is longer than the line.
 * - A part with dots in it is cut again into _pieces_, each ending after a dot, that a line breaks
 *   between only when the whole part is longer than the line. A dot is a break of last resort: it
 *   is what keeps `127.0.0.1` and `agent-card.json` in one piece.
 *
 * Concatenating every piece of every part gives the value back, so nothing is added to or taken
 * from the text that is shown and copied.
 */

/** After a run of these characters, and not between two of them, so `://` is one stretch. */
const AFTER_PUNCTUATION = /(?<=[/:?&=])(?![/:?&=])/;

/**
 * After a dot that follows a character other than a dot, and not before another dot. A leading dot
 * (`.well-known`, a hidden file) belongs to the name it starts, never a piece of its own.
 */
const AFTER_DOT = /(?<=[^.]\.)(?!\.)/;

/** The value as parts, each as the pieces a line may break between when a part is too long. */
export function splitValue(value: string): string[][] {
  return value.split(AFTER_PUNCTUATION).map((part) => part.split(AFTER_DOT));
}
