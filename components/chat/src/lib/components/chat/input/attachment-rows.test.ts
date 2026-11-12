import { describe, expect, test } from 'bun:test';

import { wholeAttachmentRowsBlockSize } from './attachment-rows.ts';

// Rows stand 8px apart, the list pads its start and end by 8px and the fade is 24px. A ready row
// is 40px; a failed row carries an error line and is 62px.
const fade = 24;
const paddingEnd = 8;

function measure(heights: number[], room: number, fadeSize = fade) {
  let top = 8;
  const bottoms = heights.map((height) => {
    top += height;
    const bottom = top;
    top += 8;
    return bottom;
  });
  return { bottoms, heights, room, fade: fadeSize, paddingEnd };
}

describe('wholeAttachmentRowsBlockSize', () => {
  test('returns undefined when every row fits, so nothing is snapped', () => {
    expect(wholeAttachmentRowsBlockSize(measure([40, 62], 192))).toBeUndefined();
  });

  test('uses each real row height: a taller failed row ends the visible rows where it ends', () => {
    // Bottoms 48, 118, 166, 214, 262; 192 - 24 = 168, so the third row is the last whole row.
    expect(wholeAttachmentRowsBlockSize(measure([40, 62, 40, 40, 40], 192))).toBe(166 + fade);
  });

  test('keeps the fade off a visible failed row and its error line', () => {
    const measurements = measure([40, 62, 62, 40], 192); // bottoms 48, 118, 188, 236
    const size = wholeAttachmentRowsBlockSize(measurements)!;
    // The third row ends at 188, inside the fade's 24px (168 to 192), so it is not a visible row.
    expect(size).toBe(118 + fade);
    expect(measurements.bottoms.filter((bottom) => bottom <= size - fade)).toEqual([48, 118]);
  });

  test('never exceeds the room when a row fits above the fade', () => {
    const size = wholeAttachmentRowsBlockSize(measure([40, 40, 40, 40, 40, 40], 192))!;
    expect(size).toBeLessThanOrEqual(192 + 1);
  });

  test('shows the first row whole when it alone is taller than the window', () => {
    expect(wholeAttachmentRowsBlockSize(measure([300, 60], 192))).toBe(308 + fade);
  });

  test('a short window still holds the tallest row above the fade', () => {
    // Bottoms 46, 109.6 with room 120: only the first row clears the fade, but a row scrolled to
    // the end edge stops one fade short of it, so the 55.6px row needs 55.6 + 24 of window.
    const size = wholeAttachmentRowsBlockSize(measure([38, 55.6, 38, 38], 120))!;
    expect(size).toBeGreaterThanOrEqual(55.6 + fade);
  });

  test('uses the larger of the fade and the padding for the end room', () => {
    // Fade 4 and padding 8: bottoms 48, 96, 144, 192; room 192 keeps rows through 144 (<= 189).
    expect(wholeAttachmentRowsBlockSize(measure([40, 40, 40, 40, 40, 40], 192, 4))).toBe(144 + 8);
  });
});
