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
