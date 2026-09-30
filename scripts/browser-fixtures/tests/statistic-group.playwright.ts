import type { ComponentEntry, Theme, Viewport } from '@lostgradient/testing';
import { loadManifest, VIEWPORTS } from '@lostgradient/testing';
import type { Locator, Page } from '@playwright/test';

import { expect, test } from './component-page-fixture.ts';

/**
 * Computed-style coverage for StatisticGroup's container-query column collapse
 * (COR-602). A size query measures the container's CONTENT box, and the
 * `default` variant pads its root by 1rem and borders it by 1px on each side,
 * so the applied inline-size is the target content width plus 34px. The
 * thresholds are 30rem (480px) and 18rem (288px), both inclusive.
 *
 * Content-box widths: 500 -> 3 tracks, 400 -> 2 tracks, 260 -> 1 track.
 */
const CHROME = 34;
const CASES = [
  { content: 500, tracks: 3 },
  { content: 400, tracks: 2 },
  { content: 260, tracks: 1 },
] as const;

const allEntries = loadManifest();

type ComponentPage = {
  open(args: {
    entry: ComponentEntry;
    theme: Theme;
    viewport: Viewport;
    fixtureName?: string;
    fixtureContentHash?: string;
  }): Promise<Page>;
};

async function openFixture(componentPage: ComponentPage, slug: string): Promise<Page> {
  const entry = allEntries.find((candidate) => candidate.slug === slug);
  expect(entry, `${slug} must be present in the fixture manifest`).toBeDefined();
  const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'assertion');
  expect(fixture, `${slug} must expose its assertion fixture`).toBeDefined();
  const page = await componentPage.open({
    entry: entry!,
    theme: 'light',
    viewport: VIEWPORTS.find((viewport) => viewport.name === 'desktop')!,
    fixtureName: fixture!.name,
    fixtureContentHash: fixture!.fixtureContentHash,
  });
  await page.setViewportSize({ width: 1200, height: 900 });
  return page;
}

async function setInlineSize(root: Locator, content: number): Promise<void> {
  await root.evaluate((element, inlineSize) => {
    if (!(element instanceof HTMLElement)) throw new Error('Expected StatisticGroup root.');
    element.style.inlineSize = `${inlineSize}px`;
    element.style.maxInlineSize = `${inlineSize}px`;
  }, content + CHROME);
}

async function contentWidth(root: Locator): Promise<number> {
  return root.evaluate((element) => {
    const style = getComputedStyle(element);
    return (
      element.getBoundingClientRect().width -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight) -
      parseFloat(style.borderLeftWidth) -
      parseFloat(style.borderRightWidth)
    );
  });
}

async function trackCount(root: Locator): Promise<number> {
  return root
    .locator('> .cinder-statistic-group__grid')
    .evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length);
}

// Cinder's transition rules settle a directly-applied size a frame later, so
// wait for the content box to reach the target before reading computed styles.
async function expectContentWidth(root: Locator, content: number): Promise<void> {
  await expect
    .poll(() => contentWidth(root), { message: `content box at ${content}px` })
    .toBeCloseTo(content, 0);
}

type CellBorders = { inlineEnd: string; blockEnd: string };

async function cellBorders(root: Locator): Promise<CellBorders[]> {
  return root.locator('> .cinder-statistic-group__grid > .cinder-statistic').evaluateAll((cells) =>
    cells.map((cell) => {
      const style = getComputedStyle(cell);
      return { inlineEnd: style.borderInlineEndWidth, blockEnd: style.borderBlockEndWidth };
    }),
  );
}

test.describe('StatisticGroup column collapse (computed style)', () => {
  test('standalone six-cell group collapses 3, 2, 1 tracks with shifting row-end dividers', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage, 'statistic-group-six-cell');
    const root = page.locator('#statistic-group-six-cell');
    for (const { content, tracks } of CASES) {
      await setInlineSize(root, content);
      await expectContentWidth(root, content);
      await expect
        .poll(() => trackCount(root), { message: `tracks at content width ${content}px` })
        .toBe(tracks);

      const expected = Array.from({ length: 6 }, (_, index): CellBorders => {
        const position = index + 1;
        const isLast = position === 6;
        if (tracks === 1) return { inlineEnd: '0px', blockEnd: isLast ? '0px' : '1px' };
        const rowEnd = position % tracks === 0;
        return { inlineEnd: rowEnd || isLast ? '0px' : '1px', blockEnd: '0px' };
      });
      await expect
        .poll(() => cellBorders(root), { message: `dividers at ${tracks} tracks` })
        .toEqual(expected);
    }
  });

  test('nested inner group queries its own width while the outer stays at 3 tracks', async ({
    componentPage,
  }) => {
    const page = await openFixture(componentPage, 'statistic-group-nested');
    const outer = page.locator('#statistic-group-outer');
    await setInlineSize(outer, CASES[0].content);
    const names = ['wide', 'medium', 'narrow'] as const;
    for (const [index, name] of names.entries()) {
      const inner = page.locator(`#statistic-group-inner-${name}`);
      const { content } = CASES[index]!;
      await setInlineSize(inner, content);
      await expectContentWidth(inner, content);
    }
    for (const [index, name] of names.entries()) {
      const inner = page.locator(`#statistic-group-inner-${name}`);
      await expect
        .poll(() => trackCount(inner), { message: `inner ${name} tracks` })
        .toBe(CASES[index]!.tracks);
    }
    await expectContentWidth(outer, CASES[0].content);
    expect(await trackCount(outer)).toBe(3);
  });
});
