/// <reference lib="dom" />
/**
 * A CodeBlock is one quiet shape: its bar (the language and Copy) shares the code's fill, so no
 * line or step of colour divides them; the bar is 28 to 32px tall with the language at the inline
 * start and an icon-only Copy at the inline end; a block with neither draws no bar; and the block
 * is set apart from the prose by one hairline in the light theme or its fill in the dark, never
 * both. Both themes.
 */

import { loadManifest } from '@lostgradient/testing';
import { expect, type Page } from '@playwright/test';
import { test } from './component-page-fixture.ts';

const entry = loadManifest().find((candidate) => candidate.slug === 'code-block');
const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'bar');

type Reading = {
  bar: { height: number; left: number; right: number; background: string } | null;
  language: { left: number; right: number } | null;
  copy: { left: number; right: number; text: string; width: number } | null;
  root: { left: number; right: number; background: string; edge: string };
  code: { background: string };
  page: string;
};

async function read(page: Page, testId: string): Promise<Reading> {
  return page.getByTestId(testId).evaluate((host) => {
    const root = host.querySelector('.cinder-code-block');
    if (!(root instanceof HTMLElement)) throw new Error('No code block.');
    const box = (element: Element | null) => element?.getBoundingClientRect();
    const bar = root.querySelector('.cinder-code-block__meta');
    const language = root.querySelector('.cinder-code-block__language');
    const copy = root.querySelector('.cinder-copy-button');
    const viewport = root.querySelector('.cinder-code-block__viewport');
    const rootBox = root.getBoundingClientRect();
    return {
      bar: bar
        ? {
            height: box(bar)!.height,
            left: box(bar)!.left,
            right: box(bar)!.right,
            background: getComputedStyle(bar).backgroundColor,
          }
        : null,
      language: language ? { left: box(language)!.left, right: box(language)!.right } : null,
      copy: copy
        ? {
            left: box(copy)!.left,
            right: box(copy)!.right,
            text: copy.textContent?.trim() ?? '',
            width: box(copy)!.width,
          }
        : null,
      root: {
        left: rootBox.left,
        right: rootBox.right,
        background: getComputedStyle(root).backgroundColor,
        edge: getComputedStyle(root, '::after').boxShadow,
      },
      code: { background: viewport ? getComputedStyle(viewport).backgroundColor : '' },
      page: getComputedStyle(document.body).backgroundColor,
    };
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`a code block is one quiet shape with a compact bar (${theme})`, async ({
    componentPage,
  }) => {
    if (entry === undefined || fixture === undefined) throw new Error('No code block bar fixture.');
    const page = await componentPage.open({
      entry,
      theme,
      viewport: { name: 'desktop', width: 1280, height: 1200 },
      fixtureName: 'bar',
      fixtureContentHash: fixture.fixtureContentHash,
    });
    await page.getByTestId('language-and-copy').locator('.cinder-copy-button').waitFor();

    const full = await read(page, 'language-and-copy');
    expect(full.bar?.height).toBeGreaterThanOrEqual(28);
    expect(full.bar?.height).toBeLessThanOrEqual(32);
    // The bar shares the block's fill, which is the code's fill: one shape, no divide.
    expect(full.root.background).toBe(full.code.background);
    expect(['rgba(0, 0, 0, 0)', full.code.background]).toContain(full.bar?.background);
    // One quiet surface: a hairline in the light theme, a fill in the dark, never both.
    const transparentEdge =
      full.root.edge === 'none' || full.root.edge.startsWith('rgba(0, 0, 0, 0)');
    expect(transparentEdge).toBe(theme === 'dark');
    // The language at the inline start, Copy at the inline end, icon only.
    expect(full.copy?.text).toBe('');
    expect(full.copy!.right).toBeGreaterThan(full.language!.right);
    expect(full.root.right - full.copy!.right).toBeLessThanOrEqual(8);

    // Copy alone still sits at the inline end.
    const copyOnly = await read(page, 'copy-only');
    expect(copyOnly.root.right - copyOnly.copy!.right).toBeLessThanOrEqual(8);
    // Neither: no bar at all.
    expect((await read(page, 'neither')).bar).toBeNull();
    // A long language label never pushes Copy out or under it.
    const long = await read(page, 'long-language');
    expect(long.language!.right).toBeLessThanOrEqual(long.copy!.left);
    expect(long.copy!.right).toBeLessThanOrEqual(long.root.right);
  });
}
