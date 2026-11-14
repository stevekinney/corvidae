/// <reference lib="dom" />
/**
 * A Banner's glyph sits on the optical centre of the first line of its message: centred on the
 * capitals (within half a pixel), within a pixel of the line box's centre, and on a whole pixel
 * from the banner's top, so its 2px stroke is not blurred across two rows. happy-dom performs no
 * layout, so this is measured in a browser on the `alignment` fixture, in both themes, at a
 * desktop and a phone width, for the Unreachable and Offline presets and a success banner.
 */

import { loadManifest } from '@lostgradient/testing';
import { expect } from '@playwright/test';
import { test } from './component-page-fixture.ts';
import { ALIGNMENT_TOLERANCE } from './first-line-alignment.ts';

const entry = loadManifest().find((candidate) => candidate.slug === 'banner');
const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'alignment');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1080 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

type GlyphGeometry = {
  /** The glyph's top, from the banner's top edge. */
  glyphTop: number;
  glyphCenter: number;
  /** The centre of the capitals of the first line: the baseline less half a cap height. */
  capCenter: number;
  /** The centre of the first line box. */
  lineCenter: number;
};

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of VIEWPORTS) {
    test(`the banner glyph sits on the first line's capitals (${theme}, ${viewport.name})`, async ({
      componentPage,
    }) => {
      if (entry === undefined || fixture === undefined)
        throw new Error('No banner alignment fixture.');
      const page = await componentPage.open({
        entry,
        theme,
        viewport,
        fixtureName: 'alignment',
        fixtureContentHash: fixture.fixtureContentHash,
      });
      for (const id of ['unreachable', 'offline', 'success']) {
        const banner = page.locator(`[data-testid="${id}"] .cinder-banner`);
        await banner.locator('.cinder-banner__icon svg').waitFor({ state: 'visible' });
        const geometry: GlyphGeometry = await banner.evaluate((root) => {
          const content = root.querySelector('.cinder-banner__content');
          const glyph = root.querySelector('.cinder-banner__icon svg');
          if (!(content instanceof HTMLElement) || glyph === null) throw new Error('No glyph.');
          const first = content.querySelector('.cinder-banner__title') ?? content;
          // A zero-height inline box sits on the baseline; a 1cap one is the capitals' height.
          const baseline = document.createElement('span');
          baseline.style.cssText = 'display:inline-block;inline-size:0;block-size:0';
          const cap = document.createElement('span');
          cap.style.cssText = 'display:inline-block;inline-size:0;block-size:1cap';
          first.prepend(baseline, cap);
          const baselineY = baseline.getBoundingClientRect().bottom;
          const capHeight = cap.getBoundingClientRect().height;
          baseline.remove();
          cap.remove();
          const top = root.getBoundingClientRect().top;
          const box = glyph.getBoundingClientRect();
          const lineTop = content.getBoundingClientRect().top;
          const lineHeight = Number.parseFloat(getComputedStyle(content).lineHeight);
          return {
            glyphTop: box.top - top,
            glyphCenter: box.top + box.height / 2 - top,
            capCenter: baselineY - capHeight / 2 - top,
            lineCenter: lineTop + lineHeight / 2 - top,
          };
        });
        expect(Math.abs(geometry.glyphCenter - geometry.capCenter), id).toBeLessThanOrEqual(0.5);
        expect(Math.abs(geometry.glyphCenter - geometry.lineCenter), id).toBeLessThanOrEqual(
          ALIGNMENT_TOLERANCE,
        );
        expect(geometry.glyphTop % 1, id).toBe(0);
      }
    });
  }
}
