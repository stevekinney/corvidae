export type DeferredShortcutOptions = {
  /** True for a keydown the hydrated page would handle as this shortcut. */
  matches: (event: KeyboardEvent) => boolean;
  /** Hydrate the shell. A rejection must leave a later press free to try again. */
  hydrate: () => Promise<void>;
  /**
   * True once the hydrated page's own shortcut listener is attached. Hydration
   * finishing is not enough: the page attaches its listener in an effect that
   * runs afterwards, and a press between the two would reach neither listener.
   */
  isLiveListenerAttached: () => boolean;
  /** Perform the shortcut against the hydrated page, e.g. click its trigger. */
  activate: () => void;
  /** Receives a failed hydration attempt. */
  onError: (error: unknown) => void;
  /** Removes the listener when aborted, for a page that is swapped out of the document. */
  signal?: AbortSignal;
};

/**
 * Make a keyboard shortcut work before the landing shell is hydrated.
 *
 * The hydrated page registers its own listener, so this one only covers presses
 * that arrive first: it claims the press (so the browser's own binding for the
 * same keys does not fire), hydrates, and activates the shortcut once. A press
 * while an attempt is in flight is claimed but starts nothing, so one burst of
 * presses opens the target once. It steps aside only once the page's own
 * listener is attached, so no press falls in between; the press that caused
 * hydration has already been dispatched, so the newly attached listener never
 * sees it and the shortcut cannot fire twice. Registered first, this listener
 * also runs first, and a press it claims is ignored by the page's listener,
 * which skips cancelled events.
 */
export function attachDeferredShortcut(
  target: Pick<Window, 'addEventListener'>,
  { matches, hydrate, isLiveListenerAttached, activate, onError, signal }: DeferredShortcutOptions,
): void {
  let attempting = false;
  target.addEventListener(
    'keydown',
    (event) => {
      if (isLiveListenerAttached() || !matches(event)) return;
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
    },
    signal === undefined ? {} : { signal },
  );
}
