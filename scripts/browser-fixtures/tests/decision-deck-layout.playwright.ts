/// <reference lib="dom" />
/**
 * DecisionDeck layout that happy-dom cannot measure (COR-2441). Mid-drag, the stamp of the outcome
 * sits in the trailing corner (the one the card moves away from), inside the card and inside the
 * viewport, and never covers the card's text; the progress phrase keeps its order ("1 of 3") under right to left. Measured in a browser
 * on the `drag-accept`, `drag-reject` and `drag-rtl` fixtures, in both themes, on a phone.
 */

import { loadManifest } from '@lostgradient/testing';
import { expect, type Locator } from '@playwright/test';
import { test } from './component-page-fixture.ts';

const entry = loadManifest().find((candidate) => candidate.slug === 'decision-deck');

type Box = { left: number; right: number; top: number; bottom: number };

async function box(locator: Locator): Promise<Box> {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  });
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

async function open(
  componentPage: Parameters<Parameters<typeof test>[2]>[0]['componentPage'],
  theme: 'light' | 'dark',
  fixtureName: string,
) {
  const fixture = entry?.fixtures?.find((candidate) => candidate.name === fixtureName);
  if (entry === undefined || fixture === undefined) throw new Error(`No ${fixtureName} fixture.`);
  return componentPage.open({
    entry,
    theme,
    viewport: { name: 'mobile', width: 375, height: 900 },
    fixtureName,
    fixtureContentHash: fixture.fixtureContentHash,
  });
}

for (const theme of ['light', 'dark'] as const) {
  for (const [fixtureName, outcome, corner] of [
    // The trailing corner: the one the card is moving away from, which stays on screen as the card
    // slides off. Accept is at the inline-start corner and reject at the inline-end corner.
    ['drag-accept', 'accept', 'left'],
    ['drag-reject', 'reject', 'right'],
    ['drag-rtl', 'accept', 'right'],
  ] as const) {
    test(`the ${outcome} stamp sits in the ${corner} corner and covers no text (${fixtureName}, ${theme})`, async ({
      componentPage,
    }) => {
      const page = await open(componentPage, theme, fixtureName);
      const card = page.locator('[data-cinder-decision-card][data-depth="0"]');
      await card.waitFor({ state: 'visible' });
      const stamp = card.locator(`.cinder-decision-card__stamp[data-stamp="${outcome}"]`);
      // The drag fixture holds the pointer down; the stamp's opacity has risen with the offset.
      await expect
        .poll(() => stamp.evaluate((element) => Number(getComputedStyle(element).opacity)))
        .toBeGreaterThan(0.5);

      const cardBox = await box(card);
      const stampBox = await box(stamp);
      // Inside the card (the card is rotated a little, so allow the tilt's few pixels).
      expect(stampBox.bottom).toBeLessThanOrEqual(cardBox.bottom + 6);
      expect(stampBox.top).toBeGreaterThanOrEqual(cardBox.top);
      // In the trailing corner: the half of the card on that side.
      const middle = (cardBox.left + cardBox.right) / 2;
      if (corner === 'right') expect(stampBox.left).toBeGreaterThan(middle - 20);
      else expect(stampBox.right).toBeLessThan(middle + 20);

      // The stamp is whole inside the viewport at the fixture's drag offset (it was clipped off the
      // screen when it sat in the leading corner), and the card is still mostly on screen, so a
      // capture shows the stamp, the card's text and the direction of travel.
      const viewportWidth = page.viewportSize()?.width ?? 375;
      expect(stampBox.left).toBeGreaterThanOrEqual(0);
      expect(stampBox.right).toBeLessThanOrEqual(viewportWidth);
      const visible = Math.min(cardBox.right, viewportWidth) - Math.max(cardBox.left, 0);
      expect(visible / (cardBox.right - cardBox.left)).toBeGreaterThan(0.6);

      // No line of the card's text is under the stamp. Compared in the card's own coordinates (its
      // layout boxes, which ignore the drag's tilt): the tilted bounding box of a wide paragraph
      // grows by tens of pixels and would report an overlap that is not on the page. The stamp's
      // own few degrees of tilt are covered by a 4px margin.
      const local = (locator: Locator) =>
        locator.evaluate((element) => {
          const target = element as HTMLElement;
          return {
            left: target.offsetLeft,
            right: target.offsetLeft + target.offsetWidth,
            top: target.offsetTop,
            bottom: target.offsetTop + target.offsetHeight,
          };
        });
      const stampLocal = await local(stamp);
      const padded = {
        left: stampLocal.left - 4,
        right: stampLocal.right + 4,
        top: stampLocal.top - 4,
        bottom: stampLocal.bottom + 4,
      };
      const texts = card.locator(
        '.cinder-decision-card__eyebrow, .cinder-decision-card__title, .cinder-decision-card__description',
      );
      for (let index = 0; index < (await texts.count()); index += 1) {
        const textLocal = await local(texts.nth(index));
        expect(overlaps(padded, textLocal), `text ${index} is under the stamp`).toBe(false);
      }
    });
  }

  test(`the progress phrase keeps its order under right to left (${theme})`, async ({
    componentPage,
  }) => {
    const page = await open(componentPage, theme, 'drag-rtl');
    const text = page.locator('.cinder-decision-deck__progress-text');
    await text.waitFor({ state: 'visible' });
    // "1 of 3": the 1 is left of the 3 in the rendered line, as in left to right.
    const [one, three] = await text.evaluate((element) => {
      const node = element.querySelector('bdi')?.firstChild;
      if (!(node instanceof Text)) throw new Error('No progress text.');
      const at = (offset: number) => {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        return range.getBoundingClientRect().left;
      };
      return [at(0), at(node.data.length - 1)];
    });
    expect(one!).toBeLessThan(three!);
  });
}
