/// <reference lib="dom" />
/**
 * COR-2310: density is one axis (compact, default, comfortable), and every step reaches the
 * components through the same tokens.
 *
 * The density goes on the root element, the way a page declares it once, and each test reads
 * computed values: a Button's height and corner, a Card's corner and body padding, a PageHeader's
 * title size, the type and gap tokens through a probe, and (COR-2308's owner decision) the light
 * canvas, which comfortable switches to the consumer ladder while dark stays the same in every
 * density. `comfortable-density.test.ts` pins the CSS shape these values come from.
 */

import { expect, test, type Page } from '@playwright/test';

import { fixtureRoute } from './layout-fixture.ts';
import { themeFixtureRoute } from './theme-fixture-route.ts';

type Density = 'default' | 'compact' | 'comfortable';

const DENSITIES: readonly Density[] = ['default', 'compact', 'comfortable'];

/** Declares the density on the root element; the default density is no attribute at all. */
async function applyDensity(page: Page, density: Density): Promise<void> {
  await page.evaluate((value) => {
    if (value === 'default') delete document.documentElement.dataset['density'];
    else document.documentElement.dataset['density'] = value;
  }, density);
}

/** The computed values of `properties` on the first element matching `selector`. */
async function computedStyle(
  page: Page,
  selector: string,
  properties: readonly string[],
): Promise<Record<string, string>> {
  const element = page.locator(selector).first();
  await expect(element).toBeVisible();
  return element.evaluate(
    (node, names) => {
      const style = getComputedStyle(node as Element);
      return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)]));
    },
    [...properties],
  );
}

/**
 * Resolves each `property: value` pair on a fresh probe appended to the body, so a token reaches
 * the probe through the same inheritance a component's element sees.
 */
async function probe(
  page: Page,
  declarations: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  return page.evaluate((entries) => {
    const result: Record<string, string> = {};
    for (const [property, value] of Object.entries(entries)) {
      const element = document.createElement('div');
      element.style.setProperty(property, value);
      document.body.append(element);
      result[property] = getComputedStyle(element).getPropertyValue(property);
      element.remove();
    }
    return result;
  }, declarations);
}

const BUTTON_EXPECTED: Record<Density, Record<string, string>> = {
  // COR-2312: a Button is a pill at every density.
  default: { 'min-height': '32px', 'border-top-left-radius': '9999px' },
  compact: { 'min-height': '32px', 'border-top-left-radius': '9999px' },
  comfortable: { 'min-height': '40px', 'border-top-left-radius': '9999px' },
};

const CARD_EXPECTED: Record<Density, { radius: string; padding: string }> = {
  default: { radius: '12px', padding: '16px' },
  compact: { radius: '12px', padding: '12px' },
  comfortable: { radius: '16px', padding: '20px' },
};

const PAGE_TITLE_EXPECTED: Record<Density, string> = {
  default: '24px',
  compact: '24px',
  comfortable: '28px',
};

const TYPE_AND_GAP_EXPECTED: Record<Density, Record<string, string>> = {
  default: { body: '14px', secondary: '13px', section: '16px', gap: '12px' },
  compact: { body: '14px', secondary: '13px', section: '16px', gap: '12px' },
  comfortable: { body: '15px', secondary: '14px', section: '18px', gap: '16px' },
};

test.describe('COR-2310: density reaches Button, Card and PageHeader', () => {
  for (const density of DENSITIES) {
    test(`${density}: a medium Button is ${BUTTON_EXPECTED[density]['min-height']} tall`, async ({
      page,
    }) => {
      await page.goto(themeFixtureRoute, { waitUntil: 'load' });
      await applyDensity(page, density);
      const style = await computedStyle(page, ".cinder-button[data-cinder-variant='primary']", [
        'min-height',
        'border-top-left-radius',
      ]);
      expect(style).toEqual(BUTTON_EXPECTED[density]);
    });

    test(`${density}: a Card rounds to ${CARD_EXPECTED[density].radius} and pads ${CARD_EXPECTED[density].padding}`, async ({
      page,
    }) => {
      await page.goto(themeFixtureRoute, { waitUntil: 'load' });
      await applyDensity(page, density);
      const card = await computedStyle(page, '.cinder-card', ['border-top-left-radius']);
      const body = await computedStyle(page, '.cinder-card__body', ['padding-top', 'padding-left']);
      expect(card['border-top-left-radius']).toBe(CARD_EXPECTED[density].radius);
      expect(body['padding-top']).toBe(CARD_EXPECTED[density].padding);
      expect(body['padding-left']).toBe(CARD_EXPECTED[density].padding);
    });

    test(`${density}: a PageHeader title is ${PAGE_TITLE_EXPECTED[density]}`, async ({ page }) => {
      await page.goto(fixtureRoute('page-header'), { waitUntil: 'load' });
      await applyDensity(page, density);
      const title = await computedStyle(page, '.cinder-page-header__title', ['font-size']);
      expect(title['font-size']).toBe(PAGE_TITLE_EXPECTED[density]);
    });

    test(`${density}: body, secondary and section type and the stack gap`, async ({ page }) => {
      await page.goto(themeFixtureRoute, { waitUntil: 'load' });
      await applyDensity(page, density);
      const resolved = await probe(page, {
        'font-size': 'var(--cinder-text-body)',
        'line-height': 'var(--cinder-text-secondary)',
        'max-width': 'var(--cinder-text-section-title)',
        'row-gap': 'var(--cinder-gap-stack)',
      });
      expect({
        body: resolved['font-size'],
        secondary: resolved['line-height'],
        section: resolved['max-width'],
        gap: resolved['row-gap'],
      }).toEqual(TYPE_AND_GAP_EXPECTED[density]);
    });
  }
});

test.describe('COR-2310: comfortable switches the light canvas only', () => {
  /** The canvas under `density` in `theme`, beside a literal reference painted the same way. */
  async function canvasUnder(
    page: Page,
    theme: 'light' | 'dark',
    density: Density,
    reference: string,
  ): Promise<{ canvas: string; reference: string }> {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(themeFixtureRoute, { waitUntil: 'load' });
    await page.evaluate((value) => {
      document.documentElement.dataset['theme'] = value;
    }, theme);
    await applyDensity(page, density);
    const canvas = await probe(page, { 'background-color': 'var(--cinder-surface-canvas)' });
    const literal = await probe(page, { 'background-color': reference });
    return { canvas: canvas['background-color']!, reference: literal['background-color']! };
  }

  const LIGHT_CANVAS: Record<Density, string> = {
    default: 'oklch(99.4% 0.002 265)',
    compact: 'oklch(99.4% 0.002 265)',
    comfortable: 'oklch(95.5% 0.004 265)',
  };

  for (const density of DENSITIES) {
    test(`light ${density}: the canvas is ${LIGHT_CANVAS[density]}`, async ({ page }) => {
      const { canvas, reference } = await canvasUnder(
        page,
        'light',
        density,
        LIGHT_CANVAS[density],
      );
      expect(canvas).toBe(reference);
    });

    test(`dark ${density}: the canvas is the shipped oklch(14.5% 0.012 265)`, async ({ page }) => {
      const { canvas, reference } = await canvasUnder(
        page,
        'dark',
        density,
        'oklch(14.5% 0.012 265)',
      );
      expect(canvas).toBe(reference);
    });
  }
});
