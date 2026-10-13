/**
 * The workbench layout breakpoints from the interaction spec: the desktop arrangement
 * from 1200px, the tablet arrangement from 768px through 1199px, and the Edit, Preview,
 * and Checks tabs below 768px. The CSS media queries and this module use the same
 * numbers; the script needs them to choose between the desktop table and the stacked
 * rows, and to decide whether the three panes are tab panels.
 */

export const DESKTOP_MIN_WIDTH = 1200;
export const TABLET_MIN_WIDTH = 768;

export type WorkbenchLayout = 'desktop' | 'tablet' | 'mobile';

export function layoutForWidth(width: number): WorkbenchLayout {
  if (width >= DESKTOP_MIN_WIDTH) return 'desktop';
  return width >= TABLET_MIN_WIDTH ? 'tablet' : 'mobile';
}

/**
 * Report the current layout and every change to it. Uses `matchMedia` so the layout
 * flips at exactly the widths the stylesheet does; without it (an environment with no
 * media queries) the layout is derived from `innerWidth` once.
 */
export function observeLayout(
  view: Window,
  onChange: (layout: WorkbenchLayout) => void,
): () => void {
  if (typeof view.matchMedia !== 'function') {
    onChange(layoutForWidth(view.innerWidth));
    return () => undefined;
  }
  const desktop = view.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`);
  const tablet = view.matchMedia(`(min-width: ${TABLET_MIN_WIDTH}px)`);
  const report = (): void => {
    if (desktop.matches) onChange('desktop');
    else onChange(tablet.matches ? 'tablet' : 'mobile');
  };
  report();
  desktop.addEventListener('change', report);
  tablet.addEventListener('change', report);
  return () => {
    desktop.removeEventListener('change', report);
    tablet.removeEventListener('change', report);
  };
}
