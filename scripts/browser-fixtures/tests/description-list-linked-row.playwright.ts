/// <reference lib="dom" />
/**
 * COR-2444: a linked DescriptionList `fields` row draws its hover tint and focus ring on the link's
 * `::after`, behind the row's text. On a flat list the box reaches `--cinder-space-3` past the row's
 * start with the control radius, so the tint never starts at the text and the ring never crosses
 * the label's first glyph; on a framed list it reaches the group's start edge with no untinted
 * strip. A framed group takes the raised fill below 700px of its own width. Measured on the DescriptionList
 * `assertion` fixture, whose flat and framed `fields` lists each start with a linked row.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test, type Page } from '@playwright/test';

type Layer = {
  list: number;
  term: number;
  tintStart: number;
  background: string;
  radius: string;
  ring: string;
};

async function open(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(fixtureRoute('description-list'), { waitUntil: 'load' });
  await page.locator('.cinder-description-list__link').first().waitFor({ state: 'visible' });
}

/** The `::after` layer of the first linked row of the `fields` list in `testId`. */
async function layer(page: Page, testId: string): Promise<Layer> {
  return page.evaluate((id) => {
    const list = document.querySelector(`[data-testid="${id}"] dl`);
    const row = list?.querySelector('.cinder-description-list__row[data-cinder-linked]');
    const link = row?.querySelector('.cinder-description-list__link');
    const term = row?.querySelector('dt');
    if (!list || !row || !link || !term) throw new Error(`no linked row in ${id}`);
    const after = getComputedStyle(link, '::after');
    return {
      list: list.getBoundingClientRect().left,
      term: term.getBoundingClientRect().left,
      // The layer is positioned in the row's padding box, which starts at the row's border edge.
      tintStart: row.getBoundingClientRect().left + Number.parseFloat(after.left),
      background: after.backgroundColor,
      radius: after.borderTopLeftRadius,
      ring: after.boxShadow,
    };
  }, testId);
}

/** Whether a click on the linked row's label lands on its link: the whole row is the target. */
async function labelHitsLink(page: Page, testId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const row = document.querySelector(`[data-testid="${id}"] [data-cinder-linked]`);
    const term = row?.querySelector('dt')?.getBoundingClientRect();
    if (!row || !term) return false;
    const hit = document.elementFromPoint(term.left + 4, term.top + term.height / 2);
    return hit !== null && hit.closest('.cinder-description-list__link') !== null;
  }, testId);
}

async function token(page: Page, property: string, name: string): Promise<string> {
  return page.evaluate(
    ([cssProperty, tokenName]) => {
      const probe = document.createElement('div');
      probe.style.setProperty(cssProperty, `var(${tokenName})`);
      document.body.append(probe);
      const value = getComputedStyle(probe).getPropertyValue(cssProperty);
      probe.remove();
      return value;
    },
    [property, name] as const,
  );
}

test('a flat linked row tints from 12px before its label, rounded like a control', async ({
  page,
}) => {
  await open(page, 1280);
  // The link's hit area covers the whole row, so hovering the row lands on the link.
  await page.getByTestId('description-list-fields-flat').locator('[data-cinder-linked]').hover();
  expect(await labelHitsLink(page, 'description-list-fields-flat')).toBe(true);
  const flat = await layer(page, 'description-list-fields-flat');
  expect(flat.background).toBe(await token(page, 'background-color', '--cinder-surface-hover'));
  expect(flat.term - flat.tintStart).toBeCloseTo(12, 0);
  expect(flat.radius).toBe(await token(page, 'border-top-left-radius', '--cinder-radius-control'));
});

test('a framed linked row tints from the group edge, leaving no untinted strip', async ({
  page,
}) => {
  await open(page, 1280);
  await page.getByTestId('description-list-fields-framed').locator('[data-cinder-linked]').hover();
  expect(await labelHitsLink(page, 'description-list-fields-framed')).toBe(true);
  const framed = await layer(page, 'description-list-fields-framed');
  expect(framed.background).toBe(await token(page, 'background-color', '--cinder-surface-hover'));
  expect(Math.abs(framed.tintStart - framed.list)).toBeLessThan(1);
  expect(framed.radius).toBe('0px');
});

test("a focused link's ring sits on the same layer, clear of the label's first glyph", async ({
  page,
}) => {
  await open(page, 1280);
  await page.getByTestId('description-list-fields-flat').locator('a').first().focus();
  const flat = await layer(page, 'description-list-fields-flat');
  expect(flat.ring).not.toBe('none');
  expect(flat.term - flat.tintStart).toBeCloseTo(12, 0);
  await page.getByTestId('description-list-fields-framed').locator('a').first().focus();
  const framed = await layer(page, 'description-list-fields-framed');
  expect(framed.ring).not.toBe('none');
  expect(Math.abs(framed.tintStart - framed.list)).toBeLessThan(1);
});

test('a framed group takes the raised fill below 700px of its own width and the inset tint at 700 or wider (COR-2394)', async ({
  page,
}) => {
  // The group's fill is the list's `::before`, so a container query on the list can switch it.
  const framed = page.getByTestId('description-list-fields-framed');
  const read = () =>
    framed.locator('dl').evaluate((list) => ({
      width: list.getBoundingClientRect().width,
      fill: getComputedStyle(list, '::before').backgroundColor,
    }));
  const raised = async () => token(page, 'background-color', '--cinder-surface-raised');
  const inset = async () => token(page, 'background-color', '--cinder-surface-inset');

  await open(page, 375);
  const phone = await read();
  expect(phone.width).toBeLessThan(700);
  expect(phone.fill).toBe(await raised());

  // At 1280 the fixture sets the flat and framed lists side by side, each narrower than 700px, so
  // the framed one keeps the raised fill on a desktop too: it follows its own width.
  await open(page, 1280);
  const beside = await read();
  expect(beside.width).toBeLessThan(700);
  expect(beside.fill).toBe(await raised());

  // Given the whole row, the same list is wider than 700px and takes the inset tint.
  await framed.evaluate((wrapper) => {
    (wrapper as HTMLElement).style.flexBasis = '100%';
  });
  const wide = await read();
  expect(wide.width).toBeGreaterThanOrEqual(700);
  expect(wide.fill).toBe(await inset());
});
