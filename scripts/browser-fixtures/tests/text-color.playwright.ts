import type { Theme } from '@lostgradient/testing';
import { loadManifest, VIEWPORTS } from '@lostgradient/testing';

import { expect, test } from './component-page-fixture.ts';

const entries = loadManifest();
const themes: Theme[] = ['light', 'dark'];

for (const theme of themes) {
  test(`Text inherits its color from the container in ${theme}`, async ({ componentPage }) => {
    const entry = entries.find((candidate) => candidate.slug === 'text');
    const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'assertion');
    if (entry === undefined || fixture === undefined) {
      throw new Error('text must expose its assertion fixture');
    }
    const page = await componentPage.open({
      entry,
      theme,
      viewport: VIEWPORTS.find((viewport) => viewport.name === 'desktop')!,
      fixtureName: fixture.name,
      fixtureContentHash: fixture.fixtureContentHash,
    });

    for (const testId of ['text-container', 'text-themed-container']) {
      const container = page.getByTestId(testId);
      const containerColor = await container.evaluate((element) => getComputedStyle(element).color);
      const textColors = await container
        .locator('.cinder-text')
        .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).color));

      expect(textColors.length).toBeGreaterThan(0);
      for (const color of textColors) expect(color).toBe(containerColor);
    }

    const themed = await page
      .getByTestId('text-themed-container')
      .evaluate((element) => getComputedStyle(element).color);
    const plain = await page
      .getByTestId('text-container')
      .evaluate((element) => getComputedStyle(element).color);
    expect(themed).not.toBe(plain);
  });
}
