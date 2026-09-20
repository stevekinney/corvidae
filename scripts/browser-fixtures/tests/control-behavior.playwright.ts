import { loadManifest } from '@corvidae/testing';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { environmentConfiguration } from '../environment-configuration.ts';
import { FIXTURE_ORIGIN } from '../scripts/fixture-port.ts';

type Theme = 'light' | 'dark';
type Styles = Record<
  | 'backgroundColor'
  | 'borderTopColor'
  | 'borderTopStyle'
  | 'borderTopWidth'
  | 'boxShadow'
  | 'color'
  | 'cursor'
  | 'outlineStyle',
  string
>;
const manifest = loadManifest();
const route = (slug: string) => {
  const entry = manifest.find((candidate) => candidate.slug === slug);
  const hash = entry?.fixtures?.find((fixture) => fixture.name === 'assertion')?.fixtureContentHash;
  if (!hash) throw new Error(`Assertion fixture hash missing for ${slug}.`);
  return `/page/${slug}?snapshot=1&fixture=assertion&fixtureContentHash=${hash}`;
};
const visible = (color: string) => {
  if (color === 'transparent') return false;
  const slashAlpha = /\/\s*(?<alpha>[.\d]+)%?\s*\)?$/.exec(color)?.groups?.['alpha'];
  const commaAlpha = /rgba?\([^,]+,[^,]+,[^,]+,\s*(?<alpha>[.\d]+)\)/.exec(color)?.groups?.[
    'alpha'
  ];
  return slashAlpha === undefined && commaAlpha === undefined
    ? true
    : Number.parseFloat(slashAlpha ?? commaAlpha ?? '0') > 0;
};
const transparent = (color: string) => !visible(color);
async function styles(locator: Locator): Promise<Styles> {
  return locator.evaluate((element) => {
    const s = getComputedStyle(element);
    return {
      backgroundColor: s.backgroundColor,
      borderTopColor: s.borderTopColor,
      borderTopStyle: s.borderTopStyle,
      borderTopWidth: s.borderTopWidth,
      boxShadow: s.boxShadow,
      color: s.color,
      cursor: s.cursor,
      outlineStyle: s.outlineStyle,
    };
  });
}
async function ancestor(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    let current = element.parentElement;
    while (current) {
      const color = getComputedStyle(current).backgroundColor;
      if (color !== 'transparent' && !/rgba?\([^)]*,\s*0\)/.test(color)) return color;
      current = current.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  });
}
async function chrome(locator: Locator, contrast = true): Promise<Styles> {
  const value = await styles(locator);
  const background = await ancestor(locator);
  expect(value.borderTopWidth).toBe('1px');
  expect(value.borderTopStyle).toBe('solid');
  expect(visible(value.borderTopColor)).toBe(true);
  expect(visible(value.backgroundColor)).toBe(true);
  expect(value.borderTopColor).not.toBe(background);
  if (contrast) expect(value.backgroundColor).not.toBe(background);
  return value;
}
async function open(
  browser: Browser,
  theme: Theme,
  forcedColors?: 'active',
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: 'reduce',
    ...(forcedColors ? { forcedColors } : {}),
    viewport: { width: 1280, height: 900 },
    baseURL: environmentConfiguration().browserFixtureUrl ?? FIXTURE_ORIGIN,
  });
  try {
    await context.addInitScript(
      (value) => localStorage.setItem('browser-fixture-theme', value),
      theme,
    );
    const page = await context.newPage();
    await page.goto(route('button'), { waitUntil: 'load' });
    await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

test.describe('Button ghost icon-only affordance', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`rest, hover, focus, and disabled states stay visible in ${theme} mode`, async ({
      browser,
    }) => {
      const { context, page } = await open(browser, theme);
      try {
        const ghost = page.getByTestId('button-ghost-icon-only-rest');
        const danger = page.getByTestId('button-ghost-danger-icon-only-rest');
        const text = await styles(page.getByTestId('button-ghost-text-share'));
        expect(transparent(text.backgroundColor)).toBe(true);
        expect(transparent(text.borderTopColor)).toBe(true);
        const ghostRest = await chrome(ghost);
        const dangerRest = await chrome(danger);
        await ghost.hover();
        const ghostHover = await styles(ghost);
        expect(ghostHover.backgroundColor).not.toBe(ghostRest.backgroundColor);
        await danger.hover();
        const dangerHover = await styles(danger);
        expect(dangerHover.backgroundColor).not.toBe(dangerRest.backgroundColor);
        await ghost.focus();
        const ghostFocus = await styles(ghost);
        expect(ghostFocus.boxShadow).not.toBe('none');
        await danger.focus();
        const dangerFocus = await styles(danger);
        expect(dangerFocus.boxShadow).not.toBe('none');
        for (const id of [
          'button-ghost-icon-only-disabled',
          'button-ghost-danger-icon-only-disabled',
          'button-ghost-icon-only-aria-disabled-link',
          'button-ghost-danger-icon-only-aria-disabled-link',
        ]) {
          const disabled = await chrome(page.getByTestId(id));
          expect(disabled.cursor).toBe('not-allowed');
        }
      } finally {
        await context.close();
      }
    });
  }
  test('forced-colors mode keeps icon-only ghost buttons bordered and focusable', async ({
    browser,
  }) => {
    const { context, page } = await open(browser, 'light', 'active');
    try {
      for (const id of ['button-ghost-icon-only-rest', 'button-ghost-danger-icon-only-rest']) {
        const button = page.getByTestId(id);
        await chrome(button, false);
        await button.focus();
        const focused = await styles(button);
        expect(focused.outlineStyle).toBe('solid');
      }
    } finally {
      await context.close();
    }
  });
});

test.describe('dropdown trigger caret', () => {
  test('renders as an RTL-safe SVG chevron aligned with the trigger label', async ({ page }) => {
    await page.goto(route('dropdown'));
    const scope = page.locator('#example-mount-basic');
    await expect(scope).toBeVisible();
    const trigger = scope.getByRole('button', { name: 'Options' });
    await expect(trigger).toBeVisible();
    await page.evaluate(() => (document.documentElement.dir = 'rtl'));
    const caret = trigger.locator('.cinder-dropdown-trigger__caret');
    await expect(caret).toHaveCount(1);
    const details = await caret.evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        isSvg: element instanceof SVGSVGElement,
        ariaHidden: element.getAttribute('aria-hidden'),
        focusable: element.getAttribute('focusable'),
        stroke: element.getAttribute('stroke'),
        strokeWidth: element.getAttribute('stroke-width'),
        viewBox: element.getAttribute('viewBox'),
        pathData: Array.from(element.querySelectorAll('path')).map((path) =>
          path.getAttribute('d'),
        ),
        width: box.width,
        height: box.height,
        borderTopWidth: style.borderTopWidth,
        borderRightWidth: style.borderRightWidth,
        borderBottomWidth: style.borderBottomWidth,
        borderLeftWidth: style.borderLeftWidth,
        rotate: style.rotate,
        transform: style.transform,
        translate: style.translate,
      };
    });
    expect(details.isSvg).toBe(true);
    expect(details.ariaHidden).toBe('true');
    expect(details.focusable).toBe('false');
    expect(details.stroke).toBe('currentColor');
    expect(details.strokeWidth).toBe('2');
    expect(details.viewBox).toBe('0 0 20 20');
    expect(details.pathData).toEqual(['M6 8l4 4 4-4']);
    expect(details.width).toBeGreaterThan(0);
    expect(details.height).toBeGreaterThan(0);
    for (const width of [
      details.borderTopWidth,
      details.borderRightWidth,
      details.borderBottomWidth,
      details.borderLeftWidth,
    ])
      expect(width).toBe('0px');
    expect(['none', '0deg']).toContain(details.rotate);
    expect(details.transform).toBe('none');
    expect(['none', '0px']).toContain(details.translate);
    const centerDifference = await trigger.evaluate((element) => {
      const svg = element.querySelector<SVGSVGElement>('.cinder-dropdown-trigger__caret');
      if (!svg) throw new Error('Dropdown trigger caret is missing.');
      const a = element.getBoundingClientRect();
      const b = svg.getBoundingClientRect();
      return Math.abs(a.top + a.height / 2 - (b.top + b.height / 2));
    });
    expect(centerDifference).toBeLessThanOrEqual(2);
  });
});
