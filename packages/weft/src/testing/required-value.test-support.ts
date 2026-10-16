/**
 * Weft's copy of `@lostgradient/testing`'s `requiredValue`, for the tests under `src/ui`.
 *
 * Nothing under `packages/weft` imports `@lostgradient/testing`: the mirror drops that private
 * development dependency for the weft target, so it would not resolve in the Weft repository.
 */

/** Require a present fixture or result before making more specific assertions. */
export function requiredValue<Value>(value: Value | null | undefined): Value {
  if (value === undefined || value === null) {
    throw new Error('Expected a present test result or fixture entry');
  }
  return value;
}
