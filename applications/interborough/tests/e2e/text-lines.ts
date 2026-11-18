/**
 * Where a box's words sit on the screen, read in the browser, because a stylesheet rule cannot say
 * whether a word broke in two at a given width ("Sh / ow" on a 320px phone, COR-2181).
 */
import type { Locator } from '@playwright/test';

/** The lines a box's text takes and the box's text edges, measured over its text nodes only. */
export type TextLines = {
  /** How many lines the text takes: its line boxes' distinct vertical middles, 4px apart or more. */
  readonly lines: number;
  /** The leftmost and rightmost painted edge of the text, clipped to the box. */
  readonly left: number;
  readonly right: number;
  /** The vertical middle of the text's first line. */
  readonly middle: number;
};

export async function textLines(locator: Locator): Promise<TextLines> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const rects: DOMRect[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if ((node.textContent ?? '').trim() === '') continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      rects.push(...[...range.getClientRects()].filter((rect) => rect.width > 0));
    }
    const middles: number[] = [];
    for (const rect of rects) {
      const middle = rect.top + rect.height / 2;
      if (!middles.some((seen) => Math.abs(seen - middle) < 4)) middles.push(middle);
    }
    middles.sort((a, b) => a - b);
    return {
      lines: middles.length,
      left: Math.max(box.left, Math.min(...rects.map((rect) => rect.left))),
      right: Math.min(box.right, Math.max(...rects.map((rect) => rect.right))),
      middle: middles[0] ?? box.top + box.height / 2,
    };
  });
}
