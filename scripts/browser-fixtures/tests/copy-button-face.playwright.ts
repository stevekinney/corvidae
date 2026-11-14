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
