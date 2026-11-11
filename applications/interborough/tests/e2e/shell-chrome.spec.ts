/**
 * The shell's chrome on the sample world (`fixtures/sample-world-seed.ts`, the showcase host), in
 * every form it takes and at every width the design draws (COR-2015, design rows 03a to 03m, 04a to
 * 04f, 05h, 05i, 05r, 07h, 07k, COR-2315): the 190px sidebar, the 56px folded column, the 76px rail
 * with its labels and its overlay on a tablet, the bottom tab bar and the 280px drawer on a phone,
 * the 320px floor and 200% text size. Each captioned state is captured for the design review under its own name.
 *
 * Reviews shows the two reviews waiting on the person, and Health an amber dot named "Health, 3
 * need attention", which the sample world's attention feed (`bureau.health.attention`) holds.
 *
 * The top bar's two popovers (design rows 03l, 02w, 02x, 02y) are read on the same sample world at
 * its "now": the notifications popover, and quick settings.
 */
import type { Locator, Page } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL });

const SOURCE = 'shell-chrome.spec.ts';
const REVIEWS = 'Reviews, 2 need you';
const HEALTH = 'Health, 3 need attention';

const sidebar = (page: Page) => page.locator('aside.weft-shell-sidebar');
const drawer = (page: Page) => page.locator('dialog.cinder-drawer[open]');
const navigation = (page: Page) => page.getByRole('navigation', { name: 'Views' });

/**
 * Opens `path`, and waits until the sidebar has the counts the sample world gives it. Where the
 * navigation is a drawer there is no sidebar until the menu button opens one, so there are no counts
 * to wait for: pass `counts: false`.
 */
async function open(
  page: Page,
  path: string,
  width: number,
  height = 900,
  counts = width >= 700,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(path);
  await expect(page.getByRole('banner')).toBeVisible();
  if (!counts) return;
  await expect(page.getByRole('link', { name: REVIEWS })).toBeAttached();
  await expect(page.getByRole('link', { name: HEALTH })).toBeAttached();
}

/** Waits for an element to be `width` pixels wide, which a state change reaches on the next frame. */
async function expectWidth(locator: Locator, width: number): Promise<void> {
  await expect.poll(() => widthOf(locator)).toBe(width);
}

/** The width, height and top of an element, which has to be on screen. */
async function widthOf(locator: Locator): Promise<number> {
  const box = await boxOf(locator);
  return box.width;
}

async function heightOf(locator: Locator): Promise<number> {
  const box = await boxOf(locator);
  return box.height;
}

async function yOf(locator: Locator): Promise<number> {
  const box = await boxOf(locator);
  return box.y;
}

/** The box of an element, which has to be on screen. */
async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('Expected the element to have a box.');
  return box;
}

/** Nothing in the page scrolls sideways, in the document or in the shell's outlet (design row 05h). */
async function expectNoSidewaysScroll(page: Page, label: string): Promise<void> {
  const widths = await page.evaluate(() => {
    const outlet = document.querySelector('main.weft-shell-outlet');
    const edge = outlet?.getBoundingClientRect().right ?? 0;
    // What reaches past the outlet's right edge, so a failure names the element and not just a number.
    const past = Array.from(outlet?.querySelectorAll('*') ?? [])
      .filter((element) => element.getBoundingClientRect().right > edge + 1)
      .slice(0, 5)
      .map(
        (element) => `${element.tagName.toLowerCase()}.${String(element.getAttribute('class'))}`,
      );
    return {
      document: document.documentElement.scrollWidth,
      view: window.innerWidth,
      outlet: outlet === null ? [0, 0] : [outlet.scrollWidth, outlet.clientWidth],
      past,
    };
  });
  expect(widths.document, `${label}: the document scrolls sideways`).toBeLessThanOrEqual(
    widths.view,
  );
  expect(
    widths.outlet[0],
    `${label}: the outlet scrolls sideways (reaching past it: ${widths.past.join(', ')})`,
  ).toBeLessThanOrEqual(widths.outlet[1] ?? 0);
}

test.describe('on a desktop', () => {
  test('the sidebar is 190px: the name as text, groups, 30px rows on a 32px pitch (03h, 03i)', async ({
    page,
    checkA11y,
  }) => {
    await open(page, '/health', 1280);
    await expectWidth(sidebar(page), 190);
    expect(await heightOf(page.getByRole('banner'))).toBe(52);

    const name = page.locator('.weft-shell-sidebar__name');
    await expect(name).toHaveText('Interborough');
    await expect(name.locator('svg, img')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();

    await expect(navigation(page).locator('.cinder-side-navigation-group__heading')).toHaveText([
      'Work',
      'Build',
      'System',
    ]);
    await expect(
      navigation(page).locator('.cinder-side-navigation-group__heading').first(),
    ).toHaveCSS('font-size', '11.5px');

    const rows = [
      navigation(page).getByRole('link', { name: 'Agents' }),
      navigation(page).getByRole('link', { name: 'Workflows' }),
      navigation(page).getByRole('link', { name: 'Schedules' }),
    ];
    const boxes = [];
    for (const row of rows) {
      boxes.push(await boxOf(row));
      await expect(row).toHaveCSS('line-height', '20px');
    }
    expect(boxes.map((box) => box.height)).toEqual([30, 30, 30]);
    expect((boxes[1]?.y ?? 0) - (boxes[0]?.y ?? 0)).toBe(32);
    expect((boxes[2]?.y ?? 0) - (boxes[1]?.y ?? 0)).toBe(32);

    // System sits at the bottom of the column, and Health is the current page with its dot.
    const health = navigation(page).getByRole('link', { name: HEALTH });
    await expect(health).toHaveAttribute('aria-current', 'page');
    await expect(health.locator('.cinder-side-navigation-item__dot')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    await expect(health.locator('.cinder-status-dot')).toHaveAttribute(
      'data-cinder-status',
      'warning',
    );
    await expect(navigation(page).getByRole('link', { name: REVIEWS })).toContainText('2');
    expect(await yOf(health)).toBeGreaterThan(boxes[2]!.y + 200);

    await captureForDesignReview(page, {
      route: '/health',
      state: 'shell sidebar',
      source: SOURCE,
    });
    await checkA11y('shell at 1280');
  });

  test('Home is active at the root alone, and its heading is visually hidden (03l)', async ({
    page,
  }) => {
    await open(page, '/', 1280);
    await expect(navigation(page).getByRole('link', { name: 'Home' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(navigation(page).locator('[aria-current="page"]')).toHaveCount(1);
    await expect(
      page.getByRole('banner').getByRole('navigation', { name: 'Breadcrumb' }),
    ).toHaveText('Home');
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toHaveClass(
      /cinder-sr-only/,
    );
    await expect(
      page.getByRole('banner').getByRole('button', { name: /^Search everything/ }),
    ).toContainText('⌘K');
    await captureForDesignReview(page, { route: '/', state: 'shell home', source: SOURCE });
  });

  test('the collapsed rail is 56px: hairlines, Reviews’ count and Health’s dot on the icons (03a)', async ({
    page,
  }) => {
    await open(page, '/', 1280);
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(sidebar(page)).toHaveAttribute('data-cinder-collapsed', '');
    await expectWidth(sidebar(page), 56);
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();

    // The group labels give way to hairlines: the words stay in the accessibility tree.
    const reviews = navigation(page).getByRole('link', { name: REVIEWS });
    // On the rail Reviews' count is a small round warning dot on the icon's corner (COR-2315: a
    // count is plain text, never a badge, and the rail has no room for the figure); the figure
    // stays in the element, and the accessible name and tooltip say it.
    const count = reviews.locator('.cinder-side-navigation-item__count');
    const countBox = await boxOf(count);
    expect(countBox.width).toBeGreaterThan(4);
    expect(countBox.height).toBe(countBox.width);
    await expect(count).toHaveCSS('font-size', '0px');
    await expect(count).toHaveText('2');
    const health = navigation(page).getByRole('link', { name: HEALTH });
    expect(await widthOf(health.locator('.cinder-status-dot'))).toBeGreaterThan(4);
    const groups = navigation(page).locator('.cinder-side-navigation-group');
    await expect(groups.first()).toHaveCSS('border-top-width', '1px');

    // Hovering a row names it in a tooltip, with its count.
    await reviews.hover();
    await expect(page.getByRole('tooltip')).toContainText('Reviews, 2 need you');
    await captureForDesignReview(page, {
      route: '/',
      state: 'collapsed rail tooltip',
      source: SOURCE,
    });

    // The preference is the person's: it survives a reload.
    await page.reload();
    await expect(sidebar(page)).toHaveAttribute('data-cinder-collapsed', '');
  });
});

test.describe('on a tablet', () => {
  test('the sidebar is the 76px rail with a label under every icon, and expanding opens the column over the page, closing on navigation (04a)', async ({
    page,
  }) => {
    await open(page, '/health', 768);
    await expectWidth(sidebar(page), 76);
    // The rail runs the page's full height, so Settings is pinned to the bottom (04a).
    const rail = await boxOf(sidebar(page));
    expect(rail.y + rail.height).toBeGreaterThanOrEqual(page.viewportSize()!.height - 1);
    await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0);
    // Every row draws its label, under its icon, so the rail needs no tooltip.
    const runs = navigation(page).getByRole('link', { name: 'Runs' });
    await expect(runs.locator('.cinder-side-navigation-item__label')).toBeVisible();
    expect(await yOf(runs.locator('.cinder-side-navigation-item__label'))).toBeGreaterThan(
      await yOf(runs.locator('.cinder-side-navigation-item__icon')),
    );
    const outletBefore = await boxOf(page.locator('main.weft-shell-outlet'));
    await expect(
      page.getByRole('banner').getByRole('button', { name: /^Search everything/ }),
    ).toContainText('⌘K');

    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await expectWidth(sidebar(page), 190);
    // The page does not move: the column is over it.
    expect(await boxOf(page.locator('main.weft-shell-outlet'))).toEqual(outletBefore);
    await captureForDesignReview(page, {
      route: '/health',
      state: 'rail expanded overlay',
      source: SOURCE,
    });

    await navigation(page).getByRole('link', { name: 'Runs' }).click();
    await expect(page).toHaveURL(/\/runs$/);
    await expectWidth(sidebar(page), 76);
  });

  test('Escape closes the overlay, and the quick settings preference does not apply here (04b)', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('interborough-sidebar-collapsed', 'false');
    });
    await open(page, '/', 768);
    // Whatever the preference says, below 1200px the rail rule wins.
    await expectWidth(sidebar(page), 76);
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await expectWidth(sidebar(page), 190);
    await page.keyboard.press('Escape');
    await expectWidth(sidebar(page), 76);
    expect(
      await page.evaluate(() => window.localStorage.getItem('interborough-sidebar-collapsed')),
    ).toBe('false');
  });

  test('a preference to fold the sidebar applies from 1200px, and only there (04b)', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('interborough-sidebar-collapsed', 'true');
    });
    await open(page, '/', 1200);
    await expectWidth(sidebar(page), 56);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expectWidth(sidebar(page), 56);
  });
});

test.describe('on a phone', () => {
  test('a bottom tab bar holds Home, Chat, Reviews and Runs, with an accent icon and label on the current one, and More opens the drawer (COR-2315)', async ({
    page,
  }) => {
    await open(page, '/runs', 375, 812, false);
    const tabs = page.getByRole('navigation', { name: 'Main tabs' });
    await expect(tabs).toBeVisible();
    await expect(tabs.locator('.cinder-navigation-item')).toHaveText([
      'Home',
      'Chat',
      'Reviews',
      'Runs',
      'More',
    ]);
    // The bar sits at the bottom of the screen and every tab is a touch target.
    const bar = await boxOf(tabs);
    expect(bar.y + bar.height).toBeGreaterThanOrEqual(812 - 1);
    for (const tab of await tabs.locator('.cinder-navigation-item').all()) {
      expect(await heightOf(tab)).toBeGreaterThanOrEqual(44);
    }
    // The current tab has no fill and no top border: its icon and label take the accent colour.
    const current = tabs.getByRole('link', { name: 'Runs' });
    await expect(current).toHaveAttribute('aria-current', 'page');
    await expect(current).toHaveCSS('border-top-width', '0px');
    await expect(current).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

    await tabs.getByRole('button', { name: 'More' }).click();
    await expect(drawer(page)).toBeVisible();
  });

  test('there is no sidebar, and the menu button opens the 280px drawer with 44px rows (04a, 05r)', async ({
    page,
    checkA11y,
  }) => {
    await open(page, '/', 375, 812, false);
    await expect(sidebar(page)).toHaveCount(0);
    const bar = page.getByRole('banner');
    const menu = bar.getByRole('button', { name: 'Open navigation' });
    // Menu button, then the title, then search, notifications and quick settings as icons.
    const controls = bar.locator('button:visible, a:visible');
    await expect(controls.first()).toHaveAccessibleName('Open navigation');
    await expect(bar.getByRole('navigation', { name: 'Breadcrumb' })).toHaveText('Home');
    for (const name of [/^Search everything/, /^Notifications/, 'Quick settings']) {
      const control = bar.getByRole('button', { name });
      expect(await widthOf(control)).toBeGreaterThanOrEqual(44);
      expect(await heightOf(control)).toBeGreaterThanOrEqual(44);
    }
    await expect(bar.locator('.weft-shell-search-trigger__kbd')).toBeHidden();
    await expectNoSidewaysScroll(page, 'phone');

    await menu.click();
    const panel = drawer(page);
    await expect(panel).toBeVisible();
    await expectWidth(panel.locator('.cinder-drawer__panel'), 280);
    await expect(panel.locator('.cinder-drawer__title')).toHaveText('Interborough');
    await expect(panel.getByRole('button', { name: 'Close navigation' })).toBeVisible();
    await expect(panel.locator('.cinder-side-navigation-group__heading')).toHaveText([
      'Work',
      'Build',
      'System',
    ]);
    const rows = panel.locator('a.cinder-side-navigation-item');
    await expect(rows).toHaveCount(12);
    for (const row of await rows.all()) expect(await heightOf(row)).toBeGreaterThanOrEqual(44);
    await expect(panel.getByRole('link', { name: REVIEWS })).toContainText('2');
    await expect(
      panel.getByRole('link', { name: HEALTH }).locator('.cinder-status-dot'),
    ).toHaveAttribute('data-cinder-status', 'warning');
    await expect(panel.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    await captureForDesignReview(page, { route: '/', state: 'drawer open', source: SOURCE });
    await checkA11y('phone drawer');

    // Navigating closes it, and the shell's own preference is untouched.
    await panel.getByRole('link', { name: 'Runs' }).click();
    await expect(page).toHaveURL(/\/runs$/);
    await expect(drawer(page)).toHaveCount(0);
    expect(
      await page.evaluate(() => window.localStorage.getItem('interborough-sidebar-collapsed')),
    ).toBeNull();
  });

  test('the drawer holds its rows at 44px in the dark scheme, with the badge and the dot (07k)', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await open(page, '/', 375, 812, false);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const panel = drawer(page);
    await expect(panel).toBeVisible();
    for (const row of await panel.locator('a.cinder-side-navigation-item').all()) {
      expect(await heightOf(row)).toBeGreaterThanOrEqual(44);
    }
    await expect(panel.getByRole('link', { name: REVIEWS })).toContainText('2');
    await expect(
      panel.getByRole('link', { name: HEALTH }).locator('.cinder-status-dot'),
    ).toHaveAttribute('data-cinder-status', 'warning');
    await expect(panel.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  });

  test('below a section root the bar shows a back button labelled with the parent (04f)', async ({
    page,
  }) => {
    await open(page, '/agents/demo:assistant/memory', 375, 812, false);
    const trail = page.getByRole('banner').getByRole('navigation', { name: 'Breadcrumb' });
    const back = trail.getByRole('link', { name: /Back to/ });
    await expect(back).toBeVisible();
    // The leaf truncates first (04f): the parent's label is cut only when the current page is cut
    // too, never while the current page still shows whole.
    const cut = (locator: Locator) =>
      locator.evaluate((element) => element.scrollWidth > element.clientWidth);
    if (await cut(back.locator('.cinder-breadcrumbs__back-label'))) {
      expect(await cut(trail.locator('[aria-current="page"]'))).toBe(true);
    }
    await captureForDesignReview(page, {
      route: '/agents/:agent/memory',
      state: 'back button',
      source: SOURCE,
    });
  });

  test('on a tablet the current page gives way before the ancestor does, so Runs is never cut to nothing (03l)', async ({
    page,
  }) => {
    await open(page, '/runs', 768);
    // A run's identifier is long, so its page has the trail's longest leaf. The run is the sample
    // world's own refund, never the newest row: a specification before this one may leave a run on
    // the showcase host whose chat it has since deleted, and that run's page reads 404s.
    const href = await page
      .locator('main a[href^="/runs/run-"]')
      .filter({ hasText: 'Please refund order 4471' })
      .first()
      .getAttribute('href');
    await page.goto(href ?? '/runs');
    const trail = page.getByRole('banner').getByRole('navigation', { name: 'Breadcrumb' });
    const runs = trail.getByRole('link', { name: 'Runs' });
    await expect(runs).toBeVisible();
    expect(await runs.evaluate((link) => link.scrollWidth <= link.clientWidth)).toBe(true);
    // The leaf is the one that ends in an ellipsis, and it starts inside the trail.
    const leaf = trail.locator('[aria-current="page"]');
    expect(await leaf.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    const leafBox = await boxOf(leaf);
    const trailBox = await boxOf(trail);
    expect(leafBox.x).toBeGreaterThanOrEqual(trailBox.x);
  });

  test('an ancestor that cannot show its first word folds into a "…" menu (S18)', async ({
    page,
  }) => {
    await open(page, '/agents/demo:assistant/memory', 1280);
    await page.setViewportSize({ width: 320, height: 640 });
    const trail = page.getByRole('banner').getByRole('navigation', { name: 'Breadcrumb' });
    // No fragment such as "C ›" is left over: every visible crumb shows its whole word.
    for (const text of await trail.locator('a, [aria-current]').allInnerTexts()) {
      expect(text.trim().length).not.toBe(1);
    }
    await expectNoSidewaysScroll(page, 'breadcrumb at 320');
  });
});

test.describe('on a touch tablet', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('gets the same 76px rail, whose labels are drawn and so need no drawer (04c, COR-2315)', async ({
    page,
  }) => {
    await open(page, '/', 768, 1024);
    await expectWidth(sidebar(page), 76);
    await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0);
    await expect(
      navigation(page)
        .getByRole('link', { name: 'Runs' })
        .locator('.cinder-side-navigation-item__label'),
    ).toBeVisible();
    await captureForDesignReview(page, { route: '/', state: 'tablet touch', source: SOURCE });
  });
});

test.describe('at the limits', () => {
  test('320px is the floor: nothing scrolls sideways, in the shell or its drawer (05h)', async ({
    page,
  }) => {
    for (const path of ['/', '/runs', '/health']) {
      await open(page, path, 320, 640, false);
      await expectNoSidewaysScroll(page, `${path} at 320`);
    }
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(drawer(page)).toBeVisible();
    expect(await widthOf(drawer(page).locator('.cinder-drawer__panel'))).toBeLessThanOrEqual(280);
    await captureForDesignReview(page, { route: '/', state: 'drawer open at 320', source: SOURCE });
  });

  test('at 200% text nothing clips: the bar grows, its controls stay 44px, the title keeps room (05i)', async ({
    page,
  }) => {
    await open(page, '/runs', 375, 812, false);
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    const bar = page.getByRole('banner');
    const boxes = [];
    for (const name of [/^Search everything/, /^Notifications/, 'Quick settings']) {
      const control = bar.getByRole('button', { name });
      const box = await boxOf(control);
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      boxes.push(box);
    }
    const barBox = await boxOf(bar);
    for (const box of boxes) {
      expect(box.y).toBeGreaterThanOrEqual(barBox.y);
      expect(box.y + box.height).toBeLessThanOrEqual(barBox.y + barBox.height);
    }
    // The trail still has room to name the page.
    const trail = await boxOf(bar.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(trail.width).toBeGreaterThan(40);
    await expectNoSidewaysScroll(page, '200% text on a phone');
    await captureForDesignReview(page, { route: '/runs', state: '200% text', source: SOURCE });

    await page.getByRole('button', { name: 'Open navigation' }).click();
    const rows = drawer(page).locator('a.cinder-side-navigation-item');
    const first = await boxOf(rows.first());
    const second = await boxOf(rows.nth(1));
    // Rows grow with the text and never overlap.
    expect(first.y + first.height).toBeLessThanOrEqual(second.y + 1);
    await captureForDesignReview(page, {
      route: '/',
      state: 'drawer open at 200% text',
      source: SOURCE,
    });
  });
});

test.describe('the top bar’s popovers on the sample world', () => {
  // Relative times and the 24-hour windows read the browser's clock, so it is the sample "now" in
  // the viewer's zone whether or not a capture pins it.
  test.use({ timezoneId: SAMPLE_TIME_ZONE });
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(SAMPLE_NOW);
  });

  test('the bell carries a dot, and its popover is titled with the unread count (03l, 02w, 02x)', async ({
    page,
    checkA11y,
  }) => {
    await open(page, '/', 1280);
    const bell = page.getByRole('banner').getByRole('button', { name: /^Notifications/ });
    await expect(bell).toHaveAccessibleName('Notifications: 3 unread');
    const dot = bell.locator('.weft-notification-bell__dot');
    await expect(dot).toBeVisible();
    expect(await widthOf(dot)).toBe(9);
    await expect(bell.locator('.weft-notification-bell__count')).toHaveCount(0);

    await bell.click();
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    await expect(panel).toBeVisible();
    expect(await widthOf(panel)).toBe(420);
    await expect(panel.getByRole('heading', { level: 2 })).toHaveText('Notifications 3 unread');
    await expect(panel.getByRole('button', { name: 'Mark all read' })).toBeVisible();
    // What the person's own hooks announced was cleared; nothing else is a raw event.
    await expect(panel.locator('[data-kind="notice"]')).toHaveCount(0);

    // What waits on the person comes first, newest first: the refund approval, then the question.
    const rows = panel.locator('.weft-notification-panel__item');
    // The bell lists what waits on the person, the failures and missed schedules, and the standing
    // rule: a chat that finished ("Assistant answered") is not an item.
    await expect(rows).toHaveCount(4);
    await expect(panel.getByText(/answered/i)).toHaveCount(0);
    await expect(rows.nth(0)).toContainText('Refund order 4471');
    await expect(rows.nth(0)).toContainText('Waiting for your approval, Tool runner');
    await expect(rows.nth(0).locator('.weft-notification-panel__item-time')).toHaveText('4 min');
    await expect(rows.nth(1)).toContainText('Which environment should the release go to?');
    await expect(rows.nth(1)).toContainText('Waiting for your answer, Request human input');
    await expect(rows.nth(1).locator('.weft-notification-panel__item-time')).toHaveText('1 h');
    for (const index of [0, 1]) {
      await expect(rows.nth(index)).toHaveAttribute('data-read', 'false');
      await expect(rows.nth(index).getByRole('img', { name: 'Unread' })).toBeVisible();
    }

    // Then the schedule that missed runs, at the time its newest miss was due.
    const missed = rows.nth(2);
    await expect(missed).toHaveAttribute('data-kind', 'missed');
    await expect(missed).toContainText('Daily summary missed its 3:00 AM run');
    await expect(missed).toContainText('4 missed since Oct 30, Assistant');
    await expect(missed.locator('.weft-notification-panel__item-time')).toHaveText('7 h');

    // The storage rule that is firing is listed read and does not count.
    const storage = rows.nth(3);
    await expect(storage).toHaveAttribute('data-kind', 'alert');
    await expect(storage).toContainText('Storage passed its warning level');
    await expect(storage).toContainText('1.6 GB used');
    await expect(storage).toHaveAttribute('data-read', 'true');
    await expect(storage.locator('.weft-notification-panel__item-time')).toHaveText('1 h');

    // The footer: the bell’s settings, and Hooks for email or webhooks.
    const links = panel.getByRole('navigation', { name: 'Where notifications are set up' });
    await expect(links.getByRole('link')).toHaveText([
      'Notification settings',
      'Email or webhooks: set up a hook ›',
    ]);
    await captureForDesignReview(page, {
      route: '/',
      state: 'notifications open',
      source: SOURCE,
    });
    await checkA11y('the notifications popover');
  });

  test('quick settings is the sliders icon: Theme, Sidebar and All settings, and no density (02y)', async ({
    page,
    checkA11y,
  }) => {
    await open(page, '/', 1280);
    const button = page.getByRole('banner').getByRole('button', { name: 'Quick settings' });
    await expect(button.locator('svg.lucide-sliders-horizontal')).toBeVisible();
    await button.click();

    const panel = page.getByRole('dialog', { name: 'Quick settings' });
    await expect(panel).toBeVisible();
    expect(await widthOf(panel)).toBe(300);
    await expect(panel.getByRole('heading', { name: 'Quick settings' })).toBeVisible();
    await expect(
      panel.getByRole('radiogroup', { name: 'Color theme' }).getByRole('radio'),
    ).toHaveCount(3);
    for (const name of ['Light', 'System', 'Dark']) {
      await expect(panel.getByRole('radio', { name })).toBeVisible();
    }
    await expect(panel.getByRole('radiogroup', { name: 'Sidebar' }).getByRole('radio')).toHaveText([
      'Expanded',
      'Collapsed',
    ]);
    await expect(panel.getByText(/density|comfortable|compact/i)).toHaveCount(0);
    const all = panel.getByRole('link', { name: 'All settings' });
    await expect(all.locator('svg.lucide-chevron-right')).toBeVisible();
    await captureForDesignReview(page, {
      route: '/',
      state: 'quick settings open',
      source: SOURCE,
    });
    await checkA11y('the quick settings popover');

    await all.click();
    await expect(page).toHaveURL(/\/settings$/);
  });

  test('the Sidebar choice folds the sidebar at 1200px and wider, and survives a reload (02y, 04b)', async ({
    page,
  }) => {
    await open(page, '/', 1280);
    await page.getByRole('banner').getByRole('button', { name: 'Quick settings' }).click();
    const panel = page.getByRole('dialog', { name: 'Quick settings' });
    await expect(panel.getByRole('radio', { name: 'Expanded' })).toBeChecked();

    await panel.getByRole('radio', { name: 'Collapsed' }).click();
    await expectWidth(sidebar(page), 56);
    await page.reload();
    await expectWidth(sidebar(page), 56);

    await page.getByRole('banner').getByRole('button', { name: 'Quick settings' }).click();
    await page
      .getByRole('dialog', { name: 'Quick settings' })
      .getByRole('radio', { name: 'Expanded' })
      .click();
    await expectWidth(sidebar(page), 190);
  });

  test('both popovers open as bottom sheets under 640px and fit the screen (05d)', async ({
    page,
  }) => {
    await open(page, '/', 375, 812, false);
    for (const [name, state] of [
      [/^Notifications/, 'notifications open'],
      ['Quick settings', 'quick settings open'],
    ] as const) {
      await page.getByRole('banner').getByRole('button', { name }).click();
      const dialog = page.getByRole('dialog').last();
      await expect(dialog).toBeVisible();
      const box = await boxOf(dialog);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
      await expectNoSidewaysScroll(page, 'a popover on a phone');
      await captureForDesignReview(page, { route: '/', state, source: SOURCE });
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
  });

  // Last in this describe: Mark all read tells the Bureau, which then holds the showcase host's
  // notifications as read for the rest of the run, and the specifications before it (and their
  // captures) read them as the sample world leaves them. Another specification that reads the
  // bell's unread state on the showcase host must not run after this one.
  test('Mark all read clears the dot and keeps the rows (02w)', async ({ page }) => {
    await open(page, '/', 1280);
    const bell = page.getByRole('banner').getByRole('button', { name: /^Notifications/ });
    await bell.click();
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    const rows = panel.locator('.weft-notification-panel__item');
    const before = await rows.count();

    await panel.getByRole('button', { name: 'Mark all read' }).click();

    await expect(rows.locator('[role="img"]')).toHaveCount(0);
    await expect(rows).toHaveCount(before);
    await expect(panel.getByRole('heading', { level: 2 })).toHaveText('Notifications');
    await expect(page.getByRole('banner').locator('.weft-notification-bell__dot')).toHaveCount(0);
  });
});
