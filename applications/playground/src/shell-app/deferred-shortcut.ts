export type DeferredShortcutOptions = {
  /** True for a keydown the hydrated page would handle as this shortcut. */
  matches: (event: KeyboardEvent) => boolean;
  /** Hydrate the shell. A rejection must leave a later press free to try again. */
  hydrate: () => Promise<void>;
  /** True once Svelte owns the page, so its own shortcut listener is live. */
  isHydrated: () => boolean;
  /** Perform the shortcut against the hydrated page, e.g. click its trigger. */
  activate: () => void;
  /** Receives a failed hydration attempt. */
  onError: (error: unknown) => void;
};

/**
 * Make a keyboard shortcut work before the landing shell is hydrated.
 *
 * The hydrated page registers its own listener, so this one only covers presses
 * that arrive first: it claims the press (so the browser's own binding for the
 * same keys does not fire), hydrates, and activates the shortcut once. A press
 * while an attempt is in flight is claimed but starts nothing, so one burst of
 * presses opens the target once. After hydration it steps aside; the press that
 * caused hydration has already been dispatched, so the newly attached listener
 * never sees it and the shortcut cannot fire twice.
 */
export function attachDeferredShortcut(
  target: Pick<Window, 'addEventListener'>,
  { matches, hydrate, isHydrated, activate, onError }: DeferredShortcutOptions,
): void {
  let attempting = false;
  target.addEventListener('keydown', (event) => {
    if (isHydrated() || !matches(event)) return;
    event.preventDefault();
    if (attempting) return;
    attempting = true;
    void hydrate()
      .then(() => {
        attempting = false;
        activate();
        return undefined;
      })
      .catch((error: unknown) => {
        attempting = false;
        onError(error);
      });
  });
}
