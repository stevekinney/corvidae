import { expect, test, type Page } from '@playwright/test';
import { themeFixtureRoute } from './theme-fixture-route.ts';
async function paintedOklch(
  page: Page,
  selector: string,
  property: string,
): Promise<{ L: number; C: number }> {
  const element = page.locator(selector).first();
  await expect(element).toBeVisible();
  return element.evaluate((node, styleProperty) => {
    const styles = getComputedStyle(node);
    const value =
      styles.getPropertyValue(styleProperty) ||
      (styleProperty === 'backgroundColor' ? styles.background : styles.border);
    const match = value.match(/(?:oklch|rgba?)\(([^)]+)/i);
    if (!match) throw new Error(`Unparseable color: ${value}`);
    const first = Number.parseFloat(match[1]!.split(/[ ,/]+/)[0] ?? '0');
    const isRgb = value.startsWith('rgb');
    return {
      L: isRgb ? first / 255 : first,
      C: isRgb ? 0 : Number.parseFloat(match[1]!.split(/[ ,/]+/)[1] ?? '0'),
    };
  }, property);
}

async function paintedL(page: Page, selector: string, property: string): Promise<number> {
  const result = await paintedOklch(page, selector, property);
  return result.L;
}
test.describe('theme-parity — light surface ladder + button vividness floor', () => {
  test('light surface ladder separates background, raised, surface, and inset', async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme: 'light', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.goto(themeFixtureRoute, { waitUntil: 'load' });
      const prefersLight = await page.evaluate(
        () => window.matchMedia('(prefers-color-scheme: light)').matches,
      );
      expect(
        prefersLight,
        'browser must be emulating light so light-dark() picks the light arm',
      ).toBe(true);
      const bgL = await page.evaluate(() => {
        const match = getComputedStyle(document.body).backgroundColor.match(/oklch\(([^)]+)\)/i);
        if (!match) throw new Error('Unparseable page background');
        const raw = match[1]?.split(/[ ,/]+/)[0];
        return raw?.endsWith('%') ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw ?? '0');
      });
      const raisedL = await paintedL(
        page,
        ".cinder-button[data-cinder-variant='secondary']",
        'backgroundColor',
      );
      expect(
        raisedL - bgL,
        'surface-raised must sit above the page background in light mode',
      ).toBeGreaterThan(0);
      expect(bgL, 'the light-mode page background must read as white').toBeGreaterThanOrEqual(0.97);
      await page.goto(themeFixtureRoute, { waitUntil: 'load' });
      const surfaceL = await paintedL(page, '.cinder-table', 'backgroundColor');
      const insetL = await paintedL(page, '.cinder-table__header', 'backgroundColor');
      expect(
        surfaceL - insetL,
        'surface must sit above surface-inset so sunken regions read',
      ).toBeGreaterThanOrEqual(0.025);
    } finally {
      await context.close();
    }
  });
  test('secondary button border separates from its fill in light mode', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'light', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.goto(themeFixtureRoute, { waitUntil: 'load' });
      const secondarySelector = ".cinder-button[data-cinder-variant='secondary']";
      const fillL = await paintedL(page, secondarySelector, 'backgroundColor');
      const borderL = await paintedL(page, secondarySelector, 'borderTopColor');
      expect(
        Math.abs(fillL - borderL),
        'secondary button border must read against its fill (not a barely-there hairline)',
      ).toBeGreaterThanOrEqual(0.15);
    } finally {
      await context.close();
    }
  });
  test('primary accent is a dark, ink-like indigo that still clears WCAG AA on its white label', async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme: 'light', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.goto(themeFixtureRoute, { waitUntil: 'load' });
      const primarySelector = ".cinder-button[data-cinder-variant='primary']";
      const accent = await paintedOklch(page, primarySelector, 'backgroundColor');
      expect(
        accent.L,
        'primary accent must be a dark, ink-like indigo fill (not muddy-black) in light mode',
      ).toBeGreaterThanOrEqual(0.44);
      expect(
        accent.L,
        'primary accent must stay dark enough that its white label clears AA (L too high breaks white-text contrast)',
      ).toBeLessThanOrEqual(0.57);
      expect(accent.C, 'primary accent must be moderately saturated').toBeGreaterThanOrEqual(0.14);
      const ratio = await page
        .locator(primarySelector)
        .first()
        .evaluate((node) => {
          const luminance = (value: string): number => {
            if (!node.ownerDocument) throw new Error('Missing owner document');
            const canvas = document.createElement('canvas');
            const canvasContext = canvas.getContext('2d');
            if (!canvasContext) throw new Error('Canvas unavailable');
            canvasContext.fillStyle = value;
            canvasContext.fillRect(0, 0, 1, 1);
            const pixels = canvasContext.getImageData(0, 0, 1, 1).data;
            const channels = [pixels[0] ?? 0, pixels[1] ?? 0, pixels[2] ?? 0].map(
              (channel) => channel / 255,
            );
            const linear = channels.map((channel) =>
              channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4),
            );
            return (
              0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0)
            );
          };
          const style = getComputedStyle(node);
          const first = luminance(style.backgroundColor);
          const second = luminance(style.color);
          return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
        });
      expect(ratio, 'the label on the accent fill must clear WCAG AA').toBeGreaterThanOrEqual(4.5);
    } finally {
      await context.close();
    }
  });
  test('table header reads as a distinct band from the body in light mode', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'light', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.goto(themeFixtureRoute, { waitUntil: 'load' });
      const bodyL = await paintedL(page, '.cinder-table', 'backgroundColor');
      const headerL = await paintedL(page, '.cinder-table__header', 'backgroundColor');
      expect(
        Math.abs(bodyL - headerL),
        'table header (surface-inset) must separate from the body (surface)',
      ).toBeGreaterThanOrEqual(0.025);
    } finally {
      await context.close();
    }
  });
  test('primary button is a real filled accent in both light and dark', async ({ browser }) => {
    const lightContext = await browser.newContext({
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    const darkContext = await browser.newContext({ colorScheme: 'dark', reducedMotion: 'reduce' });
    try {
      const lightPage = await lightContext.newPage();
      const darkPage = await darkContext.newPage();
      await darkPage.addInitScript(() => localStorage.setItem('browser-fixture-theme', 'dark'));
      await Promise.all([
        lightPage.goto(themeFixtureRoute, { waitUntil: 'load' }),
        darkPage.goto(themeFixtureRoute, { waitUntil: 'load' }),
      ]);
      const primarySelector = ".cinder-button[data-cinder-variant='primary']";
      for (const page of [lightPage, darkPage]) {
        const raw = await page
          .locator(primarySelector)
          .first()
          .evaluate((node) => getComputedStyle(node as Element).backgroundColor);
        expect(raw, 'primary fill must not be transparent').not.toBe('rgba(0, 0, 0, 0)');
        expect(raw, 'primary fill must not be transparent').not.toBe('transparent');
      }
      const lightAccent = await paintedOklch(lightPage, primarySelector, 'backgroundColor');
      const darkAccent = await paintedOklch(darkPage, primarySelector, 'backgroundColor');
      expect(lightAccent.C, 'light primary must be a saturated accent').toBeGreaterThanOrEqual(
        0.06,
      );
      expect(darkAccent.C, 'dark primary must be a saturated accent').toBeGreaterThanOrEqual(0.06);
      const accentsDiffer =
        Math.abs(lightAccent.L - darkAccent.L) > 0.02 ||
        Math.abs(lightAccent.C - darkAccent.C) > 0.02;
      expect(accentsDiffer, 'light and dark accents must resolve to distinct values').toBe(true);
    } finally {
      await lightContext.close();
      await darkContext.close();
    }
  });
  test('pressed primary button keeps its label above WCAG AA in both themes', async ({
    browser,
  }) => {
    for (const colorScheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ colorScheme, reducedMotion: 'reduce' });
      try {
        const page = await context.newPage();
        if (colorScheme === 'dark')
          await page.addInitScript(() => localStorage.setItem('browser-fixture-theme', 'dark'));
        await page.goto(themeFixtureRoute, { waitUntil: 'load' });
        const primarySelector = ".cinder-button[data-cinder-variant='primary']";
        const ratio = await page
          .locator(primarySelector)
          .first()
          .evaluate((node) => {
            const FALLBACK = 'rgb(255, 0, 255)';
            const read = (customProperty: string) => {
              const probe = document.createElement('span');
              probe.style.color = `var(${customProperty}, rgb(255 0 255))`;
              node.appendChild(probe);
              const resolved = getComputedStyle(probe).color;
              probe.remove();
              return resolved;
            };
            const pressedFill = read('--cinder-accent-solid-active-on-fill');
            const label = read('--cinder-accent-contrast');
            if (pressedFill === FALLBACK || label === FALLBACK) {
              throw new Error(
                `a token failed to resolve (pressedFill=${pressedFill}, label=${label}) — ` +
                  'hit the magenta fallback (stale CSS bundle?). Rebuild cinder and retry.',
              );
            }
            if (pressedFill === label) {
              throw new Error(
                `pressed fill and label resolved to the same color (${pressedFill}) — ` +
                  'a token failed to resolve. Rebuild cinder and retry.',
              );
            }
            const luminance = (value: string): number => {
              if (!node.ownerDocument) throw new Error('Missing owner document');
              const canvas = document.createElement('canvas');
              const canvasContext = canvas.getContext('2d');
              if (!canvasContext) throw new Error('Canvas unavailable');
              canvasContext.fillStyle = value;
              canvasContext.fillRect(0, 0, 1, 1);
              const pixels = canvasContext.getImageData(0, 0, 1, 1).data;
              const channels = [pixels[0] ?? 0, pixels[1] ?? 0, pixels[2] ?? 0].map(
                (channel) => channel / 255,
              );
              const linear = channels.map((channel) =>
                channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4),
              );
              return (
                0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0)
              );
            };
            const first = luminance(pressedFill);
            const second = luminance(label);
            return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
          });
        expect(
          ratio,
          `pressed primary button label must clear WCAG AA in ${colorScheme} mode`,
        ).toBeGreaterThanOrEqual(4.5);
      } finally {
        await context.close();
      }
    }
  });
});
