/**
 * COR-2313: composed text-entry controls share Input's filled treatment in comfortable density:
 * a 48px medium frame, 12px radius, and a visible focus ring.
 */
import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test, type Locator, type Page } from '@playwright/test';

type Fixture = {
  slug: 'autocomplete' | 'combobox' | 'multi-select' | 'number-input';
  control: (page: Page) => Locator;
};

const fixtures: readonly Fixture[] = [
  { slug: 'autocomplete', control: (page) => page.locator('#field') },
  { slug: 'combobox', control: (page) => page.locator('#fruit') },
  { slug: 'multi-select', control: (page) => page.locator('#fruit') },
  { slug: 'number-input', control: (page) => page.locator('#number-input') },
];

test.describe('Filled composed controls', () => {
  for (const fixture of fixtures) {
    test(`${fixture.slug} has a 48px filled frame, 12px radius, and focus ring`, async ({
      page,
    }) => {
      await page.goto(fixtureRoute(fixture.slug), { waitUntil: 'load' });
      const control = fixture.control(page);
      await expect(control).toHaveAttribute('data-cinder-appearance', 'filled');
      const frame =
        fixture.slug === 'number-input'
          ? page.locator('.cinder-input-group--filled').filter({ has: control })
          : control;
      await expect.poll(async () => (await frame.boundingBox())?.height).toBe(48);
      await expect(frame).toHaveCSS('border-top-left-radius', '12px');

      await expect(frame).toHaveCSS('box-shadow', 'none');
      await control.focus();
      await expect(control).toBeFocused();
      await expect(frame).toHaveCSS('box-shadow', /0px 0px 0px 2px/);
    });
  }
});
