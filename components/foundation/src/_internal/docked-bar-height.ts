import { readKeyboardInset } from './keyboard-inset.ts';

/**
 * The CSS custom property that carries how far from the bottom of the viewport the bars docked
 * there reach, in pixels, safe area included: the distance from the viewport's bottom edge (above
 * the on-screen keyboard) to the top edge of the highest docked bar, and never less than the
 * tallest tracked bar's own height. A DockedActionBar, docked FormActions, a bottom NavigationBar
 * (a phone's tab bar) and any surface marked with the `dockedToBottom()` attachment are tracked.
 * The toast region reads it to sit above them, and a page can read it to pad its own content. It
 * is set on the document element while a tracked bar is drawn and removed after.
 */
export const DOCKED_BAR_HEIGHT_PROPERTY = '--_cinder-docked-action-bar-height';

/**
 * How far a bar's bottom edge may sit from the edge below it and still count as docked to it, in
 * pixels: room for the fractions layout rounds, not for a gap anyone would draw.
 */
const DOCKING_TOLERANCE = 2;

const bars = new Set<Element>();
let stopListeningToViewport: (() => void) | null = null;

/**
 * How far the toasts are lifted, or `undefined` when no tracked bar is drawn. It is the distance
 * from the viewport's bottom edge, above the keyboard, to the top of the highest bar docked there:
 * a bar is docked when its bottom edge reaches that edge or the top of a docked bar under it, or
 * stops short of it by less than the bar's own height (the page's padding under the bar), so a
 * tab bar with a docked action bar or a chat's composer stacked on it reaches the top of the higher
 * one. It is never less than the tallest drawn bar's own height, so a bar that is not docked at
 * this moment (a sticky bar resting at the end of a short page, or one moved by content that grew
 * above it before it was measured again) still lifts the toasts by its height, as it always has. A
 * bar that is not drawn (no height) does not count.
 */
function dockedDistance(): number | undefined {
  const bottom = window.innerHeight - readKeyboardInset();
  const boxes = [...bars]
    .map((bar) => bar.getBoundingClientRect())
    .filter((box) => box.height > 0 && Number.isFinite(box.top) && Number.isFinite(box.bottom));
  if (boxes.length === 0) return undefined;
  const tallest = Math.ceil(Math.max(...boxes.map((box) => box.height)));
  let edge = bottom;
  let moved = true;
  while (moved) {
    moved = false;
    for (const box of boxes) {
      // A gap shorter than the bar itself is the page's padding under it (a chat's composer sits
      // above its page's bottom padding), not room that puts the bar further up the page.
      const reach = Math.max(DOCKING_TOLERANCE, box.height - 1);
      if (box.top < edge && box.bottom >= edge - reach) {
        edge = box.top;
        moved = true;
      }
    }
  }
  return Math.max(tallest, Math.ceil(bottom - Math.max(edge, 0)));
}

function publish(): void {
  const root = document.documentElement;
  const distance = bars.size === 0 ? undefined : dockedDistance();
  if (distance === undefined) {
    root.style.removeProperty(DOCKED_BAR_HEIGHT_PROPERTY);
    return;
  }
  root.style.setProperty(DOCKED_BAR_HEIGHT_PROPERTY, `${distance}px`);
}

/**
 * A bar's place changes with the viewport and the keyboard as well as with its own size, and with
 * the page's content: a sticky bar is pushed down to the bottom when content arrives above it.
 */
function listenToViewport(): () => void {
  const visualViewport = window.visualViewport;
  window.addEventListener('resize', publish);
  visualViewport?.addEventListener('resize', publish);
  visualViewport?.addEventListener('scroll', publish);
  const page = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : undefined;
  page?.observe(document.documentElement);
  return () => {
    window.removeEventListener('resize', publish);
    visualViewport?.removeEventListener('resize', publish);
    visualViewport?.removeEventListener('scroll', publish);
    page?.disconnect();
  };
}

/**
 * Starts tracking a bar docked to the bottom of the page and returns the function that stops it.
 * While it is tracked, `--_cinder-docked-action-bar-height` is the distance from the viewport's
 * bottom to the top of the highest docked bar (see {@link dockedDistance}), measured again when any
 * tracked bar mounts, unmounts or changes size, and when the viewport or the keyboard does. Where
 * `ResizeObserver` is missing a bar's own size changes are not followed.
 */
export function trackDockedBar(bar: HTMLElement): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};
  bars.add(bar);
  if (bars.size === 1) stopListeningToViewport = listenToViewport();
  publish();
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : undefined;
  observer?.observe(bar);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    bars.delete(bar);
    if (bars.size === 0) {
      stopListeningToViewport?.();
      stopListeningToViewport = null;
    }
    publish();
  };
}
