/**
 * Reads several elements' boxes from one layout.
 *
 * Each `locator.boundingBox()` is a round trip of its own, so a page that is still moving (a row
 * being scrolled to the middle, a transition settling) can lay out differently between two reads,
 * and a position from one read compared with a position from another can describe two different
 * moments. `readBoxes` finds every element first, then takes all the rects in a single in-page
 * evaluation, so they come from one layout. Wait for the settled state before calling it
 * (`await expect(row).toBeFocused()`, a visible and stable element): one layout is the same
 * layout only once the page has stopped moving. `scripts/check-separate-box-reads.ts` (in this application) flags a
 * comparison across separate reads.
 */
import type { Locator, Page } from '@playwright/test';

/** An element's rect in CSS pixels, relative to the page's viewport. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The rect of each locator, under the same key, read together. Each locator must match one
 * element; the call waits for it as `locator.elementHandle()` does, and throws, naming the key,
 * when none appears or the element has no box.
 */
export async function readBoxes<const Locators extends Readonly<Record<string, Locator>>>(
  page: Page,
  locators: Locators,
): Promise<{ readonly [Key in keyof Locators]: Box }> {
  const names = Object.keys(locators);
  const found = await Promise.all(names.map((name) => (locators[name] as Locator).elementHandle()));
  const handles = found.filter((handle) => handle !== null);
  const missing = names.filter((_name, index) => found[index] === null);
  if (missing.length > 0) {
    await Promise.all(handles.map((handle) => handle.dispose()));
    throw new Error(`readBoxes found no element for: ${missing.join(', ')}.`);
  }
  try {
    // An element with no client rects (hidden, detached) has no box: `boundingBox()` returned
    // null for it, and the zero rect `getBoundingClientRect()` gives would let a comparison pass.
    const boxes = await page.evaluate((elements) => {
      return elements.map((element) => {
        if (element.getClientRects().length === 0) return null;
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      });
    }, handles);
    const withoutBox = names.filter((_name, index) => boxes[index] === null);
    if (withoutBox.length > 0) {
      throw new Error(`readBoxes found no box (hidden or detached) for: ${withoutBox.join(', ')}.`);
    }
    return Object.fromEntries(names.map((name, index) => [name, boxes[index]])) as {
      readonly [Key in keyof Locators]: Box;
    };
  } finally {
    await Promise.all(handles.map((handle) => handle.dispose()));
  }
}
