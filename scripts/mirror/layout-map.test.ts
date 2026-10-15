import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { throwingRejectionOf } from '../promise-outcome.test-support.ts';
import {
  DeferredWorkspaceError,
  layoutCoverage,
  layoutFor,
  LayoutMapError,
  loadLayoutMap,
  targetDirectoryFor,
} from './layout-map.ts';
import { composeManifest } from './manifests.ts';
import { loadTargetOwnedPolicy } from './target-owned.ts';

const corvidaeRoot = join(import.meta.dir, '..', '..');

/** Write one throwaway layout table and hand its path to the body. */
async function withTable(table: unknown, body: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-layout-'));
  try {
    const path = join(directory, 'layout-map.json');
    await Bun.write(path, `${JSON.stringify(table, undefined, 2)}\n`);
    await body(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('the layout table against the committed tree', () => {
  test('every workspace on disk has an entry, at the directory it actually occupies', async () => {
    expect(await layoutCoverage(corvidaeRoot)).toEqual({
      missing: [],
      extra: [],
      misplaced: [],
    });
  });

  test('the components become the packages the targets publish them from', async () => {
    expect(await targetDirectoryFor('@lostgradient/cinder')).toBe('packages/components');
    expect(await targetDirectoryFor('@lostgradient/editor')).toBe('packages/editor');
    expect(await targetDirectoryFor('@lostgradient/weft-ui')).toBe('packages/weft-ui');
    expect(await targetDirectoryFor('@lostgradient/weft')).toBe('packages/weft');
  });

  test('a workspace with no entry stops the transform by name', async () => {
    expect(await throwingRejectionOf(layoutFor('@lostgradient/nonexistent'))).toThrow(
      LayoutMapError,
    );
  });
});

describe('the deferred playground application', () => {
  test('stays deferred to COR-1201 so lifting its exclusion forces a ruling on placement', async () => {
    const layout = await layoutFor('@lostgradient/playground');

    expect(layout.disposition).toBe('deferred');
    if (layout.disposition !== 'deferred') throw new Error('unreachable');
    expect(layout.corvidaeDirectory).toBe('applications/playground');
    expect(layout.issue).toBe('COR-1201');
    expect(await throwingRejectionOf(targetDirectoryFor('@lostgradient/playground'))).toThrow(
      DeferredWorkspaceError,
    );
    try {
      await targetDirectoryFor('@lostgradient/playground');
    } catch (error) {
      expect((error as Error).message).toContain('@lostgradient/playground');
      expect((error as Error).message).toContain('COR-1201');
    }
  });
});

describe('the table itself', () => {
  test('two workspaces in one target directory is a load failure, not an overwrite', async () => {
    await withTable(
      {
        documentation: 'A fixture table.',
        workspaces: {
          '@lostgradient/one': {
            disposition: 'emit',
            corvidaeDirectory: 'packages/one',
            targetDirectory: 'packages/shared',
            reason: 'Fixture.',
          },
          '@lostgradient/two': {
            disposition: 'emit',
            corvidaeDirectory: 'packages/two',
            targetDirectory: 'packages/shared',
            reason: 'Fixture.',
          },
        },
        openQuestions: [],
      },
      async (path) => {
        expect(await throwingRejectionOf(loadLayoutMap(path))).toThrow(LayoutMapError);
      },
    );
  });

  test('a deferred entry without an issue is malformed', async () => {
    await withTable(
      {
        documentation: 'A fixture table.',
        workspaces: {
          '@lostgradient/one': {
            disposition: 'deferred',
            corvidaeDirectory: 'packages/one',
            reason: 'Fixture.',
          },
        },
        openQuestions: [],
      },
      async (path) => {
        expect(await throwingRejectionOf(loadLayoutMap(path))).toThrow(LayoutMapError);
      },
    );
  });
});

describe('the manifest the remap makes reachable', () => {
  /**
   * Cinder's husky `prepare` is not at its root: `packages/components/package.json` carries
   * `"prepare": "cd ../.. && husky"`. Nothing could preserve it while the transform emitted
   * `@lostgradient/cinder` at corvidae's own `components/cinder`, because the composition never saw
   * the target's manifest at all. This is the pairing: the table sends the workspace to the path
   * the target keeps it at, and the target's own manifest is then what gets composed against.
   *
   * COR-1223 is why the assertion is about the whole block rather than one key. The old rule
   * preserved an enumerated `/scripts/prepare` pointer and dropped every sibling; the inverted one
   * has no list of scripts to get wrong.
   */
  test('cinder’s whole scripts block survives a rewrite of packages/components/package.json', async () => {
    const policy = await loadTargetOwnedPolicy();
    const file = `${await targetDirectoryFor('@lostgradient/cinder')}/package.json`;
    expect(file).toBe('packages/components/package.json');

    const scripts = { prepare: 'cd ../.. && husky', build: 'bun run scripts/build.ts' };
    const { manifest } = composeManifest({
      policy,
      target: 'cinder',
      emitted: { name: '@lostgradient/cinder', scripts: {} },
      existing: { name: '@lostgradient/cinder', scripts },
      mirrorPackages: new Set(),
    });
    expect(manifest['scripts']).toEqual(scripts);
  });
});
