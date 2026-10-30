import { expect, test, type Locator, type Page } from '@playwright/test';
import { fixtureEntry, fixtureRoute } from './layout-fixture.ts';

/**
 * COR-1831: Cinder's responsive building blocks at a phone (375px) and a
 * tablet (768px) viewport. Below 640px a table stacks its rows, a popover
 * opens as a bottom sheet, and the sidebar folds into a drawer; from 640px up
 * the sidebar stays inline, so a tablet keeps its collapsed icon rail.
 */

const PHONE = { width: 375, height: 812 } as const;
const TABLET = { width: 768, height: 1024 } as const;

function namedFixtureRoute(slug: string, name: string): string {
  const fixture = fixtureEntry(slug).fixtures?.find((candidate) => candidate.name === name);
  if (fixture === undefined) throw new Error(`Missing ${name} fixture for ${slug}`);
  const query = new URLSearchParams({
    snapshot: '1',
    fixture: fixture.name,
    fixtureContentHash: fixture.fixtureContentHash,
  });
  return `${fixtureEntry(slug).route}?${query.toString()}`;
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

async function boxOf(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('Locator has no box.');
  return box;
}

async function bottomEdgeOf(locator: Locator): Promise<number> {
  const box = await boxOf(locator);
  return box.y + box.height;
}

async function widthOf(locator: Locator): Promise<number> {
  const box = await boxOf(locator);
  return box.width;
}

/** Asserts the element spans the viewport width and rests on its bottom edge. */
async function expectBottomSheet(page: Page, sheet: Locator): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('No viewport.');
  const box = await boxOf(sheet);
  expect(box.x).toBeCloseTo(0, 0);
  expect(box.width).toBeCloseTo(viewport.width, 0);
  expect(box.y + box.height).toBeCloseTo(viewport.height, 0);
}

test.describe('at a 375px phone viewport', () => {
  test.use({ viewport: PHONE });

  test('a table stacks each row into labelled values', async ({ page }) => {
    await page.goto(namedFixtureRoute('table', 'contributors'));
    const table = page.getByRole('table', { name: 'Recent contributors' });
    await expect(table).toHaveAttribute('data-cinder-stacked', 'true');

    // The header row leaves the layout but keeps the column names for
    // assistive technology.
    const header = table.locator('thead');
    const headerBox = await boxOf(header);
    expect(headerBox.height).toBeLessThanOrEqual(1);
    await expect(table.getByRole('columnheader', { name: 'Role' })).toBeAttached();

    // Each value sits under its column's name, inside one block per row.
    const firstRow = table.locator('tbody tr').first();
    const roleCell = firstRow.locator('td').filter({ hasText: 'Mathematician' });
    await expect(roleCell).toHaveAttribute('data-cinder-stack-label', 'Role');
    expect(await roleCell.evaluate((cell) => getComputedStyle(cell, '::before').content)).toBe(
      '"Role"',
    );
    const nameBox = await boxOf(firstRow.locator('td').filter({ hasText: 'Ada Lovelace' }));
    const roleBox = await boxOf(roleCell);
    expect(roleBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 1);
    expect(roleBox.x).toBeCloseTo(nameBox.x, 0);

    await expectNoSidewaysScroll(page);
  });

  test('a popover that takes focus opens as the bottom Drawer', async ({ page }) => {
    await page.goto(fixtureRoute('popover'));
    await page.getByTestId('transformed-popover-trigger').click();

    const drawer = page.getByRole('dialog', { name: 'Transformed ancestor popover' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('Anchored popover')).toBeVisible();
    const panel = drawer.locator('.cinder-drawer__panel[data-cinder-placement="bottom"]');
    await expect(panel).toBeVisible();
    // Let the slide-in transition settle before measuring.
    await expect(panel).not.toHaveAttribute('data-cinder-closing');
    await expect.poll(() => bottomEdgeOf(panel)).toBeCloseTo(PHONE.height, 0);
    await expectBottomSheet(page, panel);

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(page.getByTestId('transformed-popover-trigger')).toBeFocused();
  });

  test('a popover that keeps focus on its trigger docks to the bottom edge', async ({ page }) => {
    await page.goto(fixtureRoute('popover'));
    const trigger = page.getByRole('button', { name: 'Account settings' });
    await trigger.click();

    const sheet = page.locator('.cinder-popover[data-cinder-sheet="docked"]');
    await expect(sheet).toBeVisible();
    await expectBottomSheet(page, sheet);
    await expect(trigger).toBeFocused();
  });

  test('the sidebar folds into a drawer behind its toggle', async ({ page }) => {
    await page.goto(fixtureRoute('sidebar'));
    await expect(page.locator('aside.cinder-sidebar')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Workspace sections' })).toBeHidden();

    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    const drawer = page.getByRole('dialog', { name: 'Workspace' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('navigation', { name: 'Workspace sections' })).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
});

test.describe('at a 768px tablet viewport', () => {
  test.use({ viewport: TABLET });

  test('the sidebar stays inline and collapses to its icon rail', async ({ page }) => {
    await page.goto(fixtureRoute('sidebar'));
    const aside = page.getByRole('complementary', { name: 'Workspace' });
    await expect(aside).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Workspace' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(aside).toHaveAttribute('data-cinder-collapsed', '');
    await expect(aside).toBeVisible();
    // The rail is the 4rem icon column, not a hidden drawer.
    await expect.poll(() => widthOf(aside)).toBeCloseTo(64, 0);
    await expect(aside.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  });

  test('a table keeps its columns and a popover stays anchored', async ({ page }) => {
    await page.goto(namedFixtureRoute('table', 'contributors'));
    await expect(page.getByRole('table', { name: 'Recent contributors' })).not.toHaveAttribute(
      'data-cinder-stacked',
    );

    await page.goto(fixtureRoute('popover'));
    await page.getByTestId('transformed-popover-trigger').click();
    const panel = page.locator('.transformed-ancestor-popover-panel');
    await expect(panel).toBeVisible();
    await expect(panel).not.toHaveAttribute('data-cinder-sheet');
    await expect(page.locator('dialog.cinder-drawer')).toHaveCount(0);
  });
});
