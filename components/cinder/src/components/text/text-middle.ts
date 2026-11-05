/** The mark a cut head ends with. */
export const MIDDLE_ELLIPSIS = '…';

/**
 * How wide a cut head must be so its ellipsis lands right against the tail.
 *
 * `text-overflow: ellipsis` cuts at the last character that fits and leaves whatever room is left
 * over as a gap before the tail, up to one whole character. This finds the longest leading part of
 * the head that still fits with the ellipsis after it, and returns that part's own width, so a box
 * of exactly this width has no slack. It returns `undefined` when the head fits whole.
 *
 * @param characters The head, one entry per character a reader sees.
 * @param available How wide the head's box is, in pixels.
 * @param measure Returns how wide a run of text is in the head's own font.
 */
export function fitMiddleHead(
  characters: readonly string[],
  available: number,
  measure: (text: string) => number,
): number | undefined {
  if (measure(characters.join('')) <= available) return undefined;
  let low = 0;
  let high = characters.length - 1;
  let best = measure(MIDDLE_ELLIPSIS);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const width = measure(characters.slice(0, middle).join('') + MIDDLE_ELLIPSIS);
    if (width <= available) {
      best = width;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return Math.min(best, available);
}
