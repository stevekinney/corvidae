import type { Theme } from '@lostgradient/testing';
import { loadManifest, runAxe, VIEWPORTS } from '@lostgradient/testing';

import { expect, test } from './component-page-fixture.ts';

const entries = loadManifest();
const themes: Theme[] = ['light', 'dark'];

for (const theme of themes) {
  test(`ErrorState has no axe violations with and without retry in ${theme}`, async ({
    componentPage,
  }) => {
    const entry = entries.find((candidate) => candidate.slug === 'error-state');
    const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'assertion');
    if (entry === undefined || fixture === undefined) {
      throw new Error('error-state must expose its assertion fixture');
    }
    const viewport = VIEWPORTS.find((candidate) => candidate.name === 'desktop')!;
    const page = await componentPage.open({
      entry,
      theme,
      viewport,
      fixtureName: fixture.name,
      fixtureContentHash: fixture.fixtureContentHash,
    });

    // Three failures (a retry, no retry, and a retry with a second action and a progress line)
    // announce as alerts; the neutral not-found state is a plain group.
    await expect(page.locator('[role="alert"]')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Open Health' })).toHaveCount(1);
    await expect(page.getByText('Show the error details')).toHaveCount(2);

    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('error-state-retries')).toHaveText('Retried 1 times.');

    const buckets = await runAxe(page, {
      slug: entry.slug,
      theme,
      viewport: viewport.name,
      fixture: fixture.name,
    });
    expect(Object.values(buckets).flat()).toEqual([]);
  });
}
