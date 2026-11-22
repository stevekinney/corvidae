/// <reference lib="dom" />
/**
 * CopyButton's default face is the Copy icon alone, named by its label, which shows in a tooltip
 * on hover; the text face leads with the icon; and a copy changes neither face's width, so
 * nothing beside the button moves.
 */

import { expect, test } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

test('the icon face shows its name in a tooltip and both faces keep their width', async ({
  browser,
}) => {
  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    viewport: { width: 1280, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto(fixtureRoute('copy-button'), { waitUntil: 'load' });
    const buttons = page.locator('button.cinder-copy-button');
    await expect(buttons).toHaveCount(2);
    const [icon, text] = [buttons.nth(0), buttons.nth(1)];

    await expect(icon).toHaveAttribute('aria-label', 'Copy install command');
    await expect(icon.locator('svg.lucide-copy')).toHaveCount(1);
    await expect(icon).toHaveText('');
    await icon.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Copy install command');

    // The text face: the icon first, then the words.
    await expect(text.locator(':scope > svg.lucide-copy')).toHaveCount(1);
    await expect(text.locator('[data-cinder-current]')).toHaveText('Copy');

    for (const button of [icon, text]) {
      const before = await button.boundingBox();
      await button.click();
      await expect(button).toHaveAttribute('data-cinder-copied');
      await expect(button.locator('svg.lucide-check')).toHaveCount(1);
      const after = await button.boundingBox();
      expect(after?.width).toBeCloseTo(before?.width ?? 0, 1);
      expect(after?.height).toBeCloseTo(before?.height ?? 0, 1);
    }
    await expect(text.locator('[data-cinder-current]')).toHaveText('Copied');
  } finally {
    await context.close();
  }
});

test('the inline copy face fits the text and keeps a visible keyboard ring', async ({ page }) => {
  await page.goto(`${fixtureRoute('copyable-value')}&hints=1`, { waitUntil: 'load' });
  const value = page.getByTestId('hinted-address');
  const button = value.getByRole('button');
  await expect(button).toHaveAttribute('data-cinder-appearance', 'inline');
  const lineHeight = await value.evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).lineHeight),
  );
  expect((await button.boundingBox())!.height).toBeLessThanOrEqual(lineHeight);
  await expect(button).toHaveCSS('border-top-width', '0px');
  await button.hover();
  await expect(button).toHaveCSS('border-top-width', '0px');
  await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(button).toBeFocused();
  await expect(button).not.toHaveCSS('box-shadow', 'none');
});

test('a DescriptionList identifier uses the same proportional copy padding', async ({ page }) => {
  await page.goto(`${fixtureRoute('description-list')}&wrapping=1`, { waitUntil: 'load' });
  const button = page.getByRole('button', { name: 'Copy Run ID' });
  const { fontSize, padding } = await button.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      fontSize: Number.parseFloat(style.fontSize),
      padding: Number.parseFloat(style.paddingTop),
    };
  });
  expect(Math.abs(padding - fontSize * 0.1)).toBeLessThanOrEqual(0.5);
});
