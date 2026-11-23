/**
 * Pages a plugin adds (COR-2213), on the host that loads fixture plugins which place them
 * (`E2E_PLUGIN_PAGES_PORT`, `page-panel-plugins.ts`): the sidebar entries (in their groups after the
 * built-ins, with a Cinder badge, the allowlisted icon or the puzzle, and a tooltip), the collapsed
 * rail and the phone's drawer, the palette's "Go to" rows, and each state of the page itself: ready,
 * loading, failed, not found, disabled, needs setup, a blocked link and a long title. The page's
 * header reads the panel's title and "From <Plugin title>", and no plugin name, panel name or path
 * appears as words. The Plugins page's cards name a changed panel by its title.
 *
 * Each state is captured for the design review under the names of the agreed design:
 * `plugin-page-ready`, `plugin-page-loading`, `plugin-page-failed`, `plugin-page-not-found`,
 * `plugin-page-plugin-disabled`, `plugin-page-needs-setup`, `plugin-page-link-blocked`,
 * `plugin-page-long-title`, `sidebar-plugin-entries`, `sidebar-plugin-entries-collapsed`,
 * `drawer-plugin-entries`, `palette-plugin-entry` and `panel-changed`.
 */
import type { Locator, Page } from '@playwright/test';

import { PLUGIN_PAGE_COPY } from '../../src/app/copy/plugin-pages.ts';
import { NAVIGATION_COPY } from '../../src/app/copy/shell.ts';
import { VIEW_COPY } from '../../src/app/copy/view-pages.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_PLUGIN_PAGES_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import { LONG_PAGE_TITLE } from './page-panel-plugins.ts';
import { readBoxes } from './read-boxes.ts';

test.use({ baseURL: E2E_PLUGIN_PAGES_URL });

const SOURCE = 'plugin-page.spec.ts';
const PAGE_ROUTE = '/plugins/:plugin/*';
const OVERVIEW = '/plugins/e2e-reports/overview';
const OVERVIEW_RESOURCE = '**/host/plugins/e2e-reports/apps/overview';

/** What the sidebar's destinations read, built-ins and plugins together, in the order they sit. */
const EXPECTED_ENTRIES = [
  VIEW_COPY.home.label,
  VIEW_COPY.chat.label,
  VIEW_COPY.reviews.label,
  VIEW_COPY.runs.label,
  VIEW_COPY.checks.label,
  'Fixture overview, plugin',
  'Fixture notes, plugin',
  'Fixture chores, plugin',
  VIEW_COPY.agents.label,
  VIEW_COPY.workflows.label,
  VIEW_COPY.schedules.label,
  VIEW_COPY.goals.label,
  VIEW_COPY.capabilities.label,
  VIEW_COPY.hooks.label,
  'Review queue, plugin',
  VIEW_COPY.health.label,
  VIEW_COPY.settings.label,
  `${LONG_PAGE_TITLE}, plugin`,
] as const;

/** The name of each link in the sidebar's list of views, as the accessible tree reads it. */
async function entryNames(page: Page): Promise<string[]> {
  return page
    .getByRole('navigation', { name: NAVIGATION_COPY.destinations })
    .getByRole('link')
    .evaluateAll((links) =>
      links.map((link) => link.getAttribute('aria-label') ?? link.textContent?.trim() ?? ''),
    );
}

function entry(page: Page, name: string): Locator {
  return page
    .getByRole('navigation', { name: NAVIGATION_COPY.destinations })
    .getByRole('link', { name, exact: true });
}

/** The page's header and its panel's frame, which the page's own region holds. */
function pageRegion(page: Page): Locator {
  return page.locator('[data-view="plugin-page"]');
}

async function expectNoPluginNameAsWords(page: Page): Promise<void> {
  await expect(page.locator('body')).not.toContainText('e2e-reports');
  await expect(page.locator('body')).not.toContainText('e2e-notes');
  await expect(page.locator('body')).not.toContainText('e2e-off');
}

test.describe('/ plugin sidebar entries', () => {
  test('sit in their declared group after the built-ins, in load order, with a Plugin badge, the same height, and a tooltip', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(entry(page, 'Fixture overview, plugin')).toBeVisible();
    const names = await entryNames(page);
    expect(names).toHaveLength(EXPECTED_ENTRIES.length);
    for (const [index, expected] of EXPECTED_ENTRIES.entries()) {
      expect(names[index]?.startsWith(expected), `${String(index)}: ${names[index] ?? ''}`).toBe(
        true,
      );
    }
    // The disabled plugin's page has no entry.
    expect(names.some((name) => name.startsWith('Switched off page'))).toBe(false);

    const overview = entry(page, 'Fixture overview, plugin');
    await expect(overview.getByText(PLUGIN_PAGE_COPY.badge, { exact: true })).toBeVisible();
    await expect(
      overview.locator('[data-cinder-variant="neutral"][data-cinder-size="xs"]'),
    ).toHaveText(PLUGIN_PAGE_COPY.badge);
    // An allowlisted icon is drawn, and a name outside the allowlist falls back to the puzzle.
    await expect(overview.locator('svg.lucide-chart-line')).toHaveCount(1);
    await expect(entry(page, 'Review queue, plugin').locator('svg.lucide-puzzle')).toHaveCount(1);
    // The row is as tall as a built-in's, and a long title ends in an ellipsis before the badge.
    const rows = await readBoxes(page, {
      builtIn: entry(page, VIEW_COPY.runs.label),
      plugin: entry(page, 'Review queue, plugin'),
      long: entry(page, `${LONG_PAGE_TITLE}, plugin`),
    });
    expect(Math.abs(rows.plugin.height - rows.builtIn.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(rows.long.height - rows.builtIn.height)).toBeLessThanOrEqual(1);
    // A plugin entry is a row Cinder badges, never a dot or a count.
    await expect(
      entry(page, 'Fixture notes, plugin').locator('.cinder-side-navigation-item__dot'),
    ).toHaveCount(0);

    await overview.hover();
    await expect(page.getByText('Fixture overview, plugin', { exact: true })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/',
      state: 'sidebar-plugin-entries',
      source: SOURCE,
    });
  });

  test('keep only their icon in the collapsed rail, with the same name', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: NAVIGATION_COPY.collapseSidebar }).click();
    const overview = entry(page, 'Fixture overview, plugin');
    await expect(overview).toBeVisible();
    await expect(overview.locator('.cinder-side-navigation-item__badge')).toBeHidden();
    await overview.hover();
    await expect(page.getByText('Fixture overview, plugin', { exact: true })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/',
      state: 'sidebar-plugin-entries-collapsed',
      source: SOURCE,
    });
  });

  test.describe('/ on a phone', () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test('are in the navigation drawer in the same order, and the bottom tab bar is unchanged', async ({
      page,
    }) => {
      await page.goto('/');
      const tabBar = page.getByRole('navigation', { name: NAVIGATION_COPY.tabBar });
      const tabs = await tabBar
        .getByRole('link')
        .evaluateAll((links) => links.map((link) => link.getAttribute('aria-label') ?? ''));
      expect(tabs.some((name) => name.includes('plugin'))).toBe(false);
      await tabBar.getByRole('button', { name: NAVIGATION_COPY.moreTab }).click();
      await expect(entry(page, 'Fixture overview, plugin')).toBeVisible();
      const names = await entryNames(page);
      expect(names.filter((name) => name.endsWith(', plugin'))).toEqual([
        'Fixture overview, plugin',
        'Fixture notes, plugin',
        'Fixture chores, plugin',
        'Review queue, plugin',
        `${LONG_PAGE_TITLE}, plugin`,
      ]);
      await captureForDesignReview(page, {
        route: '/',
        state: 'drawer-plugin-entries',
        source: SOURCE,
      });
    });
  });
});

test.describe('/ plugin command palette entries', () => {
  test('lists every page under Go to, with where it comes from, including a page with no sidebar entry', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(entry(page, 'Fixture overview, plugin')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('fixture');
    const overview = page.getByRole('option', {
      name: 'Go to Fixture overview, From Reports fixtures',
      exact: true,
    });
    await expect(overview).toBeVisible();
    await expect(
      page.getByRole('option', {
        name: 'Go to Hidden fixture, From Reports fixtures',
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole('option', { name: /Switched off page/ })).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/',
      state: 'palette-plugin-entry',
      source: SOURCE,
    });
    await overview.click();
    await expect(page).toHaveURL(new RegExp(`${OVERVIEW}$`));
  });
});

test.describe('/plugins/:plugin/*', () => {
  test('opens from its sidebar entry, under a header of its title and "From <plugin>", and fills the outlet', async ({
    page,
  }) => {
    await page.goto('/');
    await entry(page, 'Fixture overview, plugin').click();
    await expect(page).toHaveURL(new RegExp(`${OVERVIEW}$`));
    const region = pageRegion(page);
    await expect(region).toHaveAttribute('data-state', 'ready');
    await expect(region.getByRole('heading', { level: 1, name: 'Fixture overview' })).toBeVisible();
    await expect(
      region.getByRole('link', { name: 'Reports fixtures', exact: true }),
    ).toHaveAttribute('href', '/settings/plugins?plugin=e2e-reports');
    await expect(region.locator('.cinder-page-header')).toContainText('From Reports fixtures');
    // The top bar names the page by its title alone.
    await expect(page.getByRole('navigation', { name: NAVIGATION_COPY.breadcrumb })).toHaveText(
      'Fixture overview',
    );
    // One frame, no "Loading app…", no second error or retry word.
    const frame = page.locator('iframe[title="Fixture overview"]');
    await expect(frame).toBeVisible();
    await expect(
      page.frameLocator('iframe[title="Fixture overview"]').getByRole('heading', {
        name: 'Fixture page panel',
      }),
    ).toBeVisible();
    await expect(page.getByText('Loading app…')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expectNoPluginNameAsWords(page);
    // The panel ends at the outlet's bottom edge, with no page scrollbar and no border of its own.
    const outlet = page.locator('main.weft-shell-outlet');
    const { outlet: outletBox, frame: frameBox } = await readBoxes(page, { outlet, frame });
    expect(
      Math.abs(outletBox.y + outletBox.height - (frameBox.y + frameBox.height)),
    ).toBeLessThanOrEqual(1);
    expect(
      await outlet.evaluate((element) => element.scrollHeight - element.clientHeight),
    ).toBeLessThanOrEqual(1);
    await captureForDesignReview(page, {
      route: PAGE_ROUTE,
      state: 'plugin-page-ready',
      source: SOURCE,
    });
  });

  test('at 320 by 640 has a header no taller than 96 pixels above a panel that reaches the tab bar', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/plugins/e2e-reports/long-title');
    const region = pageRegion(page);
    await expect(region).toHaveAttribute('data-state', 'ready');
    const frame = page.locator(`iframe[title="${LONG_PAGE_TITLE}"]`);
    await expect(frame).toBeVisible();
    const {
      header,
      frame: frameBox,
      tabBar,
    } = await readBoxes(page, {
      header: region.locator('.cinder-page-header'),
      frame,
      tabBar: page.getByRole('navigation', { name: NAVIGATION_COPY.tabBar }),
    });
    expect(frameBox.y - header.y).toBeLessThanOrEqual(96);
    expect(Math.abs(frameBox.y + frameBox.height - tabBar.y)).toBeLessThanOrEqual(1);
    await captureForDesignReview(page, {
      route: PAGE_ROUTE,
      state: 'plugin-page-long-title',
      source: SOURCE,
    });
  });

  test('waits in one skeleton named for the page, and McpApp draws none of its own', async ({
    page,
  }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(OVERVIEW_RESOURCE, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(OVERVIEW);
    const region = pageRegion(page);
    await expect(
      region.getByRole('status').filter({ hasText: 'Loading Fixture overview' }),
    ).toHaveCount(1);
    await expect(page.getByText('Loading app…')).toHaveCount(0);
    await expect(region).toHaveAttribute('data-state', 'loading');
    await captureForDesignReview(page, {
      route: PAGE_ROUTE,
      state: 'plugin-page-loading',
      source: SOURCE,
    });
    release();
    await expect(page.locator('iframe[title="Fixture overview"]')).toBeVisible();
    await page.unroute(OVERVIEW_RESOURCE);
  });

  test('says it could not open the page, with Try again and a link to the plugin in Settings', async ({
    page,
    pageErrors,
  }) => {
    let attempts = 0;
    await page.route(OVERVIEW_RESOURCE, (route) => {
      attempts += 1;
      return attempts === 1
        ? route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'fixture resource failure' }),
          })
        : route.continue();
    });
    pageErrors.expect({
      pattern: loggedFailedResponse(500, /e2e-reports\/apps\/overview/),
      reason: 'the test returns a failed plugin page to capture the error state',
    });
    await page.goto(OVERVIEW);
    const region = pageRegion(page);
    await expect(
      region.getByRole('heading', { name: 'Couldn’t open Fixture overview' }),
    ).toBeVisible();
    await expect(
      region.getByText('Reports fixtures didn’t send this page. Nothing you did caused it.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      region.getByRole('link', { name: 'Open Reports fixtures in Settings', exact: true }),
    ).toBeVisible();
    await expect(region.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(region).toHaveAttribute('data-state', 'error');
    await captureForDesignReview(page, {
      route: PAGE_ROUTE,
      state: 'plugin-page-failed',
      source: SOURCE,
    });
    await region.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.locator('iframe[title="Fixture overview"]')).toBeVisible();
    await expect(region).toHaveAttribute('data-state', 'ready');
    expect(attempts).toBe(2);
    await page.unroute(OVERVIEW_RESOURCE);
  });

  test('says there is no page at an address no plugin serves, and leads to Plugins', async ({
    page,
  }) => {
    await page.goto('/plugins/e2e-reports/missing');
    const region = pageRegion(page);
    await expect(region).toHaveAttribute('data-state', 'not-found');
    await expect(region.getByRole('heading', { name: 'There’s no page here' })).toBeVisible();
    await expect(
      region.getByText(
        'No plugin offers a page at this address. A plugin’s pages go away while it is disabled.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(region.getByRole('link', { name: 'Open Plugins', exact: true })).toHaveAttribute(
      'href',
      '/settings/plugins',
    );
    await captureForDesignReview(page, {
      route: PAGE_ROUTE,
      state: 'plugin-page-not-found',
      source: SOURCE,
    });
  });

  test('says the plugin is disabled at an address its plugin owns, with no sidebar or palette entry', async ({
    page,
  }) => {
    await page.goto('/plugins/e2e-off/off');
    const region = pageRegion(page);
    await expect(region).toHaveAttribute('data-state', 'not-found');
    await expect(
      region.getByRole('heading', { name: 'Switched off fixtures is disabled' }),
    ).toBeVisible();
    await expect(
      region.getByText('Its pages come back when you enable it and restart.', { exact: true }),
    ).toBeVisible();
    await expect(
      region.getByRole('link', { name: 'Open Switched off fixtures in Settings', exact: true }),
    ).toHaveAttribute('href', '/settings/plugins?plugin=e2e-off');
    const names = await entryNames(page);
    expect(names.some((name) => name.startsWith('Switched off page'))).toBe(false);
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('switched off');
    await expect(page.getByRole('option', { name: /Switched off page/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await captureForDesignReview(page, {
      route: PAGE_ROUTE,
      state: 'plugin-page-plugin-disabled',
      source: SOURCE,
    });
  });

  test('shows its panel under one note when its plugin needs setup, with the key’s dialog for one missing secret', async ({
    page,
  }) => {
    await page.goto('/plugins/e2e-notes/notes');
    const region = pageRegion(page);
    await expect(region).toHaveAttribute('data-state', 'ready');
    await expect(
      region.getByText('Notes fixtures needs setup, so parts of this page may not work.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator('iframe[title="Fixture notes"]')).toBeVisible();
    await captureForDesignReview(page, {
      route: PAGE_ROUTE,
      state: 'plugin-page-needs-setup',
      source: SOURCE,
    });
    await region.getByRole('button', { name: 'Add the key', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('links to Settings, not a dialog, when its plugin needs more than one secret', async ({
    page,
  }) => {
    await page.goto('/plugins/e2e-chores/chores');
    const region = pageRegion(page);
    await expect(
      region.getByText('Chores fixtures needs setup, so parts of this page may not work.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(region.getByRole('button', { name: 'Add the key' })).toHaveCount(0);
    await expect(
      region.getByRole('link', { name: 'Open Chores fixtures in Settings', exact: true }),
    ).toHaveAttribute('href', '/settings/plugins?plugin=e2e-chores');
  });

  test('opens a link inside Interborough in the same tab, and blocks any other address with a toast', async ({
    page,
  }) => {
    await page.goto(OVERVIEW);
    const app = page.frameLocator('iframe[title="Fixture overview"]');
    await app.getByRole('button', { name: 'Open an outside address' }).click();
    await expect(app.locator('#answer')).toHaveText('refused');
    await expect(
      page.getByText(
        'Fixture overview tried to open an address outside Interborough, so it was blocked.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${OVERVIEW}$`));
    await captureForDesignReview(page, {
      route: PAGE_ROUTE,
      state: 'plugin-page-link-blocked',
      source: SOURCE,
    });
    await app.getByRole('button', { name: 'Open the run list' }).click();
    await expect(page).toHaveURL(/\/runs$/);
    expect(page.context().pages()).toHaveLength(1);
  });
});

test.describe('/settings/plugins', () => {
  test('names a changed panel by its title, and by its identifier in monospace only when it has none', async ({
    page,
  }) => {
    await page.route('**/host/plugins', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      const body = (await response.json()) as {
        plugins: { descriptor: { name: string }; problems: unknown[] }[];
      };
      const changed = (app: string) => ({
        code: 'panel-changed',
        app,
        uri: `ui://e2e-reports/${app}/v1`,
        previousDigest: 'sha256:old',
        contentDigest: 'sha256:new',
      });
      for (const plugin of body.plugins) {
        if (plugin.descriptor.name === 'e2e-reports') {
          plugin.problems = [...plugin.problems, changed('queue'), changed('ghost')];
        }
      }
      await route.fulfill({ response, json: body });
    });
    await page.goto('/settings/plugins?plugin=e2e-reports');
    const titled = page.locator('[data-plugin-problem="panel-changed"]').filter({
      hasText: 'The panel Review queue serves a different page',
    });
    // A plugin's card is on the page's list of problems and again in the plugin's own detail, so
    // each case is read as "at least one card, and none of them sets a titled panel in monospace".
    await expect.poll(() => titled.count()).toBeGreaterThan(0);
    await expect(titled.locator('code')).toHaveCount(0);
    const untitled = page.locator('[data-plugin-problem="panel-changed"]').filter({
      has: page.locator('code', { hasText: /^ghost$/ }),
    });
    await expect.poll(() => untitled.count()).toBeGreaterThan(0);
    await captureForDesignReview(page, {
      route: '/settings/plugins',
      state: 'panel-changed',
      source: SOURCE,
    });
  });
});
