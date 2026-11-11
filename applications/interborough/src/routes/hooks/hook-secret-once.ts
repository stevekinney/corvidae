/**
 * The signing secret of a hook just made, carried across the one page change that follows saving
 * it. The Bureau answers `create` with the secret it made, once; the editor opens the new hook's
 * own page next, and that page shows the secret revealed, with a Copy button, and never again. The
 * secret lives in this module's memory only: it is taken (and so forgotten) by the page that shows
 * it, it is never written to storage or the address, and a reload or a later visit finds none.
 */

const held = new Map<string, string>();

/** Keeps the secret of the hook `hookId` for the page that opens next. */
export function holdSecret(hookId: string, secret: string): void {
  held.set(hookId, secret);
}

/** Takes the secret held for `hookId`, if any, and forgets it. */
export function takeHeldSecret(hookId: string): string | undefined {
  const secret = held.get(hookId);
  held.delete(hookId);
  return secret;
}
