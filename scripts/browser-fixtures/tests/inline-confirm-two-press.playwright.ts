/// <reference lib="dom" />
/**
 * COR-2683: a destructive two-press InlineConfirm is solid danger at rest, and arming draws a danger
 * ring with a page-coloured gap that a keyboard user sees too: it outranks the Button's own danger
 * focus ring. The ring clears 3:1 against the page in both themes. Measured on the
 * `inline-confirm` fixture with `?two-press=1`.
 */

import { THEME_STORAGE_KEY, themeContextOptions } from '@lostgradient/testing';
import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

/** WCAG contrast between two opaque CSS colours. */
function contrastOf([first, second]: [string, string]): number {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const luminance = (color: string): number => {
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    const channel = (value: number) => {
      const s = value / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
  };
  const [lighter, darker] = [luminance(first), luminance(second)].toSorted((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.use(themeContextOptions(theme));

    test('a keyboard-armed destructive action keeps its danger face and shows the danger ring', async ({
      page,
    }) => {
      await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
        THEME_STORAGE_KEY,
        theme,
      ] as const);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${fixtureRoute('inline-confirm')}&two-press=1`, { waitUntil: 'load' });
      const atRest = page.getByRole('button', { name: 'Delete namespace' });
      await expect(atRest).toHaveClass(/button-variant-danger/);

      // Arm it from the keyboard, so the button is armed and focus-visible at once.
      await atRest.focus();
      await page.keyboard.press('Enter');
      const armed = page.getByRole('button', { name: 'Press again to delete namespace' });
      await expect(armed).toBeFocused();
      await expect(armed).toHaveClass(/button-variant-danger/);

      const read = await armed.evaluate((button) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--cinder-status-danger-solid)';
        document.body.append(probe);
        const danger = getComputedStyle(probe).color;
        probe.remove();
        let page = 'rgb(255, 255, 255)';
        for (let node = button.parentElement; node !== null; node = node.parentElement) {
          const color = getComputedStyle(node).backgroundColor;
          if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') {
            page = color;
            break;
          }
        }
        return { shadow: getComputedStyle(button).boxShadow, danger, page };
      });
      // Two stops: the 2px page-coloured gap, then the danger ring outside it.
      expect(read.shadow).toContain(read.danger);
      expect(read.shadow).toMatch(/0px 0px 0px 2px/);
      expect(
        await page.evaluate(contrastOf, [read.danger, read.page] as [string, string]),
      ).toBeGreaterThanOrEqual(3);
    });
  });
}
