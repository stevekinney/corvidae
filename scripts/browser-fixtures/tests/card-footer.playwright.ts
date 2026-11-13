/// <reference lib="dom" />
/**
 * A Card's footer is the last row of its content: it draws no divider, the gap from the words to
 * the action is one normal content gap (the card's padding, 16px), the action sits the card's
 * padding in from the inline end and the bottom, and the footer is no taller than the action plus
 * that bottom padding. A muted footer separates itself by its fill, never a line. Both themes.
 */

import { loadManifest } from '@lostgradient/testing';
import { expect, type Locator } from '@playwright/test';
import { test } from './component-page-fixture.ts';

const entry = loadManifest().find((candidate) => candidate.slug === 'card');
const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'footer');
const PADDING = 16;

async function measure(host: Locator) {
  return host.evaluate((root) => {
    const card = root.querySelector('.cinder-card');
    const footer = root.querySelector('.cinder-card__footer');
    const prose = root.querySelector('p');
    const button = footer?.querySelector('button');
    if (!card || !footer || !prose || !button) throw new Error('Missing part.');
    const box = (element: Element) => element.getBoundingClientRect();
    const style = getComputedStyle(footer);
    // The card's padding is measured from inside its own edge, whether or not it draws one.
    const cardStyle = getComputedStyle(card);
    const inner = {
      bottom: box(card).bottom - Number.parseFloat(cardStyle.borderBottomWidth),
      right: box(card).right - Number.parseFloat(cardStyle.borderRightWidth),
    };
    return {
      border: style.borderTopWidth,
      background: style.backgroundColor,
      proseToButton: box(button).top - box(prose).bottom,
      buttonToBottom: inner.bottom - box(button).bottom,
      buttonToEnd: inner.right - box(button).right,
      footerHeight: box(footer).height,
      buttonHeight: box(button).height,
    };
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`a card footer is the last row of the content, with no divider (${theme})`, async ({
    componentPage,
  }) => {
    if (entry === undefined || fixture === undefined) throw new Error('No card footer fixture.');
    const page = await componentPage.open({
      entry,
      theme,
      viewport: { name: 'desktop', width: 1280, height: 900 },
      fixtureName: 'footer',
      fixtureContentHash: fixture.fixtureContentHash,
    });
    await page.getByTestId('danger').locator('button').waitFor();
    for (const id of ['danger', 'default']) {
      const result = await measure(page.getByTestId(id));
      expect(result.border, `${id} divider`).toBe('0px');
      expect(result.proseToButton, `${id} words to action`).toBeCloseTo(PADDING, 0);
      expect(result.buttonToBottom, `${id} action to bottom`).toBeCloseTo(PADDING, 0);
      expect(result.buttonToEnd, `${id} action to end`).toBeCloseTo(PADDING, 0);
      expect(result.footerHeight, `${id} footer height`).toBeCloseTo(
        result.buttonHeight + PADDING,
        0,
      );
    }
    const muted = await measure(page.getByTestId('muted'));
    expect(muted.border).toBe('0px');
    expect(muted.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(muted.footerHeight).toBeCloseTo(muted.buttonHeight + 2 * PADDING, 0);
  });
}
