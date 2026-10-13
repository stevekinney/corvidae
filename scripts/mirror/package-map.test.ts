import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { throwingRejectionOf } from '../promise-outcome.test-support.ts';
import {
  coverageReport,
  discoverWorkspaceNames,
  dispositionFor,
  loadPackageMap,
  PackageMapError,
  publishableNames,
} from './package-map.ts';

const repositoryRoot = new URL('../../', import.meta.url).pathname;

/**
 * A throwaway workspace tree, used to prove the coverage check reacts to what is on disk rather
 * than to a hardcoded list. Mirrors corvidae's own four workspace directories.
 */
async function fixtureWorkspaceTree(
  workspaces: Record<string, string>,
): Promise<{ root: string; [Symbol.asyncDispose](): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-package-map-'));
  for (const directory of ['applications', 'components', 'packages', 'internal']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  for (const [path, name] of Object.entries(workspaces)) {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, 'package.json'), JSON.stringify({ name, private: true }));
  }
  return {
    root,
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('mirror package map', () => {
  test('parses and assigns exactly one disposition to every workspace', async () => {
    const map = await loadPackageMap();
    const entries = Object.entries(map.workspaces);

    const unscopedWorkspaceNames = new Set(['armorer', 'conversationalist']);
    expect(entries.length).toBeGreaterThan(0);
    for (const [workspace, entry] of entries) {
      if (!unscopedWorkspaceNames.has(workspace)) {
        expect(
          workspace,
          'Workspace keys are @lostgradient/* names, except armorer and conversationalist',
        ).toStartWith('@lostgradient/');
      }
      expect(['publish-as', 'private-workspace', 'exclude'], `${workspace} disposition`).toContain(
        entry.disposition,
      );
      if (entry.disposition === 'publish-as') {
        expect(entry.name.length, `${workspace} publishes under a name`).toBeGreaterThan(0);
      } else {
        expect(entry, `${workspace} carries no npm name`).not.toHaveProperty('name');
      }
    }
  });

  /**
   * COR-1285 deleted the source-side rewrite layer that used to translate a corvidae-only name
   * into whatever this map published it under. Deleting a translation is only sound while there is
   * nothing left to translate, so this is the ruling that makes it sound: for every scoped
   * workspace, `name` is not a second name assigned to the workspace — it is the workspace's own
   * key, restated, because `publishableNames()` and `assertPublishedNamesUnique` both read it as
   * the workspace's public identity and neither has ever treated it as an alias.
   */
  test('a scoped workspace’s published name is its own key, not a second name assigned to it', async () => {
    const map = await loadPackageMap();
    for (const [workspace, entry] of Object.entries(map.workspaces)) {
      if (entry.disposition !== 'publish-as' || !workspace.startsWith('@lostgradient/')) continue;
      expect(entry.name, `${workspace} publishes under its own name`).toBe(workspace);
    }
  });

  test('covers the workspaces actually on disk with no extras and no omissions', async () => {
    const report = await coverageReport(repositoryRoot);

    expect(report.missing, 'Workspaces on disk with no disposition').toEqual([]);
    expect(report.extra, 'Dispositions naming a workspace that no longer exists').toEqual([]);
  });

  test('fails when a workspace is added without a mapping', async () => {
    const onDisk = await discoverWorkspaceNames(repositoryRoot);
    await using fixture = await fixtureWorkspaceTree({
      ...Object.fromEntries(
        onDisk.map((name, index) => [`packages/existing-${index}`, name] as const),
      ),
      'packages/newly-added': '@lostgradient/newly-added',
    });

    const report = await coverageReport(fixture.root);

    expect(report.missing, 'An unmapped workspace is reported by name').toEqual([
      '@lostgradient/newly-added',
    ]);
    expect(report.extra).toEqual([]);
  });

  test('reports a mapped workspace that has been removed from disk', async () => {
    await using fixture = await fixtureWorkspaceTree({
      'packages/weft': '@lostgradient/weft',
    });

    const report = await coverageReport(fixture.root);

    expect(report.extra, 'Every other mapped workspace is reported as extra').toContain(
      '@lostgradient/cinder',
    );
    expect(report.missing).toEqual([]);
  });

  test('hard-errors on an unmapped workspace rather than skipping it', async () => {
    expect(await throwingRejectionOf(dispositionFor('@lostgradient/not-a-workspace'))).toThrow(
      PackageMapError,
    );
    expect(await throwingRejectionOf(dispositionFor('@lostgradient/not-a-workspace'))).toThrow(
      /@lostgradient\/not-a-workspace has no disposition/,
    );
  });

  test('resolves a known workspace to its settled published name', async () => {
    const armorer = await dispositionFor('armorer');

    expect(armorer.disposition).toBe('publish-as');
    if (armorer.disposition !== 'publish-as') throw new Error('unreachable');
    expect(armorer.name, 'armorer keeps its unscoped name').toBe('armorer');
  });

  test('excludes the playground application so the transform never emits it into the cinder target', async () => {
    const playground = await dispositionFor('@lostgradient/playground');
    const { publishedOnly } = await loadPackageMap();

    // The application is private to corvidae, which hosts cinder.website from it (COR-1201).
    // `private-workspace` would emit it into the public cinder target, where `target-owned.json`
    // retires the former `packages/playground` copy.
    expect(playground.disposition).toBe('exclude');
    expect(await publishableNames()).not.toContain('@lostgradient/playground');
    // The playground is a workspace now, so it must not also be ruled on as a published-only name.
    expect(publishedOnly.entries.map((entry) => entry.name)).not.toContain('@cinder/playground');
  });

  test('publishes every package inside a published package runtime closure', async () => {
    const names = await publishableNames();

    // armorer, conversationalist, and operative publish, so everything reachable from their
    // runtime dependencies must publish too or those tarballs are uninstallable.
    for (const required of [
      '@lostgradient/cryptography',
      '@lostgradient/embeddings',
      '@lostgradient/tool-protocol',
      '@lostgradient/lifecycle',
    ]) {
      expect(names, `${required} is forced by the runtime closure`).toContain(required);
    }
  });

  test('never publishes two workspaces under one npm name', async () => {
    const names = await publishableNames();

    expect(names.length, 'Published names are unique').toBe(new Set(names).size);
  });

  test('rules on every published-only name', async () => {
    const { publishedOnly } = await loadPackageMap();

    for (const entry of publishedOnly.entries) {
      expect(['keep', 'deprecate', 'orphan-untouched'], `${entry.name} disposition`).toContain(
        entry.disposition,
      );
      expect(entry.reason.length, `${entry.name} records why`).toBeGreaterThan(0);
    }

    const names = publishedOnly.entries.map((entry) => entry.name);
    expect(names, 'The one public orphan is ruled on').toContain('@lostgradient/cinder-mcp');
    expect(names.length, 'Published-only names are unique').toBe(new Set(names).size);
  });

  test('deprecating a published name is never the silent default', async () => {
    const { publishedOnly } = await loadPackageMap();

    // A deprecation is permanently public and needs the repository owner's approval, so it must
    // not appear here without a deliberate edit. This test is the tripwire for that.
    const deprecated = publishedOnly.entries.filter((entry) => entry.disposition === 'deprecate');

    expect(
      deprecated.map((entry) => entry.name),
      'No name is deprecated yet',
    ).toEqual([]);
  });
});
