/**
 * Subscriptions to the browser signals that change how the terminal should fit and look. Each
 * `watch*` function subscribes only when the runtime offers the signal, and returns a function
 * that removes every listener and observer it created. None of them runs at import time.
 */

export type Unwatch = () => void;

/** Whether `query` matches now, and a way to stop watching it. */
export type MediaQueryWatch = { matches(): boolean; dispose: Unwatch };

export function watchMediaQuery(query: string, onChange: () => void): MediaQueryWatch {
  const list = typeof matchMedia === 'function' ? matchMedia(query) : undefined;
  list?.addEventListener('change', onChange);
  return {
    matches: () => list?.matches ?? false,
    dispose: () => list?.removeEventListener('change', onChange),
  };
}

/**
 * Calls `onChange` whenever the device-pixel ratio changes, which is how browser zoom and moving
 * a window between displays surface. A resolution query only matches one ratio, so each change
 * re-arms the query for the new ratio.
 */
export function watchDevicePixelRatio(onChange: () => void): Unwatch {
  let disposed = false;
  let current: MediaQueryWatch | undefined;
  const arm = (): void => {
    current?.dispose();
    current = watchMediaQuery(`(resolution: ${globalThis.devicePixelRatio ?? 1}dppx)`, () => {
      if (disposed) return;
      arm();
      onChange();
    });
  };
  arm();
  return () => {
    disposed = true;
    current?.dispose();
  };
}

/** Calls `onChange` when `element`'s content box changes size. */
export function watchElementSize(element: Element, onChange: () => void): Unwatch {
  if (typeof ResizeObserver !== 'function') return () => {};
  const observer = new ResizeObserver(() => onChange());
  observer.observe(element);
  return () => observer.disconnect();
}

/** Calls `onChange` when web fonts finish loading, which changes the measured cell size. */
export function watchFontLoading(onChange: () => void): Unwatch {
  const fonts = typeof document === 'undefined' ? undefined : document.fonts;
  if (fonts === undefined) return () => {};
  let disposed = false;
  const notify = (): void => {
    if (!disposed) onChange();
  };
  fonts.addEventListener('loadingdone', notify);
  void fonts.ready.then(notify);
  return () => {
    disposed = true;
    fonts.removeEventListener('loadingdone', notify);
  };
}

/** Calls `onChange` when the window resizes, which includes page zoom changing the viewport. */
export function watchWindowResize(onChange: () => void): Unwatch {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

/** Calls `onChange` when a `data-theme` attribute changes anywhere in the document. */
export function watchThemeAttribute(onChange: () => void): Unwatch {
  if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return () => {};
  const observer = new MutationObserver(() => onChange());
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
    subtree: true,
  });
  return () => observer.disconnect();
}
