/**
 * Suppresses CSS transitions for the frames in which the color theme changes.
 *
 * Cinder components transition `color`, `background-color` and `border-color` so hover and press
 * feedback eases. Those same transitions fire when the theme flips, because every themed value
 * changes at once: switching light to dark animates every button, card, row and banner from its
 * light value to its dark one. In a page whose rendering is throttled (a hidden tab or pane) the
 * animation can stall partway, leaving light surfaces under dark text. The guard marks the root
 * with {@link THEME_CHANGING_ATTRIBUTE} as soon as the theme changes, which the foundation styles
 * answer with `transition: none`, and removes the mark once two frames have rendered with the new
 * theme, so later state changes animate as before.
 *
 * It watches the two ways a theme changes: the `data-theme` attribute on the root (an application's
 * own toggle) and the `prefers-color-scheme` media query (the operating system's setting, which
 * applies when the root has no `data-theme`).
 */

/** The attribute the guard sets on the root while a theme change renders. */
export const THEME_CHANGING_ATTRIBUTE = 'data-cinder-theme-changing';

/** What the guard observes and how it schedules; every field defaults to the current window. */
export interface ThemeTransitionGuardOptions {
  /** The element whose `data-theme` selects the theme, and which carries the guard attribute. */
  readonly root?: HTMLElement;
  /** Evaluates `prefers-color-scheme`; omit it (or pass `null`) to ignore the system setting. */
  readonly matchMedia?: ((query: string) => MediaQueryList) | null;
  /** Schedules work before the next frame renders. */
  readonly requestFrame?: (callback: () => void) => unknown;
}

/**
 * Installs the guard and answers a function that removes it. Install it once, at application start,
 * on the element that carries `data-theme` (normally `document.documentElement`).
 */
export function guardThemeTransitions(options: ThemeTransitionGuardOptions = {}): () => void {
  const root = options.root ?? document.documentElement;
  const view = root.ownerDocument.defaultView;
  const matchMedia =
    options.matchMedia === undefined
      ? view?.matchMedia === undefined
        ? null
        : view.matchMedia.bind(view)
      : options.matchMedia;
  const requestFrame =
    options.requestFrame ??
    ((callback: () => void) =>
      view?.requestAnimationFrame === undefined
        ? setTimeout(callback, 16)
        : view.requestAnimationFrame(callback));

  // Each change restarts the count, so a burst of changes keeps the guard until the last one has
  // rendered twice.
  let generation = 0;
  let removed = false;

  const guard = (): void => {
    if (removed) return;
    generation += 1;
    const current = generation;
    root.setAttribute(THEME_CHANGING_ATTRIBUTE, '');
    // The first frame renders the new theme with transitions off; removing the mark in the second
    // changes only the transition property, so nothing starts animating.
    requestFrame(() => {
      requestFrame(() => {
        if (current === generation && !removed) root.removeAttribute(THEME_CHANGING_ATTRIBUTE);
      });
    });
  };

  const MutationObserverConstructor = view?.MutationObserver ?? globalThis.MutationObserver;
  const observer = new MutationObserverConstructor(guard);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  const scheme = matchMedia?.('(prefers-color-scheme: dark)') ?? null;
  scheme?.addEventListener('change', guard);

  return () => {
    removed = true;
    observer.disconnect();
    scheme?.removeEventListener('change', guard);
    root.removeAttribute(THEME_CHANGING_ATTRIBUTE);
  };
}
