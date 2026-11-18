/**
 * COR-2327 (owner, 2026-11-16): on a 320px phone the waiting approval's input started about 55px
 * in, past a chevron column and an "Input" column. Then one label-over-value pair per line left most
 * of a wide card empty. The input is now DescriptionList's grid in the open, at the card's content
 * edge: as many columns as the card's own width fits, each label over its value, a long value on a
 * row of its own, and a short input (three pairs) draws no "Show all". It holds at every density.
 */
import { loadManifest, type Viewport } from '@lostgradient/testing';
import { expect, test } from '@lostgradient/testing/playwright/component-page-fixture';
import type { Page } from '@playwright/test';

const narrowPhone = { name: 'mobile', width: 320, height: 640 } as const satisfies Viewport;
const desktop = { name: 'desktop', width: 1280, height: 900 } as const satisfies Viewport;
const DENSITIES = ['default', 'compact', 'comfortable'] as const;

function requiredEntry(slug: string) {
  const entry = loadManifest().find((candidate) => candidate.slug === slug);
  if (entry === undefined) throw new Error(`Cached testing manifest does not include "${slug}".`);
  return entry;
}

const approvalEntry = requiredEntry('approval-card');

/** Sets the page's density the way a host does, on the root, or leaves the default. */
async function useDensity(page: Page, density: (typeof DENSITIES)[number]): Promise<void> {
  if (density === 'default') return;
  await page.evaluate(
    (value) => document.documentElement.setAttribute('data-density', value),
    density,
  );
}

/** The row card's title and its input pairs, read in one layout pass. */
async function readRowCard(page: Page) {
  return page.evaluate(() => {
    const card = document.querySelector('#approval-card-row-chat');
    const title = card?.querySelector('.cinder-approval-card__row-question');
    const rows = [...(card?.querySelectorAll('.cinder-description-list__row') ?? [])];
    if (title == null || rows.length === 0) return null;
    return {
      title: title.getBoundingClientRect().left,
      pairs: rows.map((row) => {
        const term = row.querySelector('dt')!.getBoundingClientRect();
        const value = row.querySelector('dd')!.getBoundingClientRect();
        return {
          termLeft: term.left,
          termBottom: term.bottom,
          valueLeft: value.left,
          valueTop: value.top,
          top: row.getBoundingClientRect().top,
        };
      }),
    };
  });
}

test.describe('Approval input grid', () => {
  for (const density of DENSITIES) {
    test(`at 320px (${density}) the first value starts on the title’s left edge, under its label, and three pairs draw no Show all`, async ({
      componentPage,
    }) => {
      const page = await componentPage.open({
        entry: approvalEntry,
        theme: 'light',
        viewport: narrowPhone,
      });
      await useDensity(page, density);
      const card = page.locator('#approval-card-row-chat');
      await expect(card.getByRole('group', { name: 'Input' })).toBeVisible();

      // Both edges in one read, so a layout pass between two reads cannot skew the comparison.
      const read = await readRowCard(page);
      expect(read).not.toBeNull();
      const first = read!.pairs[0]!;
      expect(Math.abs(first.valueLeft - read!.title)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(first.termLeft - read!.title)).toBeLessThanOrEqual(0.5);
      // The value sits under its label: no column of labels beside a column of values.
      expect(first.valueTop).toBeGreaterThanOrEqual(first.termBottom - 0.5);
      // Even the narrowest phone card fits two pairs to a row: the second shares the first's row,
      // and the third starts the next.
      const second = read!.pairs[1]!;
      const third = read!.pairs[2]!;
      expect(Math.abs(second.top - first.top)).toBeLessThanOrEqual(0.5);
      expect(second.termLeft).toBeGreaterThan(first.termLeft);
      expect(third.top).toBeGreaterThan(first.top);
      await expect(card.getByRole('button', { name: /^Show all/ })).toHaveCount(0);
      await expect(card.getByRole('button', { name: /^Input/ })).toHaveCount(0);
    });

    test(`in a wide card (${density}) the three short pairs share one row, each starting its own column`, async ({
      componentPage,
    }) => {
      const page = await componentPage.open({
        entry: approvalEntry,
        theme: 'light',
        viewport: desktop,
      });
      await useDensity(page, density);
      await expect(
        page.locator('#approval-card-row-chat').getByRole('group', { name: 'Input' }),
      ).toBeVisible();

      const read = await readRowCard(page);
      expect(read).not.toBeNull();
      const [first, second, third] = read!.pairs;
      expect(read!.pairs).toHaveLength(3);
      // One row: equal tops. Three columns, left to right in reading order.
      expect(Math.abs(second!.top - first!.top)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(third!.top - first!.top)).toBeLessThanOrEqual(0.5);
      expect(first!.termLeft).toBeLessThan(second!.termLeft);
      expect(second!.termLeft).toBeLessThan(third!.termLeft);
      expect(Math.abs(first!.valueLeft - read!.title)).toBeLessThanOrEqual(0.5);
    });
  }

  test('a narrow card drops the tool’s name from its line and keeps who asked; a wide card keeps both', async ({
    componentPage,
  }) => {
    for (const [viewport, dropped] of [
      [narrowPhone, true],
      [desktop, false],
    ] as const) {
      const page = await componentPage.open({ entry: approvalEntry, theme: 'light', viewport });
      await expect(page.locator('#approval-card-row-chat')).toBeVisible();
      // One read: whether the name is drawn, and what the line reads as it is drawn.
      const read = await page.evaluate(() => {
        const card = document.querySelector('#approval-card-row-chat')!;
        const name = card.querySelector<HTMLElement>('.cinder-approval-card__line-tool-name')!;
        const line = card.querySelector<HTMLElement>('.cinder-approval-card__line')!;
        return {
          nameDrawn: name.getClientRects().length > 0,
          lineText: line.innerText.replace(/\s+/g, ' ').trim(),
        };
      });
      expect(read.nameDrawn, viewport.name).toBe(!dropped);
      expect(read.lineText, viewport.name).toContain('Approval from Tool runner');
      if (dropped) expect(read.lineText).not.toContain('Issue refund');
      else expect(read.lineText).toContain('Issue refund');
    }
  });

  test('a long value takes the whole row, and Show all 9 opens the rest in place', async ({
    componentPage,
  }) => {
    const page = await componentPage.open({
      entry: approvalEntry,
      theme: 'light',
      viewport: desktop,
    });
    const card = page.locator('#approval-card-decision-long');
    const input = card.getByRole('group', { name: 'Input' });
    await expect(input).toBeVisible();

    const read = await page.evaluate(() => {
      const list = document.querySelector('#approval-card-decision-long .cinder-description-list');
      const rows = [...(list?.querySelectorAll('.cinder-description-list__row') ?? [])];
      if (list == null || rows.length < 4) return null;
      const box = list.getBoundingClientRect();
      return {
        list: { left: box.left, width: box.width },
        rows: rows.map((row) => {
          const rowBox = row.getBoundingClientRect();
          return {
            left: rowBox.left,
            top: rowBox.top,
            width: rowBox.width,
            wide: row.hasAttribute('data-cinder-wide'),
          };
        }),
      };
    });
    expect(read).not.toBeNull();
    const [orderId, carrier, reference, service] = read!.rows;
    expect(reference!.wide).toBe(true);
    // The reference spans the list; the short pairs before it share a row, the one after starts a new one.
    expect(Math.abs(reference!.width - read!.list.width)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(reference!.left - read!.list.left)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(carrier!.top - orderId!.top)).toBeLessThanOrEqual(0.5);
    expect(reference!.top).toBeGreaterThan(orderId!.top);
    expect(service!.top).toBeGreaterThan(reference!.top);

    const toggle = card.getByRole('button', { name: 'Show all 9' });
    await expect(input.locator('.cinder-description-list__row:visible')).toHaveCount(4);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(input.locator('.cinder-description-list__row:visible')).toHaveCount(9);
    await expect(card.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});
