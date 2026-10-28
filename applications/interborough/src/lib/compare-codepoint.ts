/**
 * Codepoint ordering for the Interborough views that sort what the engine reports. One
 * implementation here, rather than a private copy beside each sort, so the tie branch has a single
 * test.
 *
 * @module lib/compare-codepoint
 */

/**
 * Compare two strings by Unicode codepoint, returning the `-1`/`0`/`1` contract of
 * `Array.prototype.sort`. Unlike `localeCompare` it does not consult the host's collation data, so
 * the same names sort the same way on every machine.
 */
export function compareCodepoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
