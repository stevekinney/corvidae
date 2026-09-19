/// <reference lib="dom" />
/**
 * Visual regression for SideNavigation focus-ring clipping and bleed in grouped
 * navigation (ticket 649944d1).
 *
 * The group trigger and every vertical nav item are `inline-size: 100%` and
 * full-bleed to the SideNavigation container edges. With the previous OUTSET
 * ring (`var(--_cinder-focus-ring-shadow)` — offset 1px + width 3px) the ring
 * painted 4px past the border box on every side: it bled past the container
 * boundary (clipped where an app sidebar sets `overflow: hidden`) and, for the
 * trigger, 4px down into the active "Phoenix" row whose `--cinder-surface-inset`
 * background occupies those same pixels — flattening the focus signal against
 * selection.
 *
 * This spec drives the component with REAL KEYBOARD navigation (programmatic
 * .focus() does NOT engage `:focus-visible` in Chromium — proven below by
 * asserting `element.matches(':focus-visible')` only after a Tab walk) and
 * proves the post-fix Strategy B-inset behavior:
 *   1. Focused group trigger paints an INSET ring in the resolved ring color,
 *      bounded by its own border box (no overhang past the nav's right edge
 *      even though the trigger reaches that edge — an outset ring WOULD
 *      overhang).
 *   2. The inset ring does not cross the trigger's bottom edge into the active
 *      "Phoenix" row directly below it.
 *   3. The focused active "Phoenix" item shows the inset ring AND its active
 *      affordances simultaneously — the surface-inset background fill and the
 *      inline-start accent bar — proving focus and selection read distinctly.
 *
 * Color comparisons round-trip through the browser (resolve the authored token
 * on a probe, read the computed value) so both sides are normalized rgb()/oklch
 * strings, never authored token text against computed values.
 */

import type { ComponentEntry, Theme, Viewport } from '@corvidae/testing';
import { loadManifest, VIEWPORTS } from '@corvidae/testing';
import type { Page } from '@playwright/test';
import { expect, test } from './component-page-fixture.ts';

const sideNavigationEntry: ComponentEntry =
  loadManifest().find((entry) => entry.slug === 'side-navigation') ??
  (() => {
    throw new Error('Cached testing manifest does not include slug "side-navigation".');
  })();
const desktop: Viewport =
  VIEWPORTS.find((viewport) => viewport.name === 'desktop') ??
  (() => {
    throw new Error('Desktop viewport fixture is missing.');
  })();

// Browsers can return fractional pixel values for box metrics; match within a
// sub-pixel tolerance.
const PIXEL_TOLERANCE = 0.5;

const TRIGGER_SELECTOR = '.cinder-side-navigation-group__trigger';
const ACTIVE_ITEM_SELECTOR = ".cinder-navigation-item[data-variant='vertical'][data-active='true']";

// The snapshot page renders EVERY example for the component, each into its own
// `#example-mount-<scenario>` container. The `basic` example owns the "Projects"
// group and the active "Phoenix" item this suite measures; the `docs-sidebar`
// example ALSO renders an active item ("Introduction"). A page-wide `.first()`
// would therefore mispair the "Projects" trigger against docs-sidebar's active
// item — and which active item is first in the DOM varies with render order
// under load. Scope every query to the `basic` example container so the
// measurements always come from the same example.
const BASIC_EXAMPLE = '#example-mount-basic';

async function openSideNavigation(componentPage: {
  open(args: {
    entry: ComponentEntry;
    theme: Theme;
    viewport: Viewport;
    fixtureName: string;
  }): Promise<Page>;
}): Promise<Page> {
  const page = await componentPage.open({
    entry: sideNavigationEntry,
    theme: 'light',
    viewport: desktop,
    fixtureName: 'assertion',
  });
  await page.waitForSelector(TRIGGER_SELECTOR, { state: 'visible' });
  await page.waitForFunction((selector) => {
    const element = document.querySelector(selector);
    return element instanceof HTMLElement && element.getBoundingClientRect().height > 0;
  }, TRIGGER_SELECTOR);
  return page;
}

/**
 * Resolve an authored CSS token (e.g. `var(--cinder-ring-color)`'s value) to a
 * browser-computed color string by painting it onto a probe element. Both sides
 * of a color comparison then come out of the same engine.
 */
async function resolveTokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.append(probe);
    try {
      return getComputedStyle(probe).color;
    } finally {
      probe.remove();
    }
  }, token);
}

/**
 * Resolve any CSS color string to its alpha channel, in the browser. cinder
 * tokens are authored in oklch(), so a naive rgb() regex would choke; painting
 * the color onto a 1x1 canvas normalizes every color space to an rgba sample.
 */
async function colorAlpha(page: Page, color: string): Promise<number> {
  return page.evaluate((value) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) throw new Error(`2d canvas context unavailable resolving color: ${value}`);
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    return (context.getImageData(0, 0, 1, 1).data[3] ?? 0) / 255;
  }, color);
}

/**
 * Reset focus to the document body, then walk Tab (capped) until `locator` is
 * the active element. Returns once focus lands; throws via the caller's
 * subsequent assertion if it never does.
 */
async function tabUntilFocused(page: Page, locator: ReturnType<Page['locator']>): Promise<boolean> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.body.focus();
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await page.keyboard.press('Tab');
    const landed = await locator.evaluate((element) => element === document.activeElement);
    if (landed) return true;
  }
  return false;
}

test.describe('SideNavigation — grouped focus ring is inset and unclipped', () => {
  test('group trigger: keyboard focus paints a complete inset ring with no overhang or neighbor bleed', async ({
    componentPage,
  }) => {
    const page = await openSideNavigation(componentPage);
    // Scope to the `basic` example so the "Projects" trigger and the active
    // "Phoenix" item are always measured from the SAME example (see
    // BASIC_EXAMPLE note).
    const example = page.locator(BASIC_EXAMPLE);

    // The "Projects" group is the trigger that owns the active "Phoenix" item.
    const trigger = example.locator(TRIGGER_SELECTOR, { hasText: 'Projects' }).first();
    await expect(trigger).toBeVisible();

    // Real keyboard navigation — programmatic .focus() does NOT engage
    // :focus-visible in Chromium, which is the pseudo-class the ring keys off.
    const landed = await tabUntilFocused(page, trigger);
    expect(landed, 'Tab walk should land on the Projects group trigger').toBe(true);
    await expect(trigger).toBeFocused();

    const ringColor = await resolveTokenColor(page, '--cinder-ring-color');

    // The SideNavigation root is the container the trigger is full-bleed against.
    const nav = example.locator('.cinder-side-navigation').first();
    const navBox = await nav.boundingBox();
    expect(navBox).not.toBeNull();

    // Read the trigger box AND the active item's top in a SINGLE evaluate. The
    // bleed check below compares active.top against trigger.bottom; sampling them
    // in two separate evaluate() calls means two CDP round-trips, each snapshotting
    // whatever scroll/layout state the page is in at that instant. Keyboard focus
    // can scroll the nav between the two trips, shifting the coordinate frame so
    // the two rects no longer share an origin and the comparison reads a phantom
    // ~6px offset. One evaluate = one layout frame = scroll-stable comparison.
    // (Do NOT re-split these reads — that reintroduces the frame-shift flake.)
    const measurement = await trigger.evaluate((element, activeSelector) => {
      if (!(element instanceof HTMLElement)) throw new Error('Expected an HTMLElement trigger.');
      const styles = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const activeItem = element.closest('.cinder-side-navigation')?.querySelector(activeSelector);
      return {
        matchesFocusVisible: element.matches(':focus-visible'),
        boxShadow: styles.boxShadow,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        top: rect.top,
        activeTop: activeItem ? activeItem.getBoundingClientRect().top : null,
      };
    }, ACTIVE_ITEM_SELECTOR);

    // (a) Real keyboard focus engaged :focus-visible.
    expect(measurement.matchesFocusVisible).toBe(true);

    // (b) The ring is the INSET single-band ring in the resolved ring color —
    // computed box-shadow serializes the `inset` keyword. The pre-fix OUTSET
    // recipe has no `inset` keyword, so this assertion fails on pre-fix code.
    expect(measurement.boxShadow).not.toBe('none');
    expect(measurement.boxShadow).toContain('inset');
    expect(measurement.boxShadow).toContain(ringColor);

    // The inset ring is a single layer (no offset band). The pre-fix outset
    // ring is two layers (offset-color band + ring-color band). Count top-level
    // comma-separated layers; computed colors use space-separated channels, so
    // the only top-level commas separate layers.
    const layerCount = measurement.boxShadow.split(/,(?![^(]*\))/).length;
    expect(layerCount, 'inset ring is a single box-shadow layer').toBe(1);

    // (c) The trigger reaches the nav's right edge (it is full-bleed), proving
    // an OUTSET ring WOULD overhang the container — yet the painted ring stays
    // within the element box because it is inset.
    expect(measurement.right).toBeLessThanOrEqual(navBox!.x + navBox!.width + PIXEL_TOLERANCE);
    expect(
      Math.abs(measurement.right - (navBox!.x + navBox!.width)),
      'trigger reaches the nav right edge (full-bleed)',
    ).toBeLessThanOrEqual(2);

    // (d) No neighbor bleed: the active item sits directly below the trigger.
    // An inset ring is bounded by trigger.bottom, so it cannot reach into the
    // active row. Assert the active item's top is at/below the trigger bottom
    // (they are adjacent) — the inset ring lives entirely above that boundary.
    // `activeTop` was sampled in the same evaluate as `bottom`, so the two rects
    // share a layout frame and the comparison is scroll-stable.
    expect(
      measurement.activeTop,
      'basic example should contain the active item below the trigger',
    ).not.toBeNull();
    const activeTop = measurement.activeTop;
    if (activeTop === null) throw new Error('Expected an active item measurement.');
    expect(activeTop).toBeGreaterThanOrEqual(measurement.bottom - PIXEL_TOLERANCE);
  });

  test('active item: keyboard focus shows the inset ring AND the active background + accent bar together', async ({
    componentPage,
  }) => {
    const page = await openSideNavigation(componentPage);
    // Scope to the `basic` example: `docs-sidebar` also renders an active item,
    // so a page-wide `.first()` could resolve the wrong example's row.
    const active = page.locator(BASIC_EXAMPLE).locator(ACTIVE_ITEM_SELECTOR).first();
    await expect(active).toBeVisible();
    await expect(active).toHaveText('Phoenix');

    const landed = await tabUntilFocused(page, active);
    expect(landed, 'Tab walk should land on the active Phoenix item').toBe(true);
    await expect(active).toBeFocused();

    const ringColor = await resolveTokenColor(page, '--cinder-ring-color');
    const accentColor = await resolveTokenColor(page, '--cinder-accent-solid');

    const measurement = await active.evaluate((element) => {
      if (!(element instanceof HTMLElement)) throw new Error('Expected an HTMLElement item.');
      const styles = getComputedStyle(element);
      return {
        matchesFocusVisible: element.matches(':focus-visible'),
        boxShadow: styles.boxShadow,
        backgroundColor: styles.backgroundColor,
        borderInlineStartColor: styles.borderInlineStartColor,
      };
    });

    // Real keyboard focus engaged :focus-visible.
    expect(measurement.matchesFocusVisible).toBe(true);

    // Focus signal: the inset ring in the resolved ring color.
    expect(measurement.boxShadow).not.toBe('none');
    expect(measurement.boxShadow).toContain('inset');
    expect(measurement.boxShadow).toContain(ringColor);
    const layerCount = measurement.boxShadow.split(/,(?![^(]*\))/).length;
    expect(layerCount, 'inset ring is a single box-shadow layer').toBe(1);

    // Selection signal #1: the surface-inset background fill is still painted
    // (non-transparent) under the focused row — focus does not cover it.
    expect(
      await colorAlpha(page, measurement.backgroundColor),
      'active item keeps its surface-inset background while focused',
    ).toBeGreaterThan(0);

    // Selection signal #2: the inline-start accent bar is the resolved accent
    // color — a different channel from the ring, so focus and selection are
    // simultaneously present and distinct.
    expect(measurement.borderInlineStartColor).toBe(accentColor);
  });
});
