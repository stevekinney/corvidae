/// <reference lib="dom" />
/**
 * JsonEditor layout, measured in a browser because happy-dom performs no layout.
 *
 * Gutter: CodeMirror does not measure an editor wholly outside the window, so one that mounted
 * below the fold drew its line numbers from a 14px estimate with no top padding, drifting further
 * from their lines down the document until it scrolled into view (and forever in a capture beyond
 * the viewport). The `long-document` fixture is opened in a window too short to show the editor,
 * and every drawn number must sit on its line without the page scrolling.
 */

import { THEME_STORAGE_KEY } from '@lostgradient/testing';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

const TOLERANCE = 0.5;

async function openFixture(
  browser: Browser,
  options: { fixtureName: string; theme?: 'light' | 'dark'; width: number; height: number },
): Promise<Page> {
  const theme = options.theme ?? 'light';
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: 'reduce',
    viewport: { width: options.width, height: options.height },
  });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    THEME_STORAGE_KEY,
    theme,
  ] as const);
  const page = await context.newPage();
  await page.goto(fixtureRoute('json-editor', { fixtureName: options.fixtureName }), {
    waitUntil: 'load',
  });
  await page.locator('.cinder-json-editor .cm-editor .cm-line').first().waitFor({
    state: 'attached',
  });
  return page;
}

type GutterGeometry = { lines: number; numbers: number; worstOffset: number };

/** Pair each drawn line number with its text line and report the worst vertical offset. */
async function gutterGeometry(page: Page): Promise<GutterGeometry> {
  return await page.evaluate(() => {
    const lines = [...document.querySelectorAll('.cinder-json-editor .cm-content > .cm-line')];
    const numbers = [
      ...document.querySelectorAll('.cinder-json-editor .cm-lineNumbers .cm-gutterElement'),
    ].filter((element) => element.textContent !== '' && element.getBoundingClientRect().height > 0);
    let worstOffset = 0;
    for (const [index, number] of numbers.entries()) {
      const line = lines[index];
      if (!line) continue;
      const offset = Math.abs(
        number.getBoundingClientRect().top - line.getBoundingClientRect().top,
      );
      worstOffset = Math.max(worstOffset, offset);
    }
    return { lines: lines.length, numbers: numbers.length, worstOffset };
  });
}

for (const width of [1280, 390]) {
  test(`JsonEditor gutter sits on its lines when the editor mounts below the fold, at ${width}`, async ({
    browser,
  }) => {
    const page = await openFixture(browser, { fixtureName: 'long-document', width, height: 30 });
    try {
      const editorTop = await page
        .locator('.cinder-json-editor .cm-editor')
        .evaluate((element) => element.getBoundingClientRect().top);
      expect(editorTop, 'the editor starts below the window').toBeGreaterThan(30);

      await expect
        .poll(async () => {
          const geometry = await gutterGeometry(page);
          return geometry.numbers === geometry.lines && geometry.worstOffset <= TOLERANCE;
        })
        .toBe(true);
      const geometry = await gutterGeometry(page);
      expect(geometry.lines, 'the whole short document is drawn').toBe(32);
      expect(await page.evaluate(() => window.scrollY), 'mounting never scrolls the page').toBe(0);
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
    } finally {
      await page.context().close();
    }
  });
}

test('JsonEditor gutter sits on its lines for an editor in view', async ({ browser }) => {
  const page = await openFixture(browser, {
    fixtureName: 'long-document',
    width: 1280,
    height: 900,
  });
  try {
    await expect
      .poll(async () => {
        const geometry = await gutterGeometry(page);
        return geometry.numbers === geometry.lines && geometry.worstOffset <= TOLERANCE;
      })
      .toBe(true);
  } finally {
    await page.context().close();
  }
});
