export type DeferredToggleOptions = {
  /** Hydrate the shell. A rejection must leave a later call free to try again. */
  hydrate: () => Promise<void>;
  /** True once Svelte owns the button, so its own handler receives clicks. */
  isHydrated: () => boolean;
  /** Receives a failed hydration attempt. */
  onError: (error: unknown) => void;
  /**
   * Aborted when the page is swapped out. A replay after that point would click a button whose
   * shell never hydrated, and the click would start another attempt: a loop.
   */
  signal?: AbortSignal;
};

/**
 * Make a server-rendered toolbar button work before the shell is hydrated.
 *
 * The landing shell stays un-hydrated until the reader asks for something, so a
 * toolbar button rendered by SSR has no Svelte handler behind it yet: the first
 * click would land on inert markup and appear to do nothing. The first click is
 * cancelled, the shell hydrates, and the click is replayed into the now-live
 * component.
 *
 * The listener is deliberately not `{ once: true }`. A hydration attempt can fail
 * (a dynamic import whose chunk request dropped, say), and a listener that had
 * already removed itself would leave the button inert until the page reloaded.
 * Instead it stays attached, ignores clicks while an attempt is in flight, and
 * lets a click after a failure start a fresh attempt. Once the shell is hydrated
 * it steps aside, so the replayed click and every later one reach Svelte's own
 * handler.
 */
export function attachDeferredToggle(
  toggle: HTMLButtonElement | null,
  { hydrate, isHydrated, onError, signal }: DeferredToggleOptions,
): void {
  let attempting = false;
  toggle?.addEventListener('click', (event) => {
    if (isHydrated() || attempting) return;
    event.preventDefault();
    attempting = true;
    void hydrate()
      .then(() => {
        attempting = false;
        if (signal?.aborted === true) return undefined;
        toggle.click();
        return undefined;
      })
      .catch((error: unknown) => {
        attempting = false;
        onError(error);
      });
  });
}
