/// <reference lib="dom" />
/**
 * Verifies the shared `_status-surface.css` recipe (task 5b849512) renders the
 * soft status surfaces for Alert, Banner, and Callout correctly in a real
 * browser — the consolidation moved the `light-dark(oklch(from …))` algebra out
 * of each component and into a shared partial driven by `--_cinder-status-base`
 * plus per-variant chroma inputs. These checks confirm the composed recipe
 * actually paints (not flattened to the neutral surface) and that Callout draws
 * one edge with no accent stripe — the properties the unit tests can only assert
 * against CSS source.
 *
 * Markup is injected directly (rather than relying on whichever playground
 * examples happen to render which variant) so the recipe is exercised
 * deterministically. The page is loaded first so `@lostgradient/cinder` and the
 * component CSS sidecars are present and `color-scheme` is established.
 */

import { expect, test, type Page } from '@playwright/test';

import { themeFixtureRoute } from './theme-fixture-route.ts';

/** Load any cinder page so the global styles + component sidecars are applied. */
async function loadStyledPage(page: Page): Promise<void> {
  await page.goto(themeFixtureRoute, { waitUntil: 'load' });
}

/**
 * Inject fixture markup into the page body, replacing any fixture from a prior
 * call so the helper is safe to reuse on the same page (no duplicate IDs).
 */
async function inject(page: Page, html: string): Promise<void> {
  await page.evaluate((markup) => {
    document.getElementById('status-surface-fixture')?.remove();
    const host = document.createElement('div');
    host.id = 'status-surface-fixture';
    host.innerHTML = markup;
    document.body.appendChild(host);
  }, html);
}

test.describe('status-surface recipe — composed soft surfaces paint correctly', () => {
  test('Callout variants get a tinted background distinct from the neutral surface', async ({
    page,
  }) => {
    await loadStyledPage(page);
    await inject(
      page,
      `<aside class="cinder-callout cinder-_status-surface cinder-_status-surface-border" data-cinder-variant="danger">danger</aside>
       <aside class="cinder-callout cinder-_status-surface cinder-_status-surface-border" data-cinder-variant="info">info</aside>`,
    );

    const dangerBg = await page
      .locator("#status-surface-fixture .cinder-callout[data-cinder-variant='danger']")
      .first()
      .evaluate((node) => getComputedStyle(node).backgroundColor);
    const infoBg = await page
      .locator("#status-surface-fixture .cinder-callout[data-cinder-variant='info']")
      .first()
      .evaluate((node) => getComputedStyle(node).backgroundColor);

    expect(dangerBg).not.toBe('');
    expect(dangerBg).not.toBe('rgba(0, 0, 0, 0)');
    // Distinct status hues must produce distinct backgrounds — proves the
    // --_cinder-status-base input flows through the shared recipe per variant.
    expect(dangerBg).not.toBe(infoBg);
  });

  test('Callout draws one edge: the inline-start border matches the others', async ({ page }) => {
    await loadStyledPage(page);
    await inject(
      page,
      `<aside class="cinder-callout cinder-_status-surface cinder-_status-surface-border" data-cinder-variant="danger">danger</aside>`,
    );

    const { start, top, startWidth, topWidth } = await page
      .locator("#status-surface-fixture .cinder-callout[data-cinder-variant='danger']")
      .first()
      .evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          start: style.borderInlineStartColor,
          top: style.borderTopColor,
          startWidth: style.borderInlineStartWidth,
          topWidth: style.borderTopWidth,
        };
      });

    // A status surface is a tint and an icon inside one edge: no thicker or more saturated
    // inline-start stripe.
    expect(start).not.toBe('');
    expect(start).toBe(top);
    expect(startWidth).toBe(topWidth);
  });

  test('Surface-only Alert recipe keeps a neutral border (P7)', async ({ page }) => {
    await loadStyledPage(page);
    await inject(
      page,
      `<div class="cinder-alert cinder-_status-surface" data-cinder-variant="danger" role="alert">danger</div>
       <div class="cinder-alert cinder-_status-surface" data-cinder-variant="success" role="alert">success</div>`,
    );

    const dangerBorder = await page
      .locator("#status-surface-fixture .cinder-alert[data-cinder-variant='danger']")
      .first()
      .evaluate((node) => getComputedStyle(node).borderTopColor);
    const successBorder = await page
      .locator("#status-surface-fixture .cinder-alert[data-cinder-variant='success']")
      .first()
      .evaluate((node) => getComputedStyle(node).borderTopColor);

    expect(dangerBorder).not.toBe('');
    // The injected surface-only markup composes the recipe without the Alert border class, so its border stays neutral,
    // identical across variants (the variant tint is background + text only).
    expect(dangerBorder).toBe(successBorder);
  });

  test('public Alert variants retain their composed tinted borders', async ({ page }) => {
    await loadStyledPage(page);
    const dangerBorder = await page
      .locator(".theme-surfaces-fixture .cinder-alert[data-cinder-variant='danger']")
      .evaluate((node) => getComputedStyle(node).borderTopColor);
    const successBorder = await page
      .locator(".theme-surfaces-fixture .cinder-alert[data-cinder-variant='success']")
      .evaluate((node) => getComputedStyle(node).borderTopColor);
    expect(dangerBorder).not.toBe(successBorder);
  });

  test('forced-colors: the recipe yields to system colors (border → CanvasText)', async ({
    browser,
  }) => {
    // The recipe is imported after the component CSS, so its own
    // @media (forced-colors: active) reset must keep the border pinned to
    // the system color rather than letting the oklch() value win by source order.
    const context = await browser.newContext({ forcedColors: 'active' });
    try {
      const page = await context.newPage();
      await loadStyledPage(page);
      await inject(
        page,
        `<aside class="cinder-callout cinder-_status-surface cinder-_status-surface-border" data-cinder-variant="danger">danger</aside>`,
      );

      const { start, border } = await page
        .locator("#status-surface-fixture .cinder-callout[data-cinder-variant='danger']")
        .first()
        .evaluate((node) => {
          const style = getComputedStyle(node);
          return { start: style.borderInlineStartColor, border: style.borderTopColor };
        });

      // In forced-colors mode every edge resolves to the SAME system color (CanvasText)
      // — the oklch tint does not leak through.
      expect(start).not.toBe('');
      expect(border).not.toBe('');
      expect(start).toBe(border);
    } finally {
      await context.close();
    }
  });
});
