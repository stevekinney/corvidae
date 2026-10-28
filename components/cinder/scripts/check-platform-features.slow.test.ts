/**
 * The live scan of Cinder's real component source tree, in the slow lane (COR-1737): it reads
 * every `.css`, `.svelte` and `.ts` file under `src`, which takes longer than the fast lane's
 * budget once the other test processes compete for the disk. The scanner's own rules are
 * covered in `check-platform-features.test.ts`.
 */
import { describe, expect, test } from 'bun:test';

import { FEATURE_PROBES, scan, VIEWPORT_WIDTH_MEDIA } from './check-platform-features.ts';

describe('scan — live inventory against the real source tree', () => {
  test('reports usage for every classified probe and only real viewport flags', async () => {
    const { counts, viewportFlags } = await scan();

    // Every probe in the policy table is represented in the report.
    expect(counts.map((entry) => entry.feature).toSorted()).toEqual(
      FEATURE_PROBES.map((probe) => probe.feature).toSorted(),
    );

    // Tier-1 baselines the library genuinely relies on must show real usage,
    // so a refactor that accidentally strips them is visible.
    const byFeature = new Map(counts.map((entry) => [entry.feature, entry.count]));
    for (const feature of ['@layer', 'container queries', '<dialog>', 'inert']) {
      expect(byFeature.get(feature) ?? 0).toBeGreaterThan(0);
    }

    // The scanner is actually walking the tree (known viewport sites exist today),
    // and every flag is a real @media(width) prelude with a concrete location.
    expect(viewportFlags.length).toBeGreaterThan(0);
    for (const flag of viewportFlags) {
      expect(flag.filePath).toMatch(/\.(css|svelte)$/);
      expect(flag.lineNumber).toBeGreaterThan(0);
      expect(VIEWPORT_WIDTH_MEDIA.test(flag.query)).toBe(true);
    }
  });
});
