import { runAxe } from '@lostgradient/testing';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

// COR-1999. axe's `scrollable-region-focusable` rule fails a scrolling element that
// neither is in the tab order, holds something that is, nor is the popup of a
// `role="combobox"`. A popup whose rows are reached with the arrow keys looks exactly
// like that to axe, but only once it overflows, so a fixture with a handful of rows
// never shows it. This guard forces the overflow with a viewport shorter than every
// popup's content and runs the rule on each popup that scrolls. A new scroller that
// fails is caught by adding its row here.
//
// It lives in the browser fixtures because that is where Cinder components mount in a
// real browser: the unit tests run in happy-dom, which has no layout, so `scrollHeight`
// means nothing there.

/** axe ignores an overflow of up to 13px, so the guard requires more than that. */
const AXE_SCROLL_BUFFER = 13;
const forcedOverflowViewport = { width: 1000, height: 90 } as const;

type Scenario = {
  name: string;
  slug: string;
  viewport?: { width: number; height: number };
  open: (page: Page) => Promise<void>;
  /** The element that scrolls once the viewport is short. */
  scroller: string;
  /**
   * Moves to the last row from the keyboard and returns the row that must then be in view.
   * Left out for popups this change does not touch the keyboard model of.
   */
  reachLastRow?: (page: Page) => Promise<Locator>;
  /** A viewport that still overflows but is tall enough to show one whole row. */
  keyboardViewport?: { width: number; height: number };
};

async function focusedMenuItemThenEnd(page: Page): Promise<Locator> {
  const focused = page.locator('[role^="menuitem"]:focus');
  await expect(focused).toHaveCount(1);
  await page.keyboard.press('End');
  const last = page.locator('[role^="menuitem"]:focus');
  await expect(last).toHaveCount(1);
  return last;
}

const scenarios: Scenario[] = [
  {
    name: 'Combobox',
    slug: 'combobox',
    open: async (page) => page.locator('#fruit').click(),
    scroller: '.cinder-combobox__panel',
    reachLastRow: async (page) => {
      await page.keyboard.press('End');
      const active = page.locator('.cinder-combobox__panel [role="option"][data-cinder-active]');
      await expect(active).toHaveText(/Raspberry/);
      return active;
    },
  },
  {
    name: 'MultiSelect',
    slug: 'multi-select',
    open: async (page) => page.locator('.cinder-multi-select__trigger').click(),
    scroller: '.cinder-multi-select__listbox',
  },
  {
    name: 'CommandPalette',
    slug: 'command-palette',
    open: async (page) => page.getByRole('button', { name: 'Open palette' }).click(),
    scroller: '.cinder-command-palette__listbox',
  },
  {
    name: 'Dropdown',
    slug: 'dropdown',
    open: async (page) => page.getByRole('button', { name: 'Options' }).click(),
    scroller: '#dropdown-menu',
    reachLastRow: focusedMenuItemThenEnd,
  },
  {
    name: 'Dropdown (docked)',
    slug: 'dropdown',
    viewport: { width: 400, height: forcedOverflowViewport.height },
    open: async (page) => page.getByRole('button', { name: 'Options' }).click(),
    scroller: '#dropdown-menu',
    reachLastRow: focusedMenuItemThenEnd,
  },
  {
    name: 'ContextMenu',
    slug: 'context-menu',
    open: async (page) => page.getByText('Right-click this region').click({ button: 'right' }),
    scroller: '[role="menu"]',
  },
  {
    name: 'MenuBar',
    slug: 'menu-bar',
    open: async (page) => page.getByRole('menuitem', { name: 'File' }).click(),
    scroller: '.cinder-menu-bar__dropdown-menu',
  },
  {
    name: 'SpeedDial',
    slug: 'speed-dial',
    open: async (page) => page.locator('.cinder-speed-dial__trigger button').click(),
    scroller: '.cinder-speed-dial__actions',
  },
  {
    name: 'CommandMenu',
    slug: 'command-menu',
    open: async (page) => page.getByLabel('Notes').fill('/'),
    scroller: '.cinder-command-menu__listbox',
    keyboardViewport: { width: 1000, height: 220 },
    reachLastRow: async (page) => {
      await page.keyboard.press('End');
      const active = page.locator('.cinder-command-menu [role="option"][aria-selected="true"]');
      await expect(active).toHaveText(/Code/);
      return active;
    },
  },
];

async function openPopup(
  page: Page,
  scenario: Scenario,
  viewport: { width: number; height: number },
): Promise<Locator> {
  await page.setViewportSize(viewport);
  await page.goto(fixtureRoute(scenario.slug));
  await scenario.open(page);
  const scroller = page.locator(scenario.scroller).first();
  await expect(scroller).toBeVisible();
  return scroller;
}

for (const scenario of scenarios) {
  test.describe(`${scenario.name} popup scroller`, () => {
    test('passes scrollable-region-focusable once it overflows', async ({ page }) => {
      const scroller = await openPopup(page, scenario, scenario.viewport ?? forcedOverflowViewport);
      const { clientHeight, scrollHeight } = await scroller.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
      // Without this the rule could pass because nothing scrolls.
      expect(scrollHeight - AXE_SCROLL_BUFFER).toBeGreaterThan(clientHeight);

      const buckets = await runAxe(
        page,
        { slug: scenario.slug, theme: 'light', viewport: 'desktop', fixture: 'popup-scroller' },
        { include: scenario.scroller },
      );
      const violations = Object.values(buckets)
        .flat()
        .filter((violation) => violation.id === 'scrollable-region-focusable');
      expect(violations.map((violation) => violation.nodes.map((node) => node.html))).toEqual([]);
    });

    const reachLastRow = scenario.reachLastRow;
    if (reachLastRow === undefined) return;
    test('the last row scrolls into view from the keyboard', async ({ page }) => {
      const scroller = await openPopup(
        page,
        scenario,
        scenario.keyboardViewport ?? scenario.viewport ?? forcedOverflowViewport,
      );
      const lastRow = await reachLastRow(page);
      expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      const scrollerBox = await scroller.boundingBox();
      const rowBox = await lastRow.boundingBox();
      expect(scrollerBox).not.toBeNull();
      expect(rowBox).not.toBeNull();
      expect(rowBox!.y).toBeGreaterThanOrEqual(scrollerBox!.y - 1);
      expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(
        scrollerBox!.y + scrollerBox!.height + 1,
      );
    });
  });
}
