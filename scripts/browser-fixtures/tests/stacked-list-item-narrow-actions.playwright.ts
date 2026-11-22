/// <reference lib="dom" />
/**
 * COR-2528: under a 448px row width a two-line StackedListItem gives its action buttons a line of
 * their own under the text, so the title and the meta keep the row's width, and a title followed by
 * several badges drops them to a line under it instead of being crushed. Measured on the
 * `narrow-actions` fixture, whose two rows are 20rem wide; every box is read in one pass.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

test('a narrow two-line row puts its action under the text, and several badges drop under the title', async ({
  page,
}) => {
  await page.goto(fixtureRoute('stacked-list-item', { fixtureName: 'narrow-actions' }), {
    waitUntil: 'load',
  });
  await page.getByTestId('actions-no-leading').evaluate((element) => {
    element.removeAttribute('hidden');
  });
  await page.locator('[data-testid="actions"] .cinder-button').waitFor({ state: 'visible' });
  const read = await page.evaluate(() => {
    const box = (root: Element | null, selector: string) => {
      const element = root?.querySelector(selector);
      if (!element) return null;
      const { top, bottom, left, right, width } = element.getBoundingClientRect();
      return { top, bottom, left, right, width };
    };
    const actions = [
      document.querySelector('[data-testid="actions"]'),
      document.querySelector('[data-testid="actions-no-leading"]'),
    ];
    const badges = document.querySelector('[data-testid="badges"]');
    const lines = [...(badges?.querySelectorAll('[data-badge]') ?? [])].map((badge) => {
      const { top, bottom, right } = badge.getBoundingClientRect();
      return { top, bottom, right };
    });
    return {
      actions: actions.map((action) => ({
        row: box(action, '.cinder-stacked-list-item'),
        title: box(action, '.cinder-stacked-list-item__title'),
        meta: box(action, '.cinder-stacked-list-item__meta'),
        button: box(action, '.cinder-stacked-list-item__trailing'),
      })),
      badgeRow: box(badges, '.cinder-stacked-list-item'),
      badgeTitle: box(badges, '.cinder-stacked-list-item__title'),
      lines,
    };
  });

  // The button: under the meta, at the text's start, not a column beside it. Check both the
  // leading tile's status-start title area and an unadorned row's actual title track.
  for (const action of read.actions) {
    expect(action.button!.top).toBeGreaterThanOrEqual(action.meta!.bottom - 1);
    expect(Math.abs(action.button!.left - action.title!.left)).toBeLessThanOrEqual(1);
    // The title keeps most of the row: with the button beside it, it would have had half.
    expect(action.title!.width).toBeGreaterThan(action.row!.right - action.row!.left - 120);
  }

  // Three badges: none past the row, and they sit under the title, side by side on one line.
  const [first, second, third] = read.lines;
  for (const badge of read.lines) expect(badge.right).toBeLessThanOrEqual(read.badgeRow!.right + 1);
  expect(first!.top).toBeGreaterThanOrEqual(read.badgeTitle!.bottom - 1);
  expect(Math.abs(first!.top - second!.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(first!.top - third!.top)).toBeLessThanOrEqual(1);
  // The title is not crushed: it is drawn at its own width.
  expect(read.badgeTitle!.width).toBeGreaterThan(80);
});
