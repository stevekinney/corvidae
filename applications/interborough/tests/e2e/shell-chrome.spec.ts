/**
 * The shell's chrome on the sample world (`fixtures/sample-world-seed.ts`, the showcase host), in
 * every form it takes and at every width the design draws (COR-2015, design rows 03a to 03m, 04a to
 * 04f, 05h, 05i, 05r, 07h, 07k): the 190px sidebar, the 56px rail with its tooltips, the rail's
 * overlay on a tablet, the 280px drawer on a phone and on a touch tablet, the 320px floor and 200%
 * text size. Each captioned state is captured for the design review under its own name.
 *
 * Reviews shows the two reviews waiting on the person, and Health an amber dot named "Health, 3
 * need attention", which the sample world's attention feed (`bureau.health.attention`) holds.
 */
import type { Locator, Page } from '@playwright/test';

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
  counts = width >= 640,
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
    const count = reviews.locator('.cinder-side-navigation-item__count');
    expect(await widthOf(count)).toBeGreaterThan(8);
    await expect(count).toHaveText('2');
    const health = navigation(page).getByRole('link', { name: HEALTH });
    expect(await widthOf(health.locator('.cinder-status-dot'))).toBeGreaterThan(4);
    const groups = navigation(page).locator('.cinder-side-navigation-group');
    await expect(groups.first()).toHaveCSS('border-top-width', '1px');

    // Hovering a row names it in a tooltip, with its count.
    await reviews.hover();
    await expect(page.getByRole('tooltip')).toContainText('Reviews · 2 need you');
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

test.describe('on a tablet with a fine pointer', () => {
  test('the sidebar is the 56px rail, and expanding opens the column over the page, closing on navigation (04a)', async ({
    page,
  }) => {
    await open(page, '/health', 768);
    await expectWidth(sidebar(page), 56);
    await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(0);
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
    await expectWidth(sidebar(page), 56);
  });

  test('Escape closes the overlay, and the quick settings preference does not apply here (04b)', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('interborough-sidebar-collapsed', 'false');
    });
    await open(page, '/', 768);
    // Whatever the preference says, below 1024px the rail rule wins.
    await expectWidth(sidebar(page), 56);
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await expectWidth(sidebar(page), 190);
    await page.keyboard.press('Escape');
    await expectWidth(sidebar(page), 56);
    expect(
      await page.evaluate(() => window.localStorage.getItem('interborough-sidebar-collapsed')),
    ).toBe('false');
  });

  test('a preference to fold the sidebar applies from 1024px, and only there (04b)', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('interborough-sidebar-collapsed', 'true');
    });
    await open(page, '/', 1024);
    await expectWidth(sidebar(page), 56);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expectWidth(sidebar(page), 56);
  });
});

test.describe('on a phone', () => {
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
    await open(page, '/agents/demo:assistant/memories', 375, 812, false);
    const trail = page.getByRole('banner').getByRole('navigation', { name: 'Breadcrumb' });
    await expect(trail.getByRole('link', { name: /Back to/ })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/agents/:agent/memories',
      state: 'back button',
      source: SOURCE,
    });
  });

  test('an ancestor that cannot show its first word folds into a "…" menu (S18)', async ({
    page,
  }) => {
    await open(page, '/agents/demo:assistant/memories', 1280);
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

  test('the menu button and the same 280px drawer replace the rail, 44px rows (04c, 07h)', async ({
    page,
  }) => {
    await open(page, '/', 768, 1024, false);
    await expect(sidebar(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const panel = drawer(page);
    await expect(panel).toBeVisible();
    await expectWidth(panel.locator('.cinder-drawer__panel'), 280);
    await expect(panel.locator('.cinder-drawer__title')).toHaveText('Interborough');
    await expect(panel.getByRole('button', { name: 'Close navigation' })).toBeVisible();
    for (const row of await panel.locator('a.cinder-side-navigation-item').all()) {
      expect(await heightOf(row)).toBeGreaterThanOrEqual(44);
    }
    await expect(
      page.getByRole('banner').getByRole('button', { name: /^Search everything/ }),
    ).toContainText('⌘K');
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
