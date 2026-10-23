/**
 * What the route outlet does when a route's code cannot be fetched because the build it was
 * loaded from is gone. A rebuild renames every chunk (`assets/<name>-<hash>.js`), so a tab opened
 * before it asks for names the host no longer has. The page it already holds is of no use, and a
 * reload fetches the new one, so the outlet reloads once instead of telling the person to.
 *
 * Once, because a reload that does not help must not become a loop: the guard is set before the
 * reload and cleared when any route's code loads, so a second miss in a row shows the failure.
 */

/** The `sessionStorage` key that says this tab has just reloaded for a missing chunk. */
export const CHUNK_RELOAD_KEY = 'interborough:chunk-reload';

/**
 * What a browser says when a dynamic `import()` cannot fetch its module: Chromium, Firefox, and
 * Safari word it differently. An error the module itself throws while it runs is not this, and a
 * reload would not mend it.
 */
const MISSING_CHUNK_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
] as const;

/** Whether `error` is a dynamic import that could not fetch its module. */
export function isMissingChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return MISSING_CHUNK_PATTERNS.some((pattern) => pattern.test(message));
}

type GuardStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** `sessionStorage` where the browser lets a page read it, and nothing where it does not. */
function defaultStorage(): GuardStorage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

export type ChunkReloadEnvironment = {
  readonly storage?: GuardStorage | undefined;
  readonly reload?: () => void;
  /** Whether the browser believes it can reach the network. A reload offline loses the page. */
  readonly online?: boolean;
};

/**
 * Reloads the page, once in a row, when `error` is a missing chunk. Returns whether it did, so
 * the caller can keep its loading state while the page goes. Without storage to keep the guard in
 * it does not reload, since nothing would stop a loop.
 */
export function reloadOnceForMissingChunk(
  error: unknown,
  environment: ChunkReloadEnvironment = {},
): boolean {
  if (!isMissingChunkError(error)) return false;
  const online = environment.online ?? globalThis.navigator?.onLine ?? true;
  if (!online) return false;
  const storage = 'storage' in environment ? environment.storage : defaultStorage();
  if (storage === undefined) return false;
  try {
    if (storage.getItem(CHUNK_RELOAD_KEY) !== null) return false;
    storage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  (environment.reload ?? (() => globalThis.location.reload()))();
  return true;
}

/** Lifts the guard once a route's code has loaded, so a later rebuild can reload again. */
export function clearChunkReloadGuard(
  environment: Pick<ChunkReloadEnvironment, 'storage'> = {},
): void {
  const storage = 'storage' in environment ? environment.storage : defaultStorage();
  try {
    storage?.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    // A tab that cannot clear it just shows the failure on the next miss.
  }
}
