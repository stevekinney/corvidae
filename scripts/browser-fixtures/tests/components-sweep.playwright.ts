import {
  applyComponentFilter,
  loadManifest,
  parseComponentFilter,
  THEMES,
  VIEWPORTS,
} from '@lostgradient/testing';

import {
  test,
  type ComponentPageFixture,
} from '@lostgradient/testing/playwright/component-page-fixture';
import { runFixtureSweep } from '@lostgradient/testing/playwright/component-sweep';
import { environmentConfiguration } from '../environment-configuration.ts';

/** The root chat fixtures render a wall-clock receipt; freeze only their browser captures. */
const CHAT_FIXTURE_TIME = new Date('2026-11-24T15:30:00.000Z');

function capturePageFor(componentPage: ComponentPageFixture, slug: string) {
  if (slug !== 'chat' && slug !== 'chat-sub-session') return componentPage;
  return {
    open: async (args: Parameters<typeof componentPage.open>[0]) => {
      const onPage = args.onPage;
      return componentPage.open({
        ...args,
        onPage: async (page) => {
          await page.clock.setFixedTime(CHAT_FIXTURE_TIME);
          await onPage?.(page);
        },
      });
    },
  };
}

// The sweep mounts every fixture of every component in every theme and viewport: about half of the
// fixtures suite's cases. It lives apart from `components.playwright.ts` and runs in parallel mode
// so `playwright test --shard` deals its cases out one by one; as one serial file it was a single
// unit that no shard could split, and shard 1/4 took about 40 minutes (`components-sweep.bench.ts`).
// Baselines are keyed by component and fixture (`captureScreenshot`), never by this file's name.
test.describe.configure({ mode: 'parallel' });

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
// The terminal's baselines belong to the terminal package's `terminal-visual.playwright.ts`
// (`components/terminal/browser`), which owns them; sweeping the entry here as well would write each image from two tests. The Chat stress
// fixture is served by case (`?case=NN`) and captured by `capture-chat-stress.ts`, which owns its
// images, so this sweep leaves it out too.
const entries = applyComponentFilter(allEntries, filterSlugs).filter(
  (entry) => entry.slug !== 'terminal' && entry.slug !== 'chat-stress',
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
            await runFixtureSweep(
              capturePageFor(componentPage, entry.slug),
              entry,
              theme,
              viewport,
              fixture,
            );
          });
        }
      }
    }
  });
}
