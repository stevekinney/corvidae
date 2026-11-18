/// <reference lib="dom" />
/**
 * A suggested row's value stays on the title's (or the label's) own line (COR-2441, COR-2326): the
 * word "Suggested" sits on a line of its own above, and the value, which a vertically centred
 * layout once pulled onto the word's line ("Suggested Friday") or between the word and the label,
 * shares the line of the title or label. GroupedListItem holds it at every width; InspectorRow
 * holds it beside the label at 700px and wider, and stacks the value under the label on a phone.
 * Measured in a browser on each component's `suggested` fixture at 375, 768 and 1280, in both
 * themes.
 */

import { loadManifest } from '@lostgradient/testing';
import { expect, type Locator } from '@playwright/test';
import { test } from './component-page-fixture.ts';

const WIDTHS = [
  { name: 'mobile', width: 375, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

/** The vertical centre and the bottom of the first line of text inside an element. */
async function firstLine(
  locator: Locator,
): Promise<{ centre: number; top: number; bottom: number }> {
  return locator.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node !== null && (node.textContent ?? '').trim() === '') node = walker.nextNode();
    if (node === null) throw new Error('No text.');
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getClientRects()[0];
    if (rect === undefined) throw new Error('No line box.');
    return { centre: (rect.top + rect.bottom) / 2, top: rect.top, bottom: rect.bottom };
  });
}

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of WIDTHS) {
    test(`a suggested GroupedListItem keeps its value on the title's line (${theme}, ${viewport.width})`, async ({
      componentPage,
    }) => {
      const entry = loadManifest().find((candidate) => candidate.slug === 'grouped-list-item');
      const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'suggested');
      if (entry === undefined || fixture === undefined) throw new Error('No fixture.');
      const page = await componentPage.open({
        entry,
        theme,
        viewport,
        fixtureName: 'suggested',
        fixtureContentHash: fixture.fixtureContentHash,
      });
      const row = page.locator('.cinder-grouped-list-item[data-cinder-suggested]').first();
      await row.waitFor({ state: 'visible' });
      const word = await firstLine(row.locator('.cinder-grouped-list-item__suggested'));
      const title = await firstLine(row.locator('.cinder-grouped-list-item__title'));
      const value = await firstLine(row.locator('.cinder-grouped-list-item__trailing'));
      // The word is above the title, and the value is on the title's line, not the word's.
      expect(word.bottom).toBeLessThanOrEqual(title.top + 1);
      expect(Math.abs(value.centre - title.centre)).toBeLessThanOrEqual(2);
      expect(Math.abs(value.centre - word.centre)).toBeGreaterThan(6);
    });

    test(`a suggested InspectorRow keeps its value on the label's line (${theme}, ${viewport.width})`, async ({
      componentPage,
    }) => {
      const entry = loadManifest().find((candidate) => candidate.slug === 'inspector-row');
      const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'suggested');
      if (entry === undefined || fixture === undefined) throw new Error('No fixture.');
      const page = await componentPage.open({
        entry,
        theme,
        viewport,
        fixtureName: 'suggested',
        fixtureContentHash: fixture.fixtureContentHash,
      });
      const row = page.locator('.cinder-inspector-row[data-cinder-suggested]').first();
      await row.waitFor({ state: 'visible' });
      const word = await firstLine(row.locator('.cinder-inspector-row__suggested'));
      const label = await firstLine(row.locator('.cinder-inspector-row__label-text'));
      const value = await firstLine(row.locator('.cinder-inspector-row__value'));
      // The word is above the label at every width.
      expect(word.bottom).toBeLessThanOrEqual(label.top + 1);
      if (viewport.width >= 700) {
        // Beside the label: the value shares the label's line, not the word's or a point between.
        expect(Math.abs(value.centre - label.centre)).toBeLessThanOrEqual(2);
        expect(Math.abs(value.centre - word.centre)).toBeGreaterThan(6);
      } else {
        // On a phone the label stacks above the value.
        expect(value.top).toBeGreaterThanOrEqual(label.bottom - 1);
      }
    });
  }
}
