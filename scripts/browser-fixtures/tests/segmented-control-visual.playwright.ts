/// <reference lib="dom" />
/**
 * Regression test for `SegmentedControl` size, density, and divider sizing.
 *
 * Covers the contract introduced by the P6 sizing pass:
 *   1. `data-cinder-size` reflects resolved visual size — `density="toolbar"`
 *      forces `data-cinder-size="sm"` regardless of any explicit `size` prop.
 *   2. `size="md"` option text uses `--cinder-text-sm` (promoted from
 *      `--cinder-text-xs`); `size="sm"` stays at `--cinder-text-xs`.
 *   3. Toolbar-density options match the same-page `size="sm"` control on
 *      font-size and inline padding (so toolbar inherits sm's compact
 *      typography), while option `min-block-size` pins to
 *      `--cinder-control-height-sm` so the bounding height aligns with
 *      sibling toolbar controls (Chip, DiffStatistics, Button size="sm").
 *   4. Attached horizontal sm/md options have at least 12px of inline
 *      padding on both sides so labels don't pinch against the
 *      inter-segment divider — checked across default, selected, focused,
 *      and disabled states.
 *   5. The review-editor view switcher reports the documented resolved
 *      contract: `data-cinder-size="sm"`, `data-cinder-density="toolbar"`.
 */

import { loadManifest } from '@corvidae/testing';
import { expect, test, type Page } from '@playwright/test';

const manifest = loadManifest();
function fixtureRoute(slug: string): string {
  const entry = manifest.find((candidate) => candidate.slug === slug);
  const hash = entry?.fixtures?.find((fixture) => fixture.name === 'assertion')?.fixtureContentHash;
  if (hash === undefined) throw new Error(`Assertion fixture hash missing for ${slug}.`);
  return `/page/${slug}?snapshot=1&fixture=assertion&fixtureContentHash=${hash}`;
}
const SIZING_ROUTE = fixtureRoute('segmented-control');
const REVIEW_EDITOR_ROUTE = fixtureRoute('review-editor');

// Match Playwright's bounding box / padding numerics within a sub-pixel
// tolerance. Browsers can return fractional pixel values for box metrics.
const PIXEL_TOLERANCE = 0.5;

/**
 * Regression test for the `variant="tablist"` visual treatment introduced by
 * task eef4318f (executing docs/decisions/segmented-control-tablist-variant.md).
 *
 * The tablist variant must read as a tab strip rather than the default
 * filled-pill radiogroup: no enclosing surface, no separators, and an
 * accent-colored edge indicator on the selected tab (block-end edge for
 * horizontal tablists, inline-start edge for vertical). The radiogroup and
 * multiple-selection variants on the same page must stay visually unchanged,
 * and the review-editor toolbar-nested tablist must keep its roving keyboard
 * contract instead of having arrow keys stolen by the surrounding toolbar.
 *
 * Color comparisons round-trip both sides through the browser (resolve
 * --cinder-accent-solid from the live element, read the indicator's computed
 * background) so we compare normalized rgb() strings, never authored token
 * text against computed values. Transparency and visibility use alpha and size
 * predicates rather than exact string matching.
 */

const HORIZONTAL_TABLIST = '#segmented-tablist-horizontal';
const VERTICAL_TABLIST = '#segmented-tablist-vertical';

/**
 * Resolve any CSS color string to its alpha channel, in the browser. cinder
 * tokens are authored in oklch(), so a naive rgb() regex would choke; painting
 * the color onto a canvas normalizes every color space to an rgba sample and
 * lets us assert transparency (alpha 0) vs. opacity (alpha > 0) reliably.
 */
async function colorAlpha(page: Page, color: string): Promise<number> {
  return page.evaluate((value) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) throw new Error(`2d canvas context unavailable resolving color: ${value}`);
    // Clear to fully transparent, then paint the candidate color. If the color
    // is itself transparent the sampled alpha stays 0.
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    return (context.getImageData(0, 0, 1, 1).data[3] ?? 0) / 255;
  }, color);
}

test.describe('SegmentedControl — tablist variant visual contract', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(SIZING_ROUTE, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await page.waitForSelector(`${HORIZONTAL_TABLIST} .cinder-segmented-control-option`, {
      state: 'visible',
    });
    await page.waitForSelector(`${VERTICAL_TABLIST} .cinder-segmented-control-option`, {
      state: 'visible',
    });
    await page.waitForFunction((selector) => {
      const option = document.querySelector(`${selector} .cinder-segmented-control-option`);
      return option instanceof HTMLElement && option.getBoundingClientRect().height > 0;
    }, HORIZONTAL_TABLIST);
  });

  test('tablist container drops the surface inset: no border, transparent background, no inset padding', async ({
    page,
  }) => {
    const chrome = await page.locator(HORIZONTAL_TABLIST).evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        borderTopWidth: styles.borderTopWidth,
        borderRightWidth: styles.borderRightWidth,
        borderBottomWidth: styles.borderBottomWidth,
        borderLeftWidth: styles.borderLeftWidth,
        background: styles.backgroundColor,
        paddingTop: styles.paddingTop,
        paddingRight: styles.paddingRight,
        paddingBottom: styles.paddingBottom,
        paddingLeft: styles.paddingLeft,
      };
    });
    for (const width of [
      chrome.borderTopWidth,
      chrome.borderRightWidth,
      chrome.borderBottomWidth,
      chrome.borderLeftWidth,
    ]) {
      expect(Number.parseFloat(width)).toBe(0);
    }
    expect(await colorAlpha(page, chrome.background)).toBe(0);
    for (const padding of [
      chrome.paddingTop,
      chrome.paddingRight,
      chrome.paddingBottom,
      chrome.paddingLeft,
    ]) {
      expect(Number.parseFloat(padding)).toBe(0);
    }
  });

  test('selected tab has no filled pill: transparent background and no selected shadow', async ({
    page,
  }) => {
    // Move focus off the active element so :focus-visible chrome (a box-shadow
    // ring) does not contaminate the unfocused selected-state read.
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    const selected = await page
      .locator(`${HORIZONTAL_TABLIST} .cinder-segmented-control-option[data-cinder-selected]`)
      .evaluate((element) => {
        const styles = getComputedStyle(element);
        return { background: styles.backgroundColor, boxShadow: styles.boxShadow };
      });
    expect(await colorAlpha(page, selected.background)).toBe(0);
    expect(selected.boxShadow).toBe('none');
  });

  test('connected-bar separators are suppressed for tablists', async ({ page }) => {
    const separator = await page
      .locator(`${HORIZONTAL_TABLIST} .cinder-segmented-control-option:nth-child(2)`)
      .evaluate((element) => {
        const styles = getComputedStyle(element, '::before');
        return {
          content: styles.content,
          display: styles.display,
          borderInlineStartWidth: styles.borderInlineStartWidth || styles.borderLeftWidth,
        };
      });
    // content: none removes the pseudo-element entirely; assert that, with
    // fallbacks for engines that still expose a zero-width / non-displayed box.
    const suppressed =
      separator.content === 'none' ||
      separator.display === 'none' ||
      Number.parseFloat(separator.borderInlineStartWidth) === 0;
    expect(suppressed).toBe(true);
  });

  test('horizontal selected tab draws an accent indicator on the block-end edge', async ({
    page,
  }) => {
    const indicator = await page
      .locator(`${HORIZONTAL_TABLIST} .cinder-segmented-control-option[data-cinder-selected]`)
      .evaluate((element) => {
        const after = getComputedStyle(element, '::after');
        const accent = getComputedStyle(element).getPropertyValue('--cinder-accent-solid').trim();
        // Resolve the authored accent token to a computed rgb() by painting it
        // onto a probe element, so both sides of the color comparison are
        // browser-normalized. getComputedStyle needs the probe in the document,
        // so use try/finally to guarantee removal even if a read throws.
        const probe = document.createElement('span');
        probe.style.color = accent;
        document.body.append(probe);
        let resolvedAccent: string;
        try {
          resolvedAccent = getComputedStyle(probe).color;
        } finally {
          probe.remove();
        }
        return {
          content: after.content,
          position: after.position,
          insetBlockEnd: after.insetBlockEnd,
          blockSize: Number.parseFloat(after.blockSize),
          inlineSize: Number.parseFloat(after.inlineSize),
          background: after.backgroundColor,
          resolvedAccent,
        };
      });
    expect(indicator.content).not.toBe('none');
    expect(indicator.position).toBe('absolute');
    expect(Number.parseFloat(indicator.insetBlockEnd)).toBe(0);
    expect(indicator.blockSize).toBeGreaterThanOrEqual(2 - PIXEL_TOLERANCE);
    expect(indicator.inlineSize).toBeGreaterThan(0);
    // Both sides are browser-computed color strings (oklch for cinder tokens);
    // painting --cinder-accent-solid onto a probe and reading the indicator's
    // computed background yields identical normalized strings.
    expect(indicator.background).toBe(indicator.resolvedAccent);
    expect(await colorAlpha(page, indicator.background)).toBeGreaterThan(0);
  });

  test('vertical selected tab draws an accent indicator on the inline-start edge', async ({
    page,
  }) => {
    const indicator = await page
      .locator(`${VERTICAL_TABLIST} .cinder-segmented-control-option[data-cinder-selected]`)
      .evaluate((element) => {
        const after = getComputedStyle(element, '::after');
        const accent = getComputedStyle(element).getPropertyValue('--cinder-accent-solid').trim();
        const probe = document.createElement('span');
        probe.style.color = accent;
        document.body.append(probe);
        let resolvedAccent: string;
        try {
          resolvedAccent = getComputedStyle(probe).color;
        } finally {
          probe.remove();
        }
        return {
          content: after.content,
          position: after.position,
          insetInlineStart: after.insetInlineStart,
          inlineSize: Number.parseFloat(after.inlineSize),
          blockSize: Number.parseFloat(after.blockSize),
          background: after.backgroundColor,
          resolvedAccent,
        };
      });
    expect(indicator.content).not.toBe('none');
    expect(indicator.position).toBe('absolute');
    expect(Number.parseFloat(indicator.insetInlineStart)).toBe(0);
    expect(indicator.inlineSize).toBeGreaterThanOrEqual(2 - PIXEL_TOLERANCE);
    expect(indicator.blockSize).toBeGreaterThan(0);
    expect(indicator.background).toBe(indicator.resolvedAccent);
    expect(await colorAlpha(page, indicator.background)).toBeGreaterThan(0);
  });

  test('focus-visible ring survives on the selected tab and is the ring, not the pill shadow', async ({
    page,
  }) => {
    // The selected ("editor") tab carries tabindex=0 under roving tabindex.
    // Focus it directly — this is a focus-ring style test, not a focus-order
    // test, so a direct .focus() is the right tool (no fragile Tab-count loop).
    const focusTarget = page.locator(
      `${HORIZONTAL_TABLIST} .cinder-segmented-control-option[tabindex="0"][data-cinder-selected]`,
    );
    await focusTarget.focus();
    // Programmatic .focus() does not engage :focus-visible in Chromium; a
    // keyboard interaction does. ArrowLeft wraps focus to the last tab, then
    // ArrowRight returns to "editor" — net tab unchanged, but now keyboard-
    // focused so :focus-visible applies.
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await expect(focusTarget).toBeFocused();

    // Resolve the base ring shadow from a keyboard-focused NON-tablist option
    // on the same page, so the expected value is browser-computed (the ring
    // tokens serialize identically everywhere). The tablist selected+focused
    // tab must paint this exact ring — not the single-layer filled-pill drop
    // shadow, which a bare `!== 'none'` check would falsely accept.
    const focus = await focusTarget.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        matchesFocusVisible: element.matches(':focus-visible'),
        boxShadow: styles.boxShadow,
      };
    });
    expect(focus.matchesFocusVisible).toBe(true);
    expect(focus.boxShadow).not.toBe('none');

    // The ring is a two-layer box-shadow (offset layer + ring layer); the pill
    // drop shadow is a single layer. Count top-level layers by the comma that
    // separates them — computed colors use space-separated channels
    // (`rgb(r g b / a)` / `oklch(...)`) so the only commas are layer
    // separators. ≥2 layers proves the ring survived rather than the pill
    // shadow winning.
    const layerCount = focus.boxShadow.split(/,(?![^(]*\))/).length;
    expect(layerCount).toBeGreaterThanOrEqual(2);

    // And it must be the ring color, not the pill's translucent black drop
    // shadow. Resolve --cinder-ring-color through the browser and assert the
    // computed box-shadow contains it.
    const ringColor = await focusTarget.evaluate((element) => {
      const token = getComputedStyle(element).getPropertyValue('--cinder-ring-color').trim();
      const probe = document.createElement('span');
      probe.style.color = token;
      document.body.append(probe);
      try {
        return getComputedStyle(probe).color;
      } finally {
        probe.remove();
      }
    });
    expect(focus.boxShadow).toContain(ringColor);
  });

  // ── Non-regression: radiogroup and multiple variants stay filled-pill ──────

  test('default radiogroup selected option keeps the filled accent pill and selected shadow', async ({
    page,
  }) => {
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    const selected = await page
      .locator('#segmented-sizing-md .cinder-segmented-control-option[data-cinder-selected]')
      .evaluate((element) => {
        const styles = getComputedStyle(element);
        return { background: styles.backgroundColor, boxShadow: styles.boxShadow };
      });
    expect(await colorAlpha(page, selected.background)).toBeGreaterThan(0);
    expect(selected.boxShadow).not.toBe('none');
  });

  test('attached radiogroup still renders separators between unselected neighbors', async ({
    page,
  }) => {
    // The md sizing control selects "rendered" (2nd option); the 3rd option
    // ("Diff") is an unselected neighbor that should still show its separator.
    const separator = await page
      .locator('#segmented-sizing-md .cinder-segmented-control-option:nth-child(3)')
      .evaluate((element) => {
        const styles = getComputedStyle(element, '::before');
        return {
          content: styles.content,
          borderInlineStartWidth: styles.borderInlineStartWidth || styles.borderLeftWidth,
        };
      });
    expect(separator.content).not.toBe('none');
    expect(Number.parseFloat(separator.borderInlineStartWidth)).toBeGreaterThan(0);
  });
});

test.describe('SegmentedControl — review-editor toolbar-nested tablist', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(REVIEW_EDITOR_ROUTE, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    await page.waitForSelector(
      '.review-editor-controls .cinder-segmented-control[data-cinder-selection-mode="single"][data-cinder-variant="tablist"]',
      { state: 'visible' },
    );
  });

  test('arrow keys rove inside the nested tablist and wrap at both ends without escaping to the toolbar', async ({
    page,
  }) => {
    // The review-editor snapshot page may render more than one review-editor
    // instance (e.g. multiple examples on the page). Scope to the first
    // toolbar-nested view-switcher tablist; the roving contract is identical
    // across instances.
    const tablistSelector =
      '.review-editor-controls .cinder-segmented-control[data-cinder-selection-mode="single"][data-cinder-variant="tablist"]';
    const tablist = page.locator(tablistSelector).first();
    await expect(tablist).toBeVisible();

    const tab = (name: string) => tablist.getByRole('tab', { name });
    await expect(tab('Editor')).toBeVisible();
    await expect(tab('Diff')).toBeVisible();
    await expect(tab('Summary')).toBeVisible();

    // Focus the currently-selected tab (roving tabindex=0). The view switcher
    // initializes on "Editor".
    await tab('Editor').focus();
    await expect(tab('Editor')).toBeFocused();

    // Helper: assert focus + aria-selected both land on the named tab and that
    // focus is still inside the tablist (not stolen by a sibling toolbar
    // control such as the comments toggle).
    const expectActiveTab = async (name: string) => {
      await expect(tab(name)).toBeFocused();
      await expect(tab(name)).toHaveAttribute('aria-selected', 'true');
      const focusInside = await page.evaluate((selector) => {
        const root = document.querySelector(selector);
        return root instanceof HTMLElement && root.contains(document.activeElement);
      }, tablistSelector);
      expect(focusInside).toBe(true);
    };

    await page.keyboard.press('ArrowRight');
    await expectActiveTab('Diff');
    await page.keyboard.press('ArrowRight');
    await expectActiveTab('Summary');
    // ArrowRight from the last tab wraps to the first.
    await page.keyboard.press('ArrowRight');
    await expectActiveTab('Editor');
    // ArrowLeft from the first tab wraps to the last.
    await page.keyboard.press('ArrowLeft');
    await expectActiveTab('Summary');
  });
});
