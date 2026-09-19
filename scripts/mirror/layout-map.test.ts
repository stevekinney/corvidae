import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DeferredWorkspaceError,
  layoutCoverage,
  layoutFor,
  LayoutMapError,
  loadLayoutMap,
  targetDirectoryFor,
} from './layout-map.ts';
import { applyPreservedFields } from './manifests.ts';
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
    expect(await targetDirectoryFor('@corvidae/cinder')).toBe('packages/components');
    expect(await targetDirectoryFor('@corvidae/chat')).toBe('packages/chat');
    expect(await targetDirectoryFor('@corvidae/editor')).toBe('packages/editor');
    expect(await targetDirectoryFor('@corvidae/weft-ui')).toBe('packages/weft-ui');
    expect(await targetDirectoryFor('@corvidae/weft')).toBe('packages/weft');
  });

  test('a workspace with no entry stops the transform by name', async () => {
    await expect(layoutFor('@corvidae/nonexistent')).rejects.toThrow(LayoutMapError);
  });
});

describe('the deferred workspace', () => {
  test('refuses to give a directory and names the issue that must rule on it', async () => {
    const layout = await layoutFor('@corvidae/chat-room');
    expect(layout.disposition).toBe('deferred');
    await expect(targetDirectoryFor('@corvidae/chat-room')).rejects.toThrow(DeferredWorkspaceError);
    try {
      await targetDirectoryFor('@corvidae/chat-room');
    } catch (error) {
      expect((error as Error).message).toContain('@corvidae/chat-room');
      expect((error as Error).message).toContain('COR-1221');
    }
  });
});

describe('the table itself', () => {
  test('two workspaces in one target directory is a load failure, not an overwrite', async () => {
    await withTable(
      {
        documentation: 'A fixture table.',
        workspaces: {
          '@corvidae/one': {
            disposition: 'emit',
            corvidaeDirectory: 'packages/one',
            targetDirectory: 'packages/shared',
            reason: 'Fixture.',
          },
          '@corvidae/two': {
            disposition: 'emit',
            corvidaeDirectory: 'packages/two',
            targetDirectory: 'packages/shared',
            reason: 'Fixture.',
          },
        },
        openQuestions: [],
      },
      async (path) => {
        await expect(loadLayoutMap(path)).rejects.toThrow(LayoutMapError);
      },
    );
  });

  test('a deferred entry without an issue is malformed', async () => {
    await withTable(
      {
        documentation: 'A fixture table.',
        workspaces: {
          '@corvidae/one': {
            disposition: 'deferred',
            corvidaeDirectory: 'packages/one',
            reason: 'Fixture.',
          },
        },
        openQuestions: [],
      },
      async (path) => {
        await expect(loadLayoutMap(path)).rejects.toThrow(LayoutMapError);
      },
    );
  });
});

describe('the field the remap makes reachable', () => {
  /**
   * `target-owned.json` carries a `fields` entry keyed to `packages/components/package.json`,
   * preserving cinder's `"prepare": "cd ../.. && husky"`. That key could never match while the
   * transform emitted `@corvidae/cinder` at corvidae's own `components/cinder`, so the entry was
   * enumerated but inert. This is the pairing: the table sends the workspace to the path the
   * entry names, and the entry then fires.
   */
  test('cinder’s husky prepare survives a rewrite of packages/components/package.json', async () => {
    const policy = await loadTargetOwnedPolicy();
    const file = `${await targetDirectoryFor('@corvidae/cinder')}/package.json`;
    expect(file).toBe('packages/components/package.json');
    expect(
      policy.fields.entries.some((entry) => entry.file === file),
      'the enumeration still names this file',
    ).toBe(true);

    const emitted: Record<string, unknown> = { name: '@lostgradient/cinder', scripts: {} };
    applyPreservedFields(policy, 'cinder', file, emitted, {
      scripts: { prepare: 'cd ../.. && husky', build: 'bun run scripts/build.ts' },
    });
    expect(emitted['scripts']).toEqual({ prepare: 'cd ../.. && husky' });
  });
});
