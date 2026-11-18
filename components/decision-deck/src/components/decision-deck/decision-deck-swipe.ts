/** The sideways outcomes a drag can resolve to: right accepts and left rejects. */
export type SwipeOutcome = 'accept' | 'reject';

/** Distance in pixels a card must be dragged sideways before releasing it decides. */
export const DEFAULT_SWIPE_THRESHOLD = 110;

/** Distance in pixels the pointer must travel before the gesture counts as a drag at all. A shorter move stays a tap. */
export const SWIPE_SLOP = 8;

/** The configured threshold when it is a positive finite number, otherwise the default. */
export function resolveSwipeThreshold(threshold: number | undefined): number {
  return threshold !== undefined && Number.isFinite(threshold) && threshold > 0
    ? threshold
    : DEFAULT_SWIPE_THRESHOLD;
}

/**
 * What releasing a card at this sideways offset decides: `accept` at or past the threshold to the
 * right, `reject` at or past it to the left, and `null` for a shorter release, which springs back.
 */
export function resolveSwipeOutcome(offset: number, threshold: number): SwipeOutcome | null {
  if (offset >= threshold) return 'accept';
  if (offset <= -threshold) return 'reject';
  return null;
}

/**
 * Opacity of one outcome's stamp at this offset: 0 when the card is dragged the other way, rising
 * linearly to 1 as the drag reaches the threshold.
 */
export function swipeStampOpacity(
  offset: number,
  threshold: number,
  outcome: SwipeOutcome,
): number {
  const travelled = outcome === 'accept' ? offset : -offset;
  if (travelled <= 0) return 0;
  return Math.min(1, travelled / threshold);
}

/**
 * Whether the movement is mostly vertical, which means the person is scrolling the page and not
 * swiping the card, so the gesture is dropped without a decision.
 */
export function isVerticalGesture(deltaX: number, deltaY: number): boolean {
  return Math.abs(deltaY) > Math.abs(deltaX);
}

/** The transform of a card dragged this far sideways: a slide with a slight tilt toward the drag. */
export function swipeTransform(offset: number): string {
  return `translateX(${offset}px) rotate(${offset / 20}deg)`;
}
