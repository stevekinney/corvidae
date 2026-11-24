/// <reference lib="dom" />
/**
 * A CodeBlock is one quiet shape: its bar (the language and Copy) shares the code's fill, so no
 * line or step of colour divides them; the bar is 28 to 32px tall with the language at the inline
 * start and an icon-only Copy at the inline end; a block with neither draws no bar; and the block
 * is set apart from the prose by one hairline in the light theme or its fill in the dark, never
 * both. Both themes.
 */

import { loadManifest } from '@lostgradient/testing';
import { test } from '@lostgradient/testing/playwright/component-page-fixture';
import { expect, type Page } from '@playwright/test';

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
    // One quiet surface: the inset fill in both themes and no edge, so it is never a box inside a
    // card (owner, 2026-11-16).
    const transparentEdge =
      full.root.edge === 'none' || full.root.edge.startsWith('rgba(0, 0, 0, 0)');
    expect(transparentEdge).toBe(true);
    // The language at the inline start, Copy at the inline end, icon only.
    expect(full.copy?.text).toBe('');
    expect(full.copy!.right).toBeGreaterThan(full.language!.right);
    expect(full.root.right - full.copy!.right).toBeLessThanOrEqual(8);

    // Copy alone still sits at the inline end. It floats, and the floating inset aligns its painted
    // 24px face with the code while its 44px coarse target remains reachable past the shell.
    const copyOnly = await read(page, 'copy-only');
    expect(copyOnly.root.right - copyOnly.copy!.right).toBeLessThanOrEqual(10);
    // Neither: no bar at all.
    const neither = await read(page, 'neither');
    expect(neither.bar).toBeNull();
    // A long language label never pushes Copy out or under it.
    const long = await read(page, 'long-language');
    expect(long.language!.right).toBeLessThanOrEqual(long.copy!.left);
    expect(long.copy!.right).toBeLessThanOrEqual(long.root.right);
  });
}

for (const width of [320, 375]) {
  test(`the Copy target remains reachable at both outer edges on a ${width}px phone`, async ({
    componentPage,
  }) => {
    if (entry === undefined || fixture === undefined) throw new Error('No code block bar fixture.');
    const page = await componentPage.open({
      entry,
      theme: 'light',
      viewport: { name: 'mobile', width, height: 900 },
      hasTouch: true,
      fixtureName: 'bar',
      fixtureContentHash: fixture.fixtureContentHash,
    });
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
    const fixtureHost = page.getByTestId('language-and-copy');
    await fixtureHost.locator('.cinder-copy-button').waitFor();

    const hitTargets = await fixtureHost.evaluate((host) => {
      const root = host.querySelector('.cinder-code-block');
      const button = host.querySelector('.cinder-copy-button');
      if (!(root instanceof HTMLElement) || !(button instanceof HTMLElement)) {
        throw new Error('Missing CodeBlock Copy target.');
      }
      const rootBox = root.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      const y = (buttonBox.top + buttonBox.bottom) / 2;
      const outerInlineEnd = document.elementFromPoint(buttonBox.right + 9, y);
      const outerBlockStart = document.elementFromPoint(
        (buttonBox.left + buttonBox.right) / 2,
        buttonBox.top - 9,
      );
      return {
        shellClips: getComputedStyle(root).overflow,
        copyWidth: buttonBox.width,
        endTargetIsCopy: outerInlineEnd === button || button.contains(outerInlineEnd),
        startTargetIsCopy: outerBlockStart === button || button.contains(outerBlockStart),
        extendsPastShellEnd: buttonBox.right + 9 > rootBox.right,
        extendsPastShellStart: buttonBox.top - 9 < rootBox.top,
      };
    });

    expect(hitTargets.shellClips).toBe('visible');
    expect(hitTargets.copyWidth).toBe(24);
    expect(hitTargets.extendsPastShellEnd).toBe(true);
    expect(hitTargets.extendsPastShellStart).toBe(true);
    expect(hitTargets.endTargetIsCopy).toBe(true);
    expect(hitTargets.startTargetIsCopy).toBe(true);
  });
}
