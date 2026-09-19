import type { ComponentEntry, Theme, Viewport } from '@corvidae/testing';
import {
  applyComponentFilter,
  applyInteractions,
  loadManifest,
  manifestDigest,
  parseComponentFilter,
  THEMES,
  VIEWPORTS,
} from '@corvidae/testing';

import { resolve } from 'node:path';
import { environmentConfiguration } from '../environment-configuration.ts';
import { expect, test } from './component-page-fixture.ts';
import { runFixtureSweep } from './component-sweep.ts';

type LiveManifest = { digest: string; entries: unknown[] };
type ComponentPage = {
  open(args: {
    entry: ComponentEntry;
    theme: Theme;
    viewport: Viewport;
    fixtureName?: string;
    fixtureContentHash?: string;
  }): Promise<import('@playwright/test').Page>;
};

function isLiveManifest(value: unknown): value is LiveManifest {
  return (
    value !== null &&
    typeof value === 'object' &&
    'digest' in value &&
    typeof value.digest === 'string' &&
    'entries' in value &&
    Array.isArray(value.entries)
  );
}

test.describe('server identity', () => {
  test('cached manifest matches live standalone manifest', async ({ request }) => {
    const response = await request.get('/api/manifest?standalone=1');
    expect(response.ok()).toBeTruthy();

    const live: unknown = await response.json();
    if (!isLiveManifest(live)) throw new Error('Live fixture manifest has an invalid shape.');

    expect(
      live.digest,
      [
        'Live manifest digest must match cached manifest digest.',
        'Re-run the fixture host manifest preparation command to regenerate the cache.',
        '',
        `Live components:   ${loadManifest()
          .map((entry) => entry.name)
          .toSorted()
          .join(', ')}`,
        `Cached components: ${loadManifest()
          .map((entry) => entry.name)
          .toSorted()
          .join(', ')}`,
      ].join('\n'),
    ).toBe(manifestDigest());
  });
});

// `CINDER_TEST_COMPONENTS` is an optional comma-separated allow-list supplied
// by the caller when a focused component run is useful. Empty, whitespace, or
// unset values run the full matrix. Unknown slugs throw so a stale scope
// selection cannot silently omit coverage.
const allEntries = loadManifest();
const knownSlugs = new Set(allEntries.map((entry) => entry.slug));
const filterSlugs = parseComponentFilter(
  environmentConfiguration().cinderTestComponents,
  knownSlugs,
);
const entries = applyComponentFilter(allEntries, filterSlugs);

test('visual baselines belong to the application, browser project, and platform', () => {
  const testInfo = test.info();
  expect(testInfo.snapshotPath('button', 'light-desktop-assertion.png')).toBe(
    resolve(
      import.meta.dirname,
      '..',
      'snapshots',
      testInfo.project.name,
      process.platform,
      'button',
      'light-desktop-assertion.png',
    ),
  );
});

test.describe('fixture manifest metadata', () => {
  test('embeds fixture metadata and content hashes without fixture props', () => {
    const input = allEntries.find((entry) => entry.slug === 'input');
    expect(input).toBeDefined();
    const focused = input?.fixtures?.find((fixture) => fixture.name === 'focused');
    expect(focused).toBeDefined();
    expect(focused?.fixtureContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(focused?.category).toBe('interaction-state');
    expect(focused?.interact).toEqual([{ action: 'focus', target: { label: 'Focused input' } }]);
    expect(Object.hasOwn(focused ?? {}, 'props')).toBe(false);
  });
});

test.describe('fixture interaction rendering', () => {
  test('focused input fixture reaches document.activeElement', async ({ componentPage }) => {
    const entry = allEntries.find((candidate) => candidate.slug === 'input');
    const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'focused');
    expect(entry).toBeDefined();
    expect(fixture).toBeDefined();

    const page = await componentPage.open({
      entry: entry!,
      theme: 'light',
      viewport: VIEWPORTS.find((viewport) => viewport.name === 'desktop')!,
      fixtureName: fixture!.name,
      fixtureContentHash: fixture!.fixtureContentHash,
    });

    await applyInteractions(page, fixture!.interact ?? [], {
      component: entry!.slug,
      fixture: fixture!.name,
    });

    await expect(page.getByLabel('Focused input')).toBeFocused();
  });

  test('dropdown interaction fixture exposes the opened menu surface', async ({
    componentPage,
  }) => {
    const entry = allEntries.find((candidate) => candidate.slug === 'dropdown');
    const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'opened-by-trigger');
    expect(entry).toBeDefined();
    expect(fixture).toBeDefined();

    const page = await componentPage.open({
      entry: entry!,
      theme: 'light',
      viewport: VIEWPORTS.find((viewport) => viewport.name === 'desktop')!,
      fixtureName: fixture!.name,
      fixtureContentHash: fixture!.fixtureContentHash,
    });

    await applyInteractions(page, fixture!.interact ?? [], {
      component: entry!.slug,
      fixture: fixture!.name,
    });

    await expect(page.getByRole('menu')).toBeVisible();
  });
});

async function assertRows(page: import('@playwright/test').Page, selector: string) {
  const result = await page.locator(selector).evaluateAll((rows, expectedSelector) => {
    const pseudo = (row: Element) => getComputedStyle(row, '::after').content !== 'none';
    return rows.map((row) => {
      const siblings = Array.from(row.parentElement?.children ?? []);
      const index = siblings.indexOf(row);
      const later = siblings.slice(index + 1);
      const nextSeparator = later.findIndex((sibling) =>
        sibling.classList.contains('cinder-dropdown-separator'),
      );
      const beforeSeparator = nextSeparator < 0 ? later : later.slice(0, nextSeparator);
      const hasVisibleLaterRow = beforeSeparator.some(
        (sibling) =>
          sibling.matches(expectedSelector) && !(sibling instanceof HTMLElement && sibling.hidden),
      );
      return { hasVisibleLaterRow, hasDivider: pseudo(row) };
    });
  }, selector);
  expect(result.length, `${selector} must render real option rows`).toBeGreaterThan(0);
  for (const row of result) expect(row.hasDivider).toBe(row.hasVisibleLaterRow);
}

async function openAssertionFixture(
  componentPage: ComponentPage,
  slug: string,
  theme: (typeof THEMES)[number],
  width: number,
) {
  const entry = allEntries.find((candidate) => candidate.slug === slug);
  expect(entry, `${slug} must be present in the fixture manifest`).toBeDefined();
  const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'assertion');
  expect(fixture, `${slug} must expose its assertion fixture`).toBeDefined();
  const page = await componentPage.open({
    entry: entry!,
    theme,
    viewport: VIEWPORTS.find((viewport) => viewport.name === 'desktop')!,
    fixtureName: fixture!.name,
    fixtureContentHash: fixture!.fixtureContentHash,
  });
  await page.setViewportSize({ width, height: 900 });
  return page;
}

for (const theme of THEMES) {
  for (const width of [320, 512, 848]) {
    test(`dropdown dividers appear only between visible items ${theme}-${width}`, async ({
      componentPage,
    }) => {
      const page = await openAssertionFixture(componentPage, 'dropdown', theme, width);
      const trigger = page.getByRole('button', { name: 'Row regression' });
      await trigger.focus();
      await trigger.press('Enter');
      await expect(page.getByRole('menu').last()).toBeVisible();
      await assertRows(page, '.cinder-dropdown-item');
    });

    test(`command-menu dividers appear only between visible items ${theme}-${width}`, async ({
      componentPage,
    }) => {
      const page = await openAssertionFixture(componentPage, 'command-menu', theme, width);
      const notes = page.getByLabel('Notes');
      await notes.fill('/');
      await expect(page.locator('.cinder-command-item').first()).toBeVisible();
      await page.locator('.cinder-command-item').first().press('ArrowDown');
      await notes.fill('/summary');
      await expect(page.locator('.cinder-command-item:visible')).toHaveCount(1);
      await assertRows(page, '.cinder-command-item');
      await notes.fill('/');
      await expect(page.locator('.cinder-command-item:visible')).toHaveCount(4);
      await assertRows(page, '.cinder-command-item');
    });

    test(`side-navigation dividers appear only between visible items ${theme}-${width}`, async ({
      componentPage,
    }) => {
      const page = await openAssertionFixture(componentPage, 'side-navigation', theme, width);
      const first = page.locator('.cinder-navigation-item').first();
      await first.focus();
      await first.press('Tab');
      const projects = page.getByRole('button', { name: 'Projects' });
      await projects.click();
      await expect(page.locator('.cinder-navigation-item:visible')).toHaveCount(2);
      await projects.click();
      await expect(page.locator('.cinder-navigation-item:visible')).toHaveCount(5);
      await assertRows(page, '.cinder-navigation-item');
    });

    test(`combobox dividers appear only between visible items ${theme}-${width}`, async ({
      componentPage,
    }) => {
      const page = await openAssertionFixture(componentPage, 'combobox', theme, width);
      const input = page.getByLabel('Favorite fruit');
      await input.click();
      await expect(page.locator('.cinder-combobox__option').first()).toBeVisible();
      await input.press('ArrowDown');
      await input.fill('apple');
      await expect(page.locator('.cinder-combobox__option:visible')).toHaveCount(1);
      await assertRows(page, '.cinder-combobox__option');
      await input.fill('');
      await expect(page.locator('.cinder-combobox__option:visible')).toHaveCount(10);
      await assertRows(page, '.cinder-combobox__option');
    });

    test(`native select keyboard behavior is preserved ${theme}-${width}`, async ({
      componentPage,
    }) => {
      const page = await openAssertionFixture(componentPage, 'select', theme, width);
      const select = page.getByLabel('Environment');
      await select.focus();
      await expect(select.locator('option')).toHaveCount(2);
      await expect(select).toBeFocused();
      await select.press('ArrowDown');
      await expect(select).toHaveValue('beta');
    });
  }
}

for (const entry of entries) {
  test.describe(entry.name, () => {
    const fixtures = entry.fixtures;
    if (fixtures === undefined || fixtures.length === 0) {
      throw new Error(`Fixture manifest entry '${entry.slug}' has no extracted fixtures.`);
    }

    for (const theme of THEMES) {
      for (const viewport of VIEWPORTS) {
        for (const fixture of fixtures) {
          test(`${theme}-${viewport.name}-${fixture.name}`, async ({ componentPage }) => {
            await runFixtureSweep(componentPage, entry, theme, viewport, fixture);
          });
        }
      }
    }
  });
}
