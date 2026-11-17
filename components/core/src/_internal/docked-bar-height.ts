/**
 * The CSS custom property that carries the height of the docked action bar on the page, in pixels,
 * safe area included. The toast region reads it to sit above the bar, and a page can read it to
 * pad its own content. It is set on the document element while a bar is mounted and removed after.
 */
export const DOCKED_BAR_HEIGHT_PROPERTY = '--_cinder-docked-action-bar-height';

const bars = new Map<Element, number>();

function publish(): void {
  const root = document.documentElement;
  if (bars.size === 0) {
    root.style.removeProperty(DOCKED_BAR_HEIGHT_PROPERTY);
    return;
  }
  root.style.setProperty(DOCKED_BAR_HEIGHT_PROPERTY, `${Math.max(...bars.values())}px`);
}

/**
 * Starts publishing `--_cinder-docked-action-bar-height` for a bar and returns the function that
 * stops it. With several bars on the page the tallest wins. Where `ResizeObserver` is missing the
 * height is read once.
 */
export function trackDockedBarHeight(bar: HTMLElement): () => void {
  if (typeof document === 'undefined') return () => {};
  const measure = () => {
    bars.set(bar, Math.ceil(bar.getBoundingClientRect().height));
    publish();
  };
  measure();
  const observer =
    typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : undefined;
  observer?.observe(bar);
  return () => {
    observer?.disconnect();
    bars.delete(bar);
    publish();
  };
}
