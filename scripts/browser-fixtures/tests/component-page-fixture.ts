import type { ComponentEntry, Theme, Viewport } from '@corvidae/testing';
import { THEME_STORAGE_KEY, themeContextOptions } from '@corvidae/testing';
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { environmentConfiguration } from '../environment-configuration.ts';

type OpenArgs = {
  entry: ComponentEntry;
  theme: Theme;
  viewport: Viewport;
  fixtureName?: string;
  fixtureContentHash?: string;
  onPage?: (page: Page) => void | Promise<void>;
};

type Fixtures = { componentPage: { open(args: OpenArgs): Promise<Page> } };

function buildRoute(
  entry: ComponentEntry,
  fixtureName?: string,
  fixtureContentHash?: string,
): string {
  const params = new URLSearchParams({ snapshot: '1' });
  if (fixtureName !== undefined) params.set('fixture', fixtureName);
  const selectedHash =
    fixtureContentHash ??
    (fixtureName === undefined
      ? undefined
      : entry.fixtures?.find((fixture) => fixture.name === fixtureName)?.fixtureContentHash);
  if (selectedHash !== undefined) params.set('fixtureContentHash', selectedHash);
  return `${entry.route}?${params.toString()}`;
}

export const test = base.extend<Fixtures>({
  componentPage: async ({ browser }, use) => {
    const baseURL = environmentConfiguration().browserFixtureUrl;
    if (baseURL === undefined || baseURL.length === 0) {
      throw new Error('BROWSER_FIXTURE_URL must identify the fixture host.');
    }
    const contexts: BrowserContext[] = [];
    const diagnostics: string[] = [];
    try {
      await use({
        async open({ entry, theme, viewport, fixtureName, fixtureContentHash, onPage }) {
          const context = await browser.newContext({
            ...themeContextOptions(theme),
            viewport: { width: viewport.width, height: viewport.height },
            baseURL,
          });
          await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
            THEME_STORAGE_KEY,
            theme,
          ] as const);
          contexts.push(context);
          const page = await context.newPage();
          page.on('pageerror', (error) => diagnostics.push(`Page error: ${error.message}`));
          page.on('console', (message) => {
            if (message.type() === 'error' || message.type() === 'warning') {
              diagnostics.push(`Console ${message.type()}: ${message.text()}`);
            }
          });
          await onPage?.(page);
          await page.goto(buildRoute(entry, fixtureName, fixtureContentHash), {
            waitUntil: 'load',
          });
          await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
          const markdownEditors = page.locator('.markdown-editor-wrapper[data-mode="wysiwyg"]');
          if ((await markdownEditors.count()) > 0) {
            await page.waitForFunction(() =>
              Array.from(
                document.querySelectorAll('.markdown-editor-wrapper[data-mode="wysiwyg"]'),
              ).every((editor) => editor.getAttribute('data-ready') === 'true'),
            );
          }
          await page.evaluate(
            'const active = document.activeElement; if (active && typeof active.blur === "function") active.blur();',
          );
          return page;
        },
      });
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
    expect(diagnostics, `Unexpected fixture diagnostics:\n${diagnostics.join('\n')}`).toEqual([]);
  },
});

export { expect } from '@playwright/test';
