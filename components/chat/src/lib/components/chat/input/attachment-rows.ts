/**
 * What the opened attachment list measures about its rows. A ready row and a failed row (which
 * carries an error line) have different heights, so the list is sized from each row's measured
 * box, never from one row height times a count.
 */
export type AttachmentRowMeasurements = {
  /** Each row's bottom edge, from the list's top edge, in document order (scroll offset included). */
  bottoms: readonly number[];
  /** Each row's own height, in the same order. */
  heights: readonly number[];
  /** The block size the list can use before it scrolls. */
  room: number;
  /** The block size of the fade drawn over the list's last visible edge while more lies below. */
  fade: number;
  /** The list's block-end padding, the room for the last row's hit-area overhang. */
  paddingEnd: number;
};

/**
 * The block size that shows whole rows only and keeps the end fade off every visible row, or
 * `undefined` when every row already fits and there is nothing to snap. The visible rows end at
 * least one fade above the window's edge, so the fade overlays only the gap and the top of the next
 * row (which it is meant to hint at), never a row's content such as its error line. The window is
 * never smaller than the tallest row plus the fade and one padding: a row scrolled to the end edge
 * stops one fade short of it and one padding from the start edge (the list's scroll padding), and a
 * shorter window would push that row's top out of view.
 */
export function wholeAttachmentRowsBlockSize(
  measurements: AttachmentRowMeasurements,
): number | undefined {
  const { bottoms, heights, room, fade, paddingEnd } = measurements;
  const lastBottom = bottoms.at(-1);
  if (lastBottom === undefined || lastBottom <= room + 1) return undefined;
  const whole = bottoms.filter((bottom) => bottom <= room - fade + 1).at(-1) ?? bottoms[0]!;
  const tallest = Math.max(0, ...heights);
  return Math.max(whole + Math.max(fade, paddingEnd), tallest + fade + paddingEnd);
}
