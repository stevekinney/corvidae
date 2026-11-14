/// <reference lib="dom" />
/**
 * A Carousel's Previous and Next are chevron buttons in gutters at the inline start and end of
 * the slides, centred on them and never over them, mirrored in right to left; its page buttons are
 * small dots centred under the slides, the current one a wider accent pill, each with a 24px hit
 * area (44px on a coarse pointer) that is a pseudo-element, not its painted size.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

const ROUTE = fixtureRoute('carousel');

type Geometry = {
  viewport: DOMRect;
  previous: DOMRect;
  next: DOMRect;
  dots: Array<{ box: DOMRect; hit: { width: number; height: number }; current: boolean }>;
  dotsBox: DOMRect;
  previousName: string | null;
  previousIconOnly: boolean;
};

async function geometry(root: Locator): Promise<Geometry> {
  return root.evaluate((section) => {
    const box = (selector: string) => {
      const element = section.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      return element.getBoundingClientRect().toJSON() as DOMRect;
    };
    const previous = section.querySelector('.cinder-carousel__control--previous');
    return {
      viewport: box('.cinder-carousel__viewport'),
      previous: box('.cinder-carousel__control--previous'),
      next: box('.cinder-carousel__control--next'),
      dotsBox: box('.cinder-carousel__dots'),
      dots: [...section.querySelectorAll('.cinder-carousel__dot')].map((dot) => {
        const hit = getComputedStyle(dot, '::after');
        return {
          box: dot.getBoundingClientRect().toJSON() as DOMRect,
          hit: { width: Number.parseFloat(hit.width), height: Number.parseFloat(hit.height) },
          current: dot.getAttribute('aria-current') === 'true',
        };
      }),
      previousName: previous?.getAttribute('aria-label') ?? null,
      previousIconOnly: (previous?.textContent ?? '').trim() === '',
    };
  });
}

function expectGutters(result: Geometry, rightToLeft: boolean): void {
  const [start, end] = rightToLeft
    ? [result.next, result.previous]
    : [result.previous, result.next];
  // Beside the slides, never over them.
  expect(start.right).toBeLessThanOrEqual(result.viewport.left + 0.5);
  expect(end.left).toBeGreaterThanOrEqual(result.viewport.right - 0.5);
  // Centred on the slides.
  const middle = result.viewport.top + result.viewport.height / 2;
  for (const control of [result.previous, result.next]) {
    expect(Math.abs(control.top + control.height / 2 - middle)).toBeLessThanOrEqual(1);
  }
}

function expectDots(result: Geometry, coarse = false): void {
  const target = coarse ? 44 : 24;
  for (const dot of result.dots) {
    expect(dot.box.height).toBeCloseTo(8, 0);
    expect(dot.box.width).toBeCloseTo(dot.current ? 20 : 8, 0);
    expect(dot.hit.height).toBeGreaterThanOrEqual(target);
    expect(dot.hit.width).toBeGreaterThanOrEqual(target);
  }
  expect(result.dots.filter((dot) => dot.current)).toHaveLength(1);
  // Centred under the slides.
  const slidesCentre = result.viewport.left + result.viewport.width / 2;
  expect(
    Math.abs(result.dotsBox.left + result.dotsBox.width / 2 - slidesCentre),
  ).toBeLessThanOrEqual(1);
  // Neighbouring hit areas never overlap: centres at least a target apart.
  const centres = result.dots
    .map((dot) => dot.box.left + dot.box.width / 2)
    .toSorted((a, b) => a - b);
  for (let index = 1; index < centres.length; index += 1) {
    expect(centres[index]! - centres[index - 1]!).toBeGreaterThanOrEqual(target - 0.5);
  }
}

async function open(page: Page): Promise<void> {
  await page.goto(ROUTE, { waitUntil: 'load' });
  await page.locator('#example-mount-basic .cinder-carousel__dot').first().waitFor();
}

for (const width of [1280, 390]) {
  test(`carousel chevrons sit in gutters beside the slides and the dots are small (${width})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const result = await geometry(page.locator('#example-mount-basic .cinder-carousel'));
    expect(result.previousName).toBe('Previous');
    expect(result.previousIconOnly).toBe(true);
    expectGutters(result, false);
    expectDots(result);
    expectGutters(await geometry(page.locator('#example-mount-rtl .cinder-carousel')), true);
  });
}

test('on a coarse pointer each dot keeps a 44px hit area, a pseudo-element', async ({
  browser,
}) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await context.newPage();
    await open(page);
    expectDots(await geometry(page.locator('#example-mount-basic .cinder-carousel')), true);
  } finally {
    await context.close();
  }
});
