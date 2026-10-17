/// <reference lib="dom" />
/**
 * The checkmark is drawn by a sibling indicator element, never by a
 * pseudo-element on the `<input>`: a replaced element does not reliably
 * render `::before`/`::after` (Firefox, and DOM-to-image capture both drop
 * it). The indicator paints `--cinder-accent-contrast`, so it follows the
 * theme of the subtree it sits in. A `[data-theme='light']` island on an
 * OS-dark page must get the light glyph, not the page's dark one.
 */

import { loadManifest } from '@lostgradient/testing';
import { expect, test } from '@playwright/test';

const manifest = loadManifest();
function fixtureRoute(slug: string): string {
  const entry = manifest.find((candidate) => candidate.slug === slug);
  const hash = entry?.fixtures?.find((fixture) => fixture.name === 'assertion')?.fixtureContentHash;
  if (hash === undefined) throw new Error(`Assertion fixture hash missing for ${slug}.`);
  return `/page/${slug}?snapshot=1&fixture=assertion&fixtureContentHash=${hash}`;
}

test('a light island on a dark page gets the light checkmark', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  // The fixture shell applies its stored theme; make the page itself dark too.
  await page
    .context()
    .addInitScript(([key, value]) => localStorage.setItem(key, value), [
      'browser-fixture-theme',
      'dark',
    ] as const);
  await page.goto(fixtureRoute('checkbox'), { waitUntil: 'load' });
  await page.waitForSelector('.cinder-checkbox', { state: 'attached', timeout: 20_000 });

  const glyphs = await page.evaluate(() => {
    const source = document.querySelector('.cinder-checkbox')!.closest('.cinder-checkbox-field')!;
    const probe = (theme: string | undefined) => {
      const host = document.createElement('div');
      if (theme) host.dataset['theme'] = theme;
      const field = source.cloneNode(true) as HTMLElement;
      const input = field.querySelector<HTMLInputElement>('input.cinder-checkbox')!;
      input.checked = true;
      host.append(field);
      document.body.append(host);
      const indicator = field.querySelector('.cinder-checkbox-field__indicator')!;
      const style = getComputedStyle(indicator);
      const expected = document.createElement('span');
      expected.style.color = 'var(--cinder-accent-contrast)';
      host.append(expected);
      const result = {
        glyph: style.backgroundColor,
        accentContrast: getComputedStyle(expected).color,
        opacity: style.opacity,
        inputAfter: getComputedStyle(input, '::after').content,
      };
      host.remove();
      return result;
    };
    return { page: probe(undefined), island: probe('light') };
  });

  // The glyph is the indicator, painted in its scope's accent contrast.
  expect(glyphs.island.opacity).toBe('1');
  expect(glyphs.island.glyph).toBe(glyphs.island.accentContrast);
  expect(glyphs.page.glyph).toBe(glyphs.page.accentContrast);
  // And the island's glyph is the light theme's, not the dark page's.
  expect(glyphs.island.glyph).not.toBe(glyphs.page.glyph);
  // Nothing is drawn on the replaced <input> itself.
  expect(['none', 'normal']).toContain(glyphs.island.inputAfter);
});
