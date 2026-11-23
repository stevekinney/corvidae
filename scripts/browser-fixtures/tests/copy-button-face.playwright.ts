/// <reference lib="dom" />
/**
 * CopyButton's default face is the Copy icon alone, named by its label, which shows in a tooltip
 * on hover; the text face leads with the icon; and a copy changes neither face's width, so
 * nothing beside the button moves.
 */

import { freezePageTimers } from '@lostgradient/testing/playwright/page-timers';
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
    const buttons = page.locator('.example-preview-row-layout button.cinder-copy-button');
    await expect(buttons).toHaveCount(2);
    const [icon, text] = [buttons.nth(0), buttons.nth(1)];

    await expect(icon).toHaveAttribute('aria-label', 'Copy install command');
    await expect(icon.locator('svg.lucide-copy')).toHaveCount(1);
    await expect(icon).toHaveText('');
    const iconGeometry = await icon.evaluate((button) => {
      const glyph = button.querySelector<SVGElement>('.cinder-copy-button__icon');
      if (glyph === null) throw new Error('Missing CopyButton glyph.');
      const { fontSize } = getComputedStyle(button);
      const paint = glyph.getBoundingClientRect();
      return { fontSize: Number.parseFloat(fontSize), paint: [paint.width, paint.height] };
    });
    expect(iconGeometry.paint[0]).toBeCloseTo(iconGeometry.fontSize, 1);
    expect(iconGeometry.paint[1]).toBeCloseTo(iconGeometry.fontSize, 1);
    await expect(icon).toHaveCSS('border-top-width', '0px');
    await icon.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Copy install command');

    // The text face: the icon first, then the words.
    await expect(text.locator(':scope > svg.lucide-copy')).toHaveCount(1);
    await expect(text.locator('[data-cinder-current]')).toHaveText('Copy');

    // The copied state lasts 1.5s on a page timer; under load it can clear before the assertions
    // below read it, so the timers stop before the clicks (COR-2644).
    await freezePageTimers(page);
    for (const button of [icon, text]) {
      const before = await button.boundingBox();
      await button.click();
      await expect(button).toHaveAttribute('data-cinder-copied');
      await expect(button.locator('svg.lucide-check')).toHaveCount(1);
      const after = await button.boundingBox();
      expect(after?.width).toBeCloseTo(before?.width ?? 0, 1);
      expect(after?.height).toBeCloseTo(before?.height ?? 0, 1);
    }
    await expect(icon.locator('.cinder-copy-button__icon')).toHaveCSS(
      'width',
      `${iconGeometry.fontSize}px`,
    );
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

test('a DescriptionList identifier has a text-sized ghost copy icon', async ({ page }) => {
  await page.goto(`${fixtureRoute('description-list')}&wrapping=1`, { waitUntil: 'load' });
  const button = page.getByRole('button', { name: 'Copy Run ID' });
  const { fontSize, face, glyph } = await button.evaluate((node) => {
    const icon = node.querySelector('svg');
    if (icon === null) throw new Error('Missing CopyButton glyph.');
    return {
      fontSize: Number.parseFloat(getComputedStyle(node).fontSize),
      face: node.getBoundingClientRect().height,
      glyph: icon.getBoundingClientRect().height,
    };
  });
  expect(face).toBeCloseTo(fontSize, 1);
  expect(glyph).toBeCloseTo(fontSize, 1);
  await expect(button).toHaveCSS('border-top-width', '0px');
});

test('a stretched 32px text face gives its label enough real side room without moving the icon', async ({
  page,
}) => {
  await page.goto(fixtureRoute('copy-button'), { waitUntil: 'load' });
  const text = page.getByTestId('stretched-action-row').getByRole('button');
  const geometry = await text.evaluate((button) => {
    const label = button.querySelector<HTMLElement>(
      '.cinder-copy-button__word[data-cinder-current]',
    );
    const icon = button.querySelector<SVGElement>('svg');
    if (label === null || icon === null) throw new Error('Missing CopyButton text face.');
    const face = button.getBoundingClientRect();
    const words = label.getBoundingClientRect();
    const glyph = icon.getBoundingClientRect();
    return {
      faceHeight: face.height,
      sideRoom: Math.min(words.left - face.left, face.right - words.right),
      verticalRoom: Math.min(words.top - face.top, face.bottom - words.bottom),
      glyphCenter: (glyph.top + glyph.bottom) / 2,
      labelCenter: (words.top + words.bottom) / 2,
    };
  });
  expect(geometry.faceHeight).toBeCloseTo(32, 0);
  expect(geometry.sideRoom / geometry.verticalRoom).toBeGreaterThanOrEqual(1.5);
  expect(Math.abs(geometry.glyphCenter - geometry.labelCenter)).toBeLessThanOrEqual(0.5);
});

test('the ColorPicker format buttons keep their unpadded text faces', async ({ page }) => {
  await page.goto(fixtureRoute('color-picker'), { waitUntil: 'load' });
  const formats = page.getByRole('group', { name: 'Copy color formats' }).getByRole('button');
  await expect(formats).toHaveCount(3);
  const padding = await formats.evaluateAll((buttons) =>
    buttons.map((button) => {
      const { paddingInlineStart, paddingInlineEnd } = getComputedStyle(button);
      return [paddingInlineStart, paddingInlineEnd];
    }),
  );
  expect(padding).toEqual([
    ['0px', '0px'],
    ['0px', '0px'],
    ['0px', '0px'],
  ]);
});
