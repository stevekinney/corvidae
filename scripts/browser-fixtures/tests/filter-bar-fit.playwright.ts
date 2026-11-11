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

test.describe('FilterBar measures its controls, not what they draw past their boxes', () => {
  // The clear button's 44px hit area runs past the search field's edge. Read from scrollWidth, a
  // typed query made a bar that fits fold the next time it measured (the agent Chats tab).
  test('a typed query and then a segment change keep a bar that fits wide', async ({ page }) => {
    await page.setViewportSize({ width: 2400, height: 900 });
    await page.goto(FILTER_BAR_ROUTE, { waitUntil: 'load' });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const bar = page.getByRole('search', { name: 'Workflow filters' });
    await setBarWidth(bar, 2000);
    await expect(bar).toHaveAttribute('data-cinder-layout', 'wide');
    // Exactly as wide as the wide form needs, with the search field at its end.
    await setBarWidth(bar, Math.ceil(await wideNeed(bar)) + 1);
    await expect(bar).toHaveAttribute('data-cinder-layout', 'wide');

    await bar.getByRole('searchbox').fill('needle');
    await expect(bar.getByRole('button', { name: /clear/i })).toBeVisible();
    await bar.getByRole('radio', { name: /^Running/ }).click();
    await expect(bar.getByRole('radio', { name: /^Running/ })).toBeChecked();
    await expect(bar).toHaveAttribute('data-cinder-layout', 'wide');
    await expect(bar.getByRole('radio', { name: /^Waiting on you/ })).toBeVisible();
  });
});

/** Whether the folded Status select shows its prefix and its value, and cuts the value short. */
async function statusTrigger(bar: Locator): Promise<{
  valueText: string;
  valueClipped: boolean;
  valueShown: boolean;
  prefixShown: boolean;
  besideFilter: boolean;
}> {
  return bar.evaluate((element) => {
    const text = element.querySelector<HTMLElement>(
      '.cinder-filter-bar__segments-select .cinder-select__text',
    );
    const value = text?.querySelector<HTMLElement>('.cinder-select__value');
    const prefix = text?.querySelector<HTMLElement>('.cinder-select__prefix');
    const select = element.querySelector<HTMLElement>('.cinder-filter-bar__segments-select');
    const filter = element.querySelector<HTMLElement>('.cinder-filter-bar__menu-button');
    if (!text || !value || !prefix || !select || !filter) {
      throw new Error('The folded bar drew no prefixed Status select and Filter button');
    }
    const shown = text.getBoundingClientRect();
    const inView = (part: HTMLElement): boolean => {
      const box = part.getBoundingClientRect();
      return box.width > 0 && box.top >= shown.top - 1 && box.bottom <= shown.bottom + 1;
    };
    return {
      valueText: value.textContent ?? '',
      valueClipped: value.scrollWidth > value.clientWidth,
      valueShown: inView(value),
      prefixShown: inView(prefix),
      besideFilter:
        Math.abs(select.getBoundingClientRect().top - filter.getBoundingClientRect().top) < 1,
    };
  });
}

test.describe('FilterBar folded Status select at 200% text (WCAG 1.4.4)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(FILTER_BAR_ROUTE, { waitUntil: 'load' });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
  });

  test('keeps the whole value in view, moving the Filter button under it, named Status', async ({
    page,
  }) => {
    const bar = page.getByRole('search', { name: 'Workflow filters' });
    await expect(bar).toHaveAttribute('data-cinder-layout', 'narrow');
    const trigger = bar.getByRole('combobox', { name: 'Status', exact: true });
    await expect(trigger).toBeVisible();

    // At the default size the select, its prefix and its whole value share a line with Filter,
    // at a phone's width and at the narrowest one.
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 812 });
      await expect.poll(() => statusTrigger(bar).then((state) => state.besideFilter)).toBe(true);
      expect(await statusTrigger(bar)).toMatchObject({
        prefixShown: true,
        valueShown: true,
        valueClipped: false,
      });
    }

    // At 200% text the Filter button moves under the select, and the whole value stays in view.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await expect.poll(() => statusTrigger(bar).then((state) => state.besideFilter)).toBe(false);
    expect(await statusTrigger(bar)).toMatchObject({
      valueText: 'All 19',
      valueShown: true,
      valueClipped: false,
    });
    expect(await rowOverflow(bar)).toBeLessThanOrEqual(0);
    // The prefix is not part of the name; the label names the control.
    await expect(trigger).toHaveAccessibleName('Status');
  });

  test('drops the visible "Status:" prefix before it truncates the value', async ({ page }) => {
    const bar = page.getByRole('search', { name: 'Workflow filters' });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    // A bar about as wide as the select needs for its value alone, not for "Status:" as well.
    await setBarWidth(bar, 220);
    await expect(bar).toHaveAttribute('data-cinder-layout', 'narrow');
    await expect.poll(() => statusTrigger(bar).then((state) => state.prefixShown)).toBe(false);
    expect(await statusTrigger(bar)).toMatchObject({
      valueText: 'All 19',
      valueShown: true,
      valueClipped: false,
    });
    expect(await rowOverflow(bar)).toBeLessThanOrEqual(0);
  });
});
