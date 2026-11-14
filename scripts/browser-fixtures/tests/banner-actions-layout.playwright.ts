/// <reference lib="dom" />
/**
 * A Banner's actions sit at the inline end of the message's row, before the dismiss button and
 * centred on the row, when the banner is wide; below 560px of the banner's own width they drop
 * under the message, and `stackActions` gives each its own full-width line on a phone. Measured in
 * a browser on the `actions` fixture at 1280 and 390, in both themes.
 */

import { loadManifest } from '@lostgradient/testing';
import { expect, type Locator } from '@playwright/test';
import { test } from './component-page-fixture.ts';
import { ALIGNMENT_TOLERANCE, boxOf } from './first-line-alignment.ts';

const entry = loadManifest().find((candidate) => candidate.slug === 'banner');
const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'actions');

async function parts(host: Locator) {
  const banner = host.locator('.cinder-banner');
  await banner.locator('.cinder-banner__actions button').first().waitFor({ state: 'visible' });
  const dismiss = banner.locator('.cinder-banner__dismiss');
  return {
    banner: await boxOf(banner),
    content: await boxOf(banner.locator('.cinder-banner__content')),
    actions: await boxOf(banner.locator('.cinder-banner__actions')),
    dismiss: (await dismiss.count()) > 0 ? await boxOf(dismiss) : undefined,
  };
}

/** The actions beside the message, at the banner's inline end, centred on the row. */
async function expectTrailing(host: Locator): Promise<void> {
  const { content, actions, dismiss } = await parts(host);
  expect(actions.left).toBeGreaterThanOrEqual(content.right);
  expect(actions.top).toBeLessThan(content.bottom);
  if (dismiss) expect(actions.right).toBeLessThanOrEqual(dismiss.left);
  const row = {
    top: Math.min(content.top, actions.top),
    bottom: Math.max(content.bottom, actions.bottom),
  };
  expect(Math.abs(actions.center - (row.top + row.bottom) / 2)).toBeLessThanOrEqual(
    ALIGNMENT_TOLERANCE,
  );
}

/** The actions under the message, starting where the words start. */
async function expectUnder(host: Locator): Promise<void> {
  const { content, actions } = await parts(host);
  expect(actions.top).toBeGreaterThanOrEqual(content.bottom);
  expect(Math.abs(actions.left - content.left)).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE);
}

for (const theme of ['light', 'dark'] as const) {
  test(`banner actions trail a wide banner and drop under a narrow one (${theme}, 1280)`, async ({
    componentPage,
  }) => {
    if (entry === undefined || fixture === undefined) throw new Error('No banner actions fixture.');
    const page = await componentPage.open({
      entry,
      theme,
      viewport: { name: 'desktop', width: 1280, height: 900 },
      fixtureName: 'actions',
      fixtureContentHash: fixture.fixtureContentHash,
    });
    await expectTrailing(page.getByTestId('wide'));
    await expectTrailing(page.getByTestId('preset'));
    await expectTrailing(page.getByTestId('stacked'));
    await expectUnder(page.getByTestId('narrow'));
  });

  test(`banner actions drop under the message on a phone, and stack full width (${theme}, 390)`, async ({
    componentPage,
  }) => {
    if (entry === undefined || fixture === undefined) throw new Error('No banner actions fixture.');
    const page = await componentPage.open({
      entry,
      theme,
      viewport: { name: 'mobile', width: 390, height: 844 },
      fixtureName: 'actions',
      fixtureContentHash: fixture.fixtureContentHash,
    });
    for (const id of ['wide', 'preset', 'narrow', 'stacked'])
      await expectUnder(page.getByTestId(id));
    const stacked = page.getByTestId('stacked');
    const { content } = await parts(stacked);
    const buttons = stacked.locator('.cinder-banner__actions button');
    const first = await boxOf(buttons.nth(0));
    const second = await boxOf(buttons.nth(1));
    expect(second.top).toBeGreaterThanOrEqual(first.bottom);
    for (const button of [first, second]) {
      expect(
        Math.abs(button.right - button.left - (content.right - content.left)),
      ).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE);
    }
  });
}
