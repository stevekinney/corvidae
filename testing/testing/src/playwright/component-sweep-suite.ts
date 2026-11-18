import { readFileSync } from 'node:fs';

import { environmentConfiguration } from '../environment-configuration.ts';
import { applyComponentFilter, parseComponentFilter } from '../helpers/component-filter.ts';
import { loadManifest, THEMES, VIEWPORTS } from '../helpers/manifest.ts';
import { test } from './component-page-fixture.ts';
import { runFixtureSweep } from './component-sweep.ts';

/**
 * Slugs no component sweep covers. The terminal's baselines belong to its
 * `terminal-visual.playwright.ts`, so sweeping the entry as well would write each image from two
 * tests. The chat stress fixture is served by case (`?case=NN`) and captured by
 * `capture-chat-stress.ts`, which owns its images.
 */
export const UNSWEPT_SLUGS: ReadonlySet<string> = new Set(['terminal', 'chat-stress']);

/** The slugs the running package's suite owns (`owned-slugs.json`, written by its harness). */
export function ownedSlugs(path = environmentConfiguration().browserFixtureOwned): Set<string> {
  if (path === undefined || path.length === 0) {
    throw new Error(
      'BROWSER_FIXTURE_OWNED is not set: run the sweep through a package suite configuration.',
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed) || !parsed.every((slug) => typeof slug === 'string')) {
    throw new Error(`${path} is not a list of slugs.`);
  }
  return new Set(parsed);
}

/**
 * The component sweep (COR-2092): every fixture the package owns, in both themes and every
 * viewport, captured and checked by `runFixtureSweep`. Each package's
 * `browser/tests/components.playwright.ts` calls it once; together they cover what the root suite's
 * single sweep covered, with the same titles. `CINDER_TEST_COMPONENTS` narrows it, and an unknown
 * slug there throws, so a stale scope cannot silently omit coverage.
 */
export function defineComponentSweep(): void {
  const allEntries = loadManifest();
  const owned = ownedSlugs();
  const filterSlugs = parseComponentFilter(
    environmentConfiguration().cinderTestComponents,
    new Set(allEntries.map((entry) => entry.slug)),
  );
  const entries = applyComponentFilter(allEntries, filterSlugs).filter(
    (entry) => owned.has(entry.slug) && !UNSWEPT_SLUGS.has(entry.slug),
  );
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
}
