/// <reference lib="dom" />
/**
 * Support for the first-line alignment tests (COR-2360): where a control sits against the first
 * line of the text beside it. happy-dom performs no layout, so these are measured in a browser.
 */

import type { Locator } from '@playwright/test';

/** Sub-pixel rounding in layout, and the half pixel a 0.75px offset can lose when it is snapped. */
export const ALIGNMENT_TOLERANCE = 1;

export type FirstLine = {
  /** Top of the text's first line box, below any padding the element carries above it. */
  top: number;
  /** Bottom of that line box. */
  bottom: number;
  /** The vertical middle of that line box. */
  center: number;
  /** The computed height of one line. */
  lineHeight: number;
  /** How many lines the text takes. */
  lines: number;
};

export type Box = { left: number; right: number; top: number; bottom: number; center: number };

/** The first line box of an element's text, read from its box and its computed line height. */
export async function firstLineOf(text: Locator): Promise<FirstLine> {
  return text.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight);
    if (!Number.isFinite(lineHeight)) {
      throw new Error(`The element has no computed line height (${style.lineHeight}).`);
    }
    const paddingTop = Number.parseFloat(style.paddingTop);
    const paddingBottom = Number.parseFloat(style.paddingBottom);
    const top = box.top + paddingTop + Number.parseFloat(style.borderTopWidth);
    const content = box.height - paddingTop - paddingBottom;
    return {
      top,
      bottom: top + lineHeight,
      center: top + lineHeight / 2,
      lineHeight,
      lines: Math.round(content / lineHeight),
    };
  });
}

/** The border box of a control, with its vertical middle. */
export async function boxOf(control: Locator): Promise<Box> {
  const box = await control.boundingBox();
  if (box === null) throw new Error('The control has no layout box.');
  return {
    left: box.x,
    right: box.x + box.width,
    top: box.y,
    bottom: box.y + box.height,
    center: box.y + box.height / 2,
  };
}
