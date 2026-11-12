import { describe, expect, test } from 'bun:test';

import { wholeAttachmentRowsBlockSize } from './attachment-rows.ts';

// A ready row is 40px, a failed row 62px (its error line adds 22px), rows stand 8px apart and the
// list pads its end by 8px. The fade is 24px.
const fade = 24;
const paddingEnd = 8;
const bottomsOf = (heights: number[]): number[] => {
  let top = 8;
  return heights.map((height) => {
    top += height;
    const bottom = top;
    top += 8;
    return bottom;
  });
};

describe('wholeAttachmentRowsBlockSize', () => {
  test('returns undefined when every row fits, so nothing is snapped', () => {
    expect(
      wholeAttachmentRowsBlockSize({ bottoms: bottomsOf([40, 62]), room: 192, fade, paddingEnd }),
    ).toBeUndefined();
  });

  test('sums real row heights: a taller failed row ends the visible rows where it really ends', () => {
    const bottoms = bottomsOf([40, 62, 40, 40, 40]); // 48, 118, 166, 214, 262
    const size = wholeAttachmentRowsBlockSize({ bottoms, room: 192, fade, paddingEnd });
    // 192 - 24 = 168: the third row (bottom 166) is the last whole row; the fade stands below it.
    expect(size).toBe(166 + fade);
  });

  test('keeps the fade off the last visible row even when that row is a failed row with an error line', () => {
    const bottoms = bottomsOf([40, 62, 62, 40]); // 48, 118, 188, 236
    const room = 192;
    const size = wholeAttachmentRowsBlockSize({ bottoms, room, fade, paddingEnd })!;
    // The third row ends at 188, inside the fade's 24px (168-192), so it is not a visible row.
    expect(size).toBe(118 + fade);
    // Every visible row ends at or above the top of the fade.
    const visible = bottoms.filter((bottom) => bottom <= size - fade);
    expect(visible).toEqual([48, 118]);
  });

  test('never exceeds the room when at least one row fits above the fade', () => {
    const size = wholeAttachmentRowsBlockSize({
      bottoms: bottomsOf([40, 40, 40, 40, 40, 40]),
      room: 192,
      fade,
      paddingEnd,
    })!;
    expect(size).toBeLessThanOrEqual(192 + 1);
  });

  test('shows the first row whole when it alone is taller than the window', () => {
    expect(wholeAttachmentRowsBlockSize({ bottoms: [300, 360], room: 192, fade, paddingEnd })).toBe(
      300 + fade,
    );
  });

  test('uses the larger of the fade and the padding for the end room', () => {
    expect(
      wholeAttachmentRowsBlockSize({
        bottoms: bottomsOf([40, 40, 40, 40, 40, 40]),
        room: 192,
        fade: 4,
        paddingEnd: 8,
      }),
    ).toBe(Math.max(...bottomsOf([40, 40, 40, 40, 40, 40]).filter((bottom) => bottom <= 189)) + 8);
  });
});
