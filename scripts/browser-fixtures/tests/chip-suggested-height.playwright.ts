/// <reference lib="dom" />
/**
 * A suggested Chip is the same height as a plain one, and its label sits on the same baseline
 * (COR-2441): the sparkle glyph that tells a sighted person apart from colour alone must not
 * lengthen the chip's line. Measured in a browser on the `suggested` fixture, in both themes, for
 * the display chip and the toggle chip.
 */

import { loadManifest } from '@lostgradient/testing';
import { expect } from '@playwright/test';
import { test } from './component-page-fixture.ts';

const entry = loadManifest().find((candidate) => candidate.slug === 'chip');
const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'suggested');

for (const theme of ['light', 'dark'] as const) {
  test(`a suggested chip matches a plain chip's height and baseline (${theme})`, async ({
    componentPage,
  }) => {
    if (entry === undefined || fixture === undefined) throw new Error('No chip suggested fixture.');
    const page = await componentPage.open({
      entry,
      theme,
      viewport: { name: 'desktop', width: 1280, height: 900 },
      fixtureName: 'suggested',
      fixtureContentHash: fixture.fixtureContentHash,
    });
    for (const [suggestedId, plainId] of [
      ['suggested', 'plain'],
      ['suggested-toggle', 'plain-toggle'],
    ] as const) {
      const measure = async (id: string) =>
        page
          .getByTestId(id)
          .locator('.cinder-chip')
          .evaluate((chip) => {
            const label = chip.querySelector('.cinder-chip__label');
            if (!(label instanceof HTMLElement)) throw new Error('No label.');
            // A zero-height inline box on the label's first line sits on its baseline.
            const probe = document.createElement('span');
            probe.style.cssText = 'display:inline-block;inline-size:0;block-size:0';
            label.append(probe);
            const baseline =
              probe.getBoundingClientRect().bottom - chip.getBoundingClientRect().top;
            probe.remove();
            // The chip's own baseline as an inline box: a zero-height probe on a line's baseline
            // beside a copy of the chip. The chip's baseline comes from its first flex item, so a
            // glyph ahead of the label would move a chip off the line it sits on.
            const line = document.createElement('div');
            const lineProbe = document.createElement('span');
            lineProbe.style.cssText = 'display:inline-block;inline-size:0;block-size:0';
            const copy = chip.cloneNode(true) as HTMLElement;
            line.append(lineProbe, copy);
            document.body.append(line);
            const onLine =
              copy.getBoundingClientRect().top - lineProbe.getBoundingClientRect().bottom;
            line.remove();
            return { height: chip.getBoundingClientRect().height, baseline, onLine };
          });
      const suggested = await measure(suggestedId);
      const plain = await measure(plainId);
      expect(suggested.height, `${suggestedId} height`).toBeCloseTo(plain.height, 1);
      expect(suggested.baseline, `${suggestedId} baseline`).toBeCloseTo(plain.baseline, 1);
      expect(suggested.onLine, `${suggestedId} position on a line`).toBeCloseTo(plain.onLine, 1);
    }
  });
}
