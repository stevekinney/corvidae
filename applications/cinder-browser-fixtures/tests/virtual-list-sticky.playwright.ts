import type { Page } from '@playwright/test';

import { loadManifest } from '@repo/testing';
import { expect, test } from './component-page-fixture.ts';

const desktopViewport = { name: 'desktop', width: 1280, height: 900 } as const;
const lightTheme = 'light' as const;
const entriesBySlug = new Map(loadManifest().map((entry) => [entry.slug, entry] as const));

function getEntry(slug: string) {
  const entry = entriesBySlug.get(slug);
  if (!entry) throw new Error(`Component manifest is missing slug: ${slug}`);
  return entry;
}

test.describe('Sticky headers and keyboard navigation', () => {
  // Everything here needs a real browser. happy-dom computes no layout and no
  // cascade, so `position: sticky` never actually holds a row anywhere — which means
  // the whole model these keys are built on ("the header covers its own height at the
  // leading edge") is unfalsifiable in the unit suite. If the pinned row's rule lost
  // the cascade, or sticky resolved differently than assumed, every keyboard number
  // would be off by a header height and no unit test would notice.
  //
  // The example is 500 rows of 36px in sections of 25, so section headers sit at
  // indexes 0, 25, 50 … and row `n` starts at `36 * n`.
  const mountSelector = '#example-mount-sticky-headers';
  const rowHeight = 36;

  function listLocator(page: Page) {
    return page.locator(`${mountSelector} .cinder-virtual-list`);
  }

  async function offsetWithinList(page: Page, index: number): Promise<number> {
    const listBox = await listLocator(page).boundingBox();
    const rowBox = await page
      .locator(`${mountSelector} [data-cinder-virtual-index="${index}"]`)
      .boundingBox();
    if (listBox === null || rowBox === null) return Number.NaN;
    return Math.round(rowBox.y - listBox.y);
  }

  /**
   * Scrolls the list and waits for the COMPONENT to have caught up, not just the
   * browser.
   *
   * Setting `scrollTop` moves the container immediately, but the component learns
   * about it from a scroll event and re-derives its window a frame later. A key
   * pressed in between resolves its destination from the previous position — off by
   * exactly one row, which is a real race rather than a rounding artifact. It passed
   * on a fast machine and failed on CI, which is the shape of every test that waits
   * for a value it set itself.
   *
   * The probe is a row five below the leading edge: unlike the leading row, which a
   * sticky header holds at the top either way, its position can only be right once
   * the window has re-rendered for this offset.
   */
  async function scrollListTo(page: Page, offset: number): Promise<void> {
    const list = listLocator(page);
    await list.evaluate((element, value) => {
      element.scrollTop = value;
    }, offset);
    await expect
      .poll(async () => list.evaluate((element) => Math.round(element.scrollTop)))
      .toBe(offset);

    const probeIndex = Math.floor(offset / rowHeight) + 5;
    await expect(
      page.locator(`${mountSelector} [data-cinder-virtual-index="${probeIndex}"]`),
    ).toBeVisible();
    await expect
      .poll(async () => offsetWithinList(page, probeIndex))
      .toBe(probeIndex * rowHeight - offset);
  }

  async function pressAndSettle(page: Page, key: string, expected: number): Promise<void> {
    await listLocator(page).focus();
    await page.keyboard.press(key);
    await expect
      .poll(async () => listLocator(page).evaluate((element) => Math.round(element.scrollTop)))
      .toBe(expected);
  }

  test('holds a section header at the leading edge with real CSS', async ({ componentPage }) => {
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    await expect(listLocator(page)).toBeVisible();

    // Well into section 2, so header 50 is held rather than sitting at its own start.
    await scrollListTo(page, rowHeight * 60);

    // The header is painted at the container's own top edge, not at its position in
    // the scrolled content — which is what `position: sticky` is supposed to do and
    // what every keyboard offset in this component assumes.
    const header = page.locator(`${mountSelector} [data-cinder-virtual-index="50"]`);
    await expect(header).toBeVisible();
    await expect.poll(async () => offsetWithinList(page, 50)).toBe(0);
    const headerBox = await header.boundingBox();
    expect(Math.round(headerBox?.height ?? 0)).toBe(rowHeight);
  });

  test('lands an arrow destination below the header rather than under it', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    await expect(listLocator(page)).toBeVisible();

    // Parked exactly where section 2 begins — the offset every step onto a section
    // lands on, and where the header is both the first visible row and the thing
    // covering the leading edge.
    await scrollListTo(page, rowHeight * 50);
    await pressAndSettle(page, 'ArrowDown', rowHeight * 51);

    // Row 52 is the destination — the step passes over header 50 — and it sits
    // immediately below the pinned header rather than beneath it.
    await expect(page.locator(`${mountSelector} [data-cinder-virtual-index="52"]`)).toBeVisible();
    await expect.poll(async () => offsetWithinList(page, 52)).toBe(rowHeight);
  });

  test('moves in both directions from a section boundary', async ({ componentPage }) => {
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    await expect(listLocator(page)).toBeVisible();

    // Neither direction may stall: the header is the first visible row AND the
    // leading-edge occupant, and resolving that wrongly leaves one key dead.
    for (const [key, expected] of [
      ['ArrowDown', rowHeight * 51],
      ['ArrowUp', rowHeight * 48],
    ] as const) {
      await scrollListTo(page, rowHeight * 50);
      await pressAndSettle(page, key, expected);
    }
  });

  test('pages by the rows the header leaves visible', async ({ componentPage }) => {
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    await expect(listLocator(page)).toBeVisible();

    await scrollListTo(page, rowHeight * 50);

    // A 360px viewport over 36px rows fits ten, but the header covers one, so nine
    // are exposed: from row 51 the page reaches row 60, landing it below the header.
    await pressAndSettle(page, 'PageDown', rowHeight * 59);

    await expect(page.locator(`${mountSelector} [data-cinder-virtual-index="60"]`)).toBeVisible();
    await expect.poll(async () => offsetWithinList(page, 60)).toBe(rowHeight);
  });
});

test.describe('Sticky rows on the inline axis, and what assistive technology is told', () => {
  // The accessibility review for this component's keyboard model, in the two places the
  // unit suite cannot reach: the inline axis, and the accessibility tree.
  //
  // The example groups 300 columns every ten, and its headers are deliberately TALLER
  // than the ordinary columns (96px against 64px) — that is the shape in which a pinned
  // header can be clipped by a window sized without it.
  const mountSelector = '#example-mount-horizontal-sticky-headers';
  const columnWidth = 120;

  function listLocator(page: Page) {
    return page.locator(`${mountSelector} .cinder-virtual-list`);
  }

  async function scrollListTo(page: Page, offset: number): Promise<void> {
    const list = listLocator(page);
    await list.evaluate((element, value) => {
      element.scrollLeft = value;
    }, offset);
    await expect
      .poll(async () => list.evaluate((element) => Math.round(element.scrollLeft)))
      .toBe(offset);
    // Wait for the component to have re-derived its window, not merely for the browser
    // to have moved: a key pressed in between resolves from the previous position.
    const probeIndex = Math.floor(offset / columnWidth) + 3;
    await expect(
      page.locator(`${mountSelector} [data-cinder-virtual-index="${probeIndex}"]`),
    ).toBeVisible();
  }

  test('holds a group header at the inline leading edge', async ({ componentPage }) => {
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    await expect(listLocator(page)).toBeVisible();

    // Well into group 5, so header 50 is held rather than sitting at its own start.
    await scrollListTo(page, columnWidth * 55);

    const listBox = await listLocator(page).boundingBox();
    const header = page.locator(`${mountSelector} [data-cinder-virtual-index="50"]`);
    await expect(header).toBeVisible();
    const headerBox = await header.boundingBox();
    expect(Math.abs((headerBox?.x ?? 0) - (listBox?.x ?? 0))).toBeLessThanOrEqual(1);
  });

  test('moves with the arrow keys along the inline axis', async ({ componentPage }) => {
    // The horizontal half of the keyboard matrix. Left and Right are the axis keys
    // here; Up and Down scroll nothing, because the cross axis does not overflow.
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    await expect(listLocator(page)).toBeVisible();

    await scrollListTo(page, columnWidth * 50);
    await listLocator(page).focus();

    await page.keyboard.press('ArrowRight');
    await expect
      .poll(async () => listLocator(page).evaluate((element) => Math.round(element.scrollLeft)))
      .toBe(columnWidth * 51);

    // And the off-axis arrow is left to the browser rather than claimed as movement.
    await page.keyboard.press('ArrowDown');
    await expect
      .poll(async () => listLocator(page).evaluate((element) => Math.round(element.scrollLeft)))
      .toBe(columnWidth * 51);
  });

  test('leaves Alt+Arrow to the browser, where it is back and forward', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    await expect(listLocator(page)).toBeVisible();

    await scrollListTo(page, columnWidth * 50);
    await listLocator(page).focus();

    await page.keyboard.press('Alt+ArrowRight');
    await expect
      .poll(async () => listLocator(page).evaluate((element) => Math.round(element.scrollLeft)))
      .toBe(columnWidth * 50);
  });

  test('exposes the pinned header to assistive technology, in the list and in order', async ({
    componentPage,
  }) => {
    // The announcement half of the review. A screen reader is not scriptable here, but
    // the accessibility TREE is what one reads — so this asserts what is exposed rather
    // than reasoning about it from the DOM, which is what the record previously did.
    const page = await componentPage.open({
      entry: getEntry('virtual-list'),
      theme: lightTheme,
      viewport: desktopViewport,
      fixtureName: 'assertion',
    });
    await expect(listLocator(page)).toBeVisible();

    await scrollListTo(page, columnWidth * 55);
    const header = page.locator(`${mountSelector} [data-cinder-virtual-index="50"]`);
    await expect(header).toBeVisible();

    // Still in the tree once it is pinned, with its text as its accessible name. An
    // `aria-hidden` copy — which an earlier version of this component used — would
    // remove a visible heading from the tree entirely and leave anything focusable
    // inside it reachable but unannounced.
    const snapshot = await header.ariaSnapshot();
    expect(snapshot).toContain('listitem');
    expect(snapshot).toContain('Group 5');

    // The whole list is exposed as one, rather than the window looking like the list.
    expect(await listLocator(page).ariaSnapshot()).toContain('list');

    // Announced by its position in the FULL collection, not in the rendered window.
    await expect(header).toHaveAttribute('aria-posinset', '51');
    await expect(header).toHaveAttribute('aria-setsize', '300');
    await expect(header).toHaveAttribute('role', 'listitem');

    // And read in index order among the mounted rows, pinned or not.
    const indexes = await page
      .locator(`${mountSelector} [data-cinder-virtual-index]`)
      .evaluateAll((nodes) =>
        nodes.map((node) => Number(node.getAttribute('data-cinder-virtual-index'))),
      );
    expect(indexes).toEqual(indexes.toSorted((left, right) => left - right));
    expect(indexes[0]).toBe(50);
  });
});
