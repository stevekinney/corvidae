import { expect, type Locator, test } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

const FILTER_BAR_ROUTE = fixtureRoute('filter-bar');

/**
 * What the wide form's controls need, measured in a bar wide enough to hold them: every control at
 * its own width and margins (the segmented track has a negative one), the gaps between them, and
 * the search field at its flex basis, which is the least it is drawn at before the bar folds.
 */
async function wideNeed(bar: Locator): Promise<number> {
  return bar.evaluate((element) => {
    const row = element.querySelector<HTMLElement>('.cinder-filter-bar__row');
    if (row === null) throw new Error('The bar drew no row');
    const items: HTMLElement[] = [];
    const collect = (parent: Element): void => {
      for (const child of parent.children) {
        if (!(child instanceof HTMLElement)) continue;
        const style = getComputedStyle(child);
        if (style.display === 'contents') collect(child);
        else if (style.display !== 'none' && style.position !== 'absolute') items.push(child);
      }
    };
    collect(row);
    const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
    let need = gap * Math.max(0, items.length - 1);
    for (const item of items) {
      const style = getComputedStyle(item);
      need += item.classList.contains('cinder-filter-bar__search')
        ? Number.parseFloat(style.flexBasis)
        : item.getBoundingClientRect().width +
          Number.parseFloat(style.marginLeft) +
          Number.parseFloat(style.marginRight);
    }
    return need;
  });
}

async function setBarWidth(bar: Locator, width: number): Promise<void> {
  await bar.evaluate((element, inlineSize) => {
    (element as HTMLElement).style.inlineSize = `${String(inlineSize)}px`;
  }, width);
}

async function rowOverflow(bar: Locator): Promise<number> {
  return bar.evaluate((element) => {
    const row = element.querySelector<HTMLElement>('.cinder-filter-bar__row');
    if (row === null) throw new Error('The bar drew no row');
    return row.scrollWidth - row.clientWidth;
  });
}

test.describe('FilterBar folds by its measured width', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 2400, height: 900 });
    await page.goto(FILTER_BAR_ROUTE, { waitUntil: 'load' });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
  });

  test('stays wide down to the width its controls need, folds just under it, and unfolds when it widens', async ({
    page,
  }) => {
    const bar = page.getByRole('search', { name: 'Workflow filters' });
    await setBarWidth(bar, 2000);
    await expect(bar).toHaveAttribute('data-cinder-layout', 'wide');
    // The applied chip is part of the row the bar must fit.
    await expect(
      bar.getByRole('button', { name: 'Agent: Tool runner', exact: true }),
    ).toBeVisible();
    const need = Math.ceil(await wideNeed(bar));

    await setBarWidth(bar, need + 2);
    await expect(bar).toHaveAttribute('data-cinder-layout', 'wide');
    expect(await rowOverflow(bar)).toBeLessThanOrEqual(0);

    await setBarWidth(bar, need - 4);
    await expect(bar).toHaveAttribute('data-cinder-layout', 'medium');
    expect(await rowOverflow(bar)).toBeLessThanOrEqual(0);

    await setBarWidth(bar, 320);
    await expect(bar).toHaveAttribute('data-cinder-layout', 'narrow');
    expect(await rowOverflow(bar)).toBeLessThanOrEqual(0);

    await setBarWidth(bar, need + 2);
    await expect(bar).toHaveAttribute('data-cinder-layout', 'wide');
    expect(await rowOverflow(bar)).toBeLessThanOrEqual(0);
  });

  test('a folded bar unfolds once a removed chip makes room, with focus on the chip that is left', async ({
    page,
  }) => {
    const bar = page.getByRole('search', { name: 'Workflow filters' });
    await setBarWidth(bar, 2000);
    await expect(bar).toHaveAttribute('data-cinder-layout', 'wide');
    const need = Math.ceil(await wideNeed(bar));

    await setBarWidth(bar, need - 4);
    await expect(bar).toHaveAttribute('data-cinder-layout', 'medium');

    // The applied chip is wider than the add chip it becomes, so the wide form fits again. The
    // chips are kept between the wide and medium forms, so unfolding leaves focus where it lands.
    await bar.getByRole('button', { name: 'Remove filter: Agent: Tool runner' }).click();
    await expect(bar).toHaveAttribute('data-cinder-layout', 'wide');
    await expect(bar.getByRole('button', { name: 'Agent', exact: true })).toBeFocused();
    expect(await rowOverflow(bar)).toBeLessThanOrEqual(0);
  });
});
