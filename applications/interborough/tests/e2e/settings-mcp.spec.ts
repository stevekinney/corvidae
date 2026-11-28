/**
 * Settings › MCP (COR-2539) on the sample world: the address of Interborough's MCP endpoint, which
 * is the host's own origin plus `/bureau/mcp`, with the Claude Code command and the configuration
 * any other MCP client reads. The page teaches the connection only: there is no credential to show,
 * because the endpoint needs none.
 *
 * Each state is captured for the design review (`design-review-capture.ts`) at the widths Settings
 * is drawn at.
 */
import type { Page } from '@playwright/test';

import { MCP_COPY } from '../../src/app/copy/mcp.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_PORT, E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { readBoxes } from './read-boxes.ts';

const SOURCE = 'settings-mcp.spec.ts';
const ROUTE = '/settings/mcp';
const ENDPOINT = `http://127.0.0.1:${E2E_SHOWCASE_PORT}/bureau/mcp`;

/** Captures the screen at the three widths Settings is drawn at: desktop, tablet and phone. */
async function captureAtEveryWidth(page: Page, state: string) {
  for (const width of [1280, 768, 375] as const) {
    await page.setViewportSize({ width, height: 900 });
    await captureForDesignReview(page, { route: ROUTE, state, source: SOURCE });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);
  await expect(page.locator('[data-view="settings"]')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('heading', { level: 1, name: 'MCP' })).toBeVisible();
}

test.describe('Settings › MCP', () => {
  test.beforeEach(async ({ page }) => {
    await open(page);
  });

  test('aligns the restart banner with the content on desktop', async ({ page }) => {
    const banner = page.getByTestId('settings-restart-summary');
    const content = page.getByRole('group', { name: MCP_COPY.groupLabel });
    await expect(banner).toBeVisible();

    for (const width of [1280, 1920]) {
      await page.setViewportSize({ width, height: 1080 });
      const boxes = await readBoxes(page, { banner, content });
      expect(boxes.banner.x).toBeCloseTo(boxes.content.x, 0);
      expect(boxes.banner.width).toBeCloseTo(boxes.content.width, 0);
      await captureForDesignReview(page, { route: ROUTE, state: 'restart-banner', source: SOURCE });
    }
  });

  test('reads the endpoint address, and the configuration for Claude Code and for any other client', async ({
    page,
    checkA11y,
  }) => {
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(nav.getByRole('link', { name: 'MCP', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByText(MCP_COPY.intro)).toBeVisible();

    // The address is a Cinder CopyableValue: its text, and the copy button inside it.
    const endpoint = page.getByTestId('mcp-endpoint');
    await expect(endpoint).toHaveText(new RegExp(`^\\s*${ENDPOINT}`));
    await expect(endpoint.getByRole('button', { name: MCP_COPY.endpoint.copy })).toBeVisible();

    await expect(page.getByTestId('mcp-claude-code')).toContainText(
      `claude mcp add --transport http interborough ${ENDPOINT}`,
    );
    const generic = page.getByTestId('mcp-generic');
    await expect(generic).toContainText('"mcpServers"');
    await expect(generic).toContainText('"type": "http"');
    await expect(generic).toContainText(`"url": "${ENDPOINT}"`);

    // No credential: the endpoint needs none, so the page names no key, token or header.
    await expect(page.locator('main')).not.toContainText(/authorization|bearer|api[-_ ]key|token/i);

    await checkA11y('settings mcp at 1280px');
    await captureAtEveryWidth(page, 'ready');

    // Below 640px the navigation is a select under the heading Settings.
    await page.setViewportSize({ width: 375, height: 900 });
    await expect(page.getByRole('combobox', { name: 'Section' })).toHaveValue('/settings/mcp');
    await page.setViewportSize({ width: 1280, height: 900 });
  });
});

test.describe('Settings › MCP on a touch phone', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('keeps the Section selector above the sticky restart cover', async ({ page }) => {
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 640 });
      await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);
      const section = page.getByRole('combobox', { name: 'Section' });
      const banner = page.getByTestId('settings-restart-summary');
      await expect(section).toHaveValue(ROUTE);
      await expect(banner).toBeVisible();
      const coverSeparation = await banner.evaluate((element) => {
        const select = document.querySelector('#weft-settings-section');
        if (!select) throw new Error('The Settings Section selector is missing.');
        const cover = getComputedStyle(element, '::before');
        const border = getComputedStyle(element);
        const coverTop =
          element.getBoundingClientRect().bottom -
          Number.parseFloat(border.borderBottomWidth) -
          Number.parseFloat(cover.insetBlockEnd) -
          Number.parseFloat(cover.blockSize);
        return coverTop - select.getBoundingClientRect().bottom;
      });
      expect(coverSeparation).toBeGreaterThanOrEqual(-0.5);
      if (width === 375) {
        await captureForDesignReview(page, {
          route: ROUTE,
          state: 'section-clears-restart-cover',
          source: SOURCE,
        });
      }
      await section.selectOption('/settings');
      await expect(page).toHaveURL(/\/settings$/u);
      await expect(page.getByRole('combobox', { name: 'Section' })).toHaveValue('/settings');
    }
  });
});
