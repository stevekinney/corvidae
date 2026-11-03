/**
 * Keeps what a reader is looking at in place when rows are inserted above it.
 *
 * Browsers with scroll anchoring (Chromium, Firefox) already do this, and Safari does not, so the
 * list measures a row before its rows change and, after they have, scrolls by however far that row
 * moved. Where the browser already compensated the row has not moved and nothing happens. A list
 * scrolled to its top is left alone: a row inserted there is meant to be seen.
 */

/** The nearest ancestor that scrolls vertically, or `undefined` for the document. */
export function findScrollContainer(element: HTMLElement): HTMLElement | undefined {
  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    const { overflowY } = getComputedStyle(ancestor);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return ancestor;
  }
  return undefined;
}

/**
 * Measures the first row at or below the top of the scrolling area. Returns a function that, once
 * the DOM has changed, scrolls so that row sits where it did; `undefined` when there is nothing
 * to hold still (scrolled to the top, or no row is on screen).
 */
export function captureScrollAnchor(list: HTMLElement): (() => void) | undefined {
  const container = findScrollContainer(list);
  const scrolled = container ? container.scrollTop : window.scrollY;
  if (scrolled <= 0) return undefined;
  const top = container ? container.getBoundingClientRect().top : 0;

  // A leaf row (not a group holding rows) is the anchor, so a group header never is.
  const anchor = [...list.querySelectorAll('li')].find(
    (row) => row.querySelector('li') === null && row.getBoundingClientRect().bottom > top,
  );
  if (anchor === undefined) return undefined;
  const before = anchor.getBoundingClientRect().top;

  return () => {
    if (!anchor.isConnected) return;
    const shift = anchor.getBoundingClientRect().top - before;
    if (shift === 0) return;
    if (container) container.scrollTop += shift;
    else window.scrollBy(0, shift);
  };
}
