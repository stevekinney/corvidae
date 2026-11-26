/**
 * The spacing allowlist holds today's offenders: the guard's real scan over the real tracked tree,
 * judged against `scripts/spacing-tokens-allowlist.json` through the same `judgeCounts` the guard
 * uses. A count that is too low (an exceeded count) or too high (a stale entry) fails here.
 *
 * The scan lists files through `git` and reads every tracked style file, so it is an integration
 * test and runs in the isolated lane.
 */
import { describe, expect, test } from 'bun:test';

import { ALLOWLIST_PATH, findOffScaleSpacing, trackedSpacingFiles } from './check-spacing-tokens';
import { judgeCounts, repositoryRoot, type CountAllowlist } from './owner-rule-guard-support';

describe('the spacing allowlist against the tracked tree', () => {
  test('holds no more sites than listed and lists no more than the tree holds', async () => {
    const allowlist = (await Bun.file(
      `${repositoryRoot}/${ALLOWLIST_PATH}`,
    ).json()) as CountAllowlist;
    const found = new Map<string, string[]>();
    for (const file of trackedSpacingFiles()) {
      const sites = findOffScaleSpacing(await Bun.file(`${repositoryRoot}/${file}`).text(), file);
      if (sites.length > 0) found.set(file, sites);
    }
    expect(found.size).toBeGreaterThan(0);
    // `problems` are exceeded counts and `stale` entries list more than the tree holds.
    expect(judgeCounts(found, allowlist)).toEqual({ problems: [], stale: [] });
  });
});
