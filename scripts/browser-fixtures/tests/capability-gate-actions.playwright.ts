/// <reference lib="dom" />
/**
 * A CapabilityGate never restyles the Buttons in its actions: on every tint, in both themes, its
 * primary action computes to exactly the fill, text colour, weight, size and opacity of a primary
 * Button on the page. The gate once hand-rolled its own button styles, and its grant action read
 * as disabled.
 */

import { loadManifest } from '@lostgradient/testing';
import { expect, type Locator } from '@playwright/test';
import { test } from './component-page-fixture.ts';

const entry = loadManifest().find((candidate) => candidate.slug === 'capability-gate');
const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'actions');

async function face(button: Locator) {
  return button.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      color: style.color,
      weight: style.fontWeight,
      size: style.fontSize,
      opacity: style.opacity,
      height: element.getBoundingClientRect().height,
    };
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`a gate's primary action is a real primary Button on every tint (${theme})`, async ({
    componentPage,
  }) => {
    if (entry === undefined || fixture === undefined)
      throw new Error('No capability gate fixture.');
    const page = await componentPage.open({
      entry,
      theme,
      viewport: { name: 'desktop', width: 1280, height: 900 },
      fixtureName: 'actions',
      fixtureContentHash: fixture.fixtureContentHash,
    });
    const reference = await face(page.getByTestId('reference').getByRole('button'));
    for (const state of ['unavailable', 'permission-needed', 'permission-denied', 'supported']) {
      const primary = page.getByTestId(state).getByRole('button', { name: 'Allow microphone' });
      expect(await face(primary), state).toEqual(reference);
    }
  });
}
