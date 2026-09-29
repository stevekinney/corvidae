import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

import { serializeJson } from './json-formatting.ts';
import { loadPackageMap } from './package-map.ts';
import { describeDrift, fetchPublishedSubpaths } from './refresh-registry-baseline.ts';
import {
  assertParity,
  baselineFile,
  checkParity,
  describeParity,
  isFirstPublish,
  loadRegistryBaseline,
  RegistryBaselineError,
  type RegistryBaseline,
} from './registry-baseline.ts';

/**
 * The baseline is committed rather than fetched, so the risk it carries is staleness rather than
 * flakiness. These tests close that offline: `package-map.json` independently records each
 * package's last published version, so a bump there with no refresh here fails without a network
 * call. `refresh-registry-baseline.ts --verify` is what closes the remaining gap, and it is
 * deliberately not run from `test:self`.
 */

function baselineOf(packages: RegistryBaseline['packages']): RegistryBaseline {
  return { documentation: 'fixture', source: 'https://registry.npmjs.org', packages };
}

const stubResponse = (status: number, body: unknown): Response =>
  new Response(status === 404 ? null : JSON.stringify(body), { status });

describe('registry-baseline.json', () => {
  test('parses', async () => {
    expect(await loadRegistryBaseline()).toBeDefined();
  });

  test('uses repository formatting after a registry refresh', async () => {
    const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
    expect(await Bun.file(baselineFile).text()).toBe(
      await serializeJson(
        await loadRegistryBaseline(),
        sourceRoot,
        'scripts/mirror/registry-baseline.json',
      ),
    );
  });

  test('records exactly the packages the map says have a published predecessor', async () => {
    const baseline = await loadRegistryBaseline();
    const map = await loadPackageMap();
    const expected = Object.values(map.workspaces)
      .filter((entry) => entry.disposition === 'publish-as' && entry.lastPublishedVersion !== null)
      .map((entry) => (entry.disposition === 'publish-as' ? entry.name : ''))
      .toSorted();
    expect(Object.keys(baseline.packages).toSorted()).toEqual(expected);
  });

  test('agrees with the map about every recorded version', async () => {
    const baseline = await loadRegistryBaseline();
    const map = await loadPackageMap();
    for (const [name, entry] of Object.entries(baseline.packages)) {
      const disposition = map.workspaces[entry.workspace];
      expect(disposition?.disposition, `${name} names an unknown workspace`).toBe('publish-as');
      if (disposition?.disposition !== 'publish-as') continue;
      expect(
        entry.version,
        `${name} baseline is stale: run bun scripts/mirror/refresh-registry-baseline.ts`,
      ).toBe(disposition.lastPublishedVersion ?? '');
    }
  });

  test('carries a non-empty subpath set for every package', async () => {
    const baseline = await loadRegistryBaseline();
    for (const [name, entry] of Object.entries(baseline.packages)) {
      expect(entry.subpaths.length, `${name} has no recorded subpaths`).toBeGreaterThan(0);
      expect(entry.subpaths, `${name} is not sorted`).toEqual(entry.subpaths.toSorted());
    }
  });
});

describe('checkParity', () => {
  const baseline = baselineOf({
    example: {
      workspace: '@lostgradient/example',
      version: '1.0.0',
      fetchedAt: '2026-09-18',
      subpaths: ['.', './extra'],
    },
  });

  test('passes when the emitted map is a superset', () => {
    const result = checkParity(baseline, 'example', { '.': {}, './extra': {}, './new': {} });
    expect(result.missing).toEqual([]);
    expect(result.added).toEqual(['./new']);
    expect(isFirstPublish(result)).toBe(false);
  });

  test('names every published subpath the emitted map dropped', () => {
    const result = checkParity(baseline, 'example', { '.': {} });
    expect(result.missing).toEqual(['./extra']);
    expect(describeParity([result])).toContain('FAIL example');
    expect(() => assertParity([result])).toThrow(RegistryBaselineError);
  });

  test('treats a missing predecessor as a first publish, not a parity failure', () => {
    const result = checkParity(baseline, 'brand-new', { '.': {} });
    expect(isFirstPublish(result)).toBe(true);
    expect(result.missing).toEqual([]);
    expect(describeParity([result])).toContain('first publish brand-new');
    expect(() => assertParity([result])).not.toThrow();
  });
});

describe('fetchPublishedSubpaths', () => {
  test('returns the sorted subpath keys of the latest version', async () => {
    const fetched = await fetchPublishedSubpaths('example', (() =>
      Promise.resolve(
        stubResponse(200, {
          'dist-tags': { latest: '2.0.0' },
          versions: { '2.0.0': { exports: { './b': {}, '.': {} } } },
        }),
      )) as unknown as typeof fetch);
    expect(fetched).toEqual({ name: 'example', version: '2.0.0', subpaths: ['.', './b'] });
  });

  test('reports a 404 as no predecessor rather than an error', async () => {
    const fetched = await fetchPublishedSubpaths('gone', (() =>
      Promise.resolve(stubResponse(404, undefined))) as unknown as typeof fetch);
    expect(fetched).toBeUndefined();
  });

  test('treats a version with no exports map as exporting nothing', async () => {
    const fetched = await fetchPublishedSubpaths('legacy', (() =>
      Promise.resolve(
        stubResponse(200, { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } }),
      )) as unknown as typeof fetch);
    expect(fetched?.subpaths).toEqual([]);
  });
});

describe('describeDrift', () => {
  const committed = baselineOf({
    example: {
      workspace: '@lostgradient/example',
      version: '1.0.0',
      fetchedAt: '2026-09-18',
      subpaths: ['.'],
    },
  });

  test('reports nothing when the two agree', () => {
    expect(describeDrift(committed, committed)).toEqual([]);
  });

  test('reports a newer published version and a newly published subpath', () => {
    const fresh = baselineOf({
      example: {
        workspace: '@lostgradient/example',
        version: '1.1.0',
        fetchedAt: '2026-09-19',
        subpaths: ['.', './added'],
      },
    });
    expect(describeDrift(committed, fresh)).toEqual([
      'example: baseline records 1.0.0, registry publishes 1.1.0',
      'example: baseline is missing ./added',
    ]);
  });

  test('reports a package the baseline never saw', () => {
    const fresh = baselineOf({
      ...committed.packages,
      other: {
        workspace: '@lostgradient/other',
        version: '0.1.0',
        fetchedAt: '2026-09-19',
        subpaths: ['.'],
      },
    });
    expect(describeDrift(committed, fresh)).toEqual([
      'other: published at 0.1.0 but absent from the committed baseline',
    ]);
  });
});
