import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { readLockfile, staleInstalls } from './check-installed-dependencies';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const lockfile = (
  workspaces: Record<string, Record<string, string>>,
  packages: Record<string, string>,
) =>
  // bun.lock is JSONC, so the trailing commas here must parse.
  `{
  "lockfileVersion": 1,
  "workspaces": {
${Object.entries(workspaces)
  .map(
    ([path, dependencies]) =>
      `    "${path}": { "name": "${path || 'root'}", "dependencies": ${JSON.stringify(dependencies)}, },`,
  )
  .join('\n')}
  },
  "packages": {
${Object.entries(packages)
  .map(([key, resolution]) => `    "${key}": ["${resolution}", "", {}, "sha512-x"],`)
  .join('\n')}
  },
}`;

/** A repository whose store holds the given `name@version` folders, with nothing linked yet. */
function repository(store: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'installed-dependencies-'));
  directories.push(root);
  for (const entry of store) {
    const at = entry.lastIndexOf('@');
    const name = entry.slice(0, at);
    const folder = join(
      root,
      'node_modules',
      '.bun',
      entry.replace('/', '+'),
      'node_modules',
      name,
    );
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, 'package.json'),
      JSON.stringify({ name, version: entry.slice(at + 1) }),
    );
  }
  return root;
}

/** Link `name` in a workspace's node_modules to a store folder, the way Bun's isolated linker does. */
function link(root: string, workspace: string, name: string, storeEntry: string): void {
  const linkPath = join(root, workspace, 'node_modules', name);
  mkdirSync(dirname(linkPath), { recursive: true });
  const target = join(
    root,
    'node_modules',
    '.bun',
    storeEntry.replace('/', '+'),
    'node_modules',
    name,
  );
  symlinkSync(target, linkPath);
}

describe('installed dependencies against bun.lock', () => {
  test('reports a linked package whose installed version the lockfile no longer resolves', () => {
    const root = repository(['svelte@5.57.0', 'svelte@5.57.1']);
    link(root, '', 'svelte', 'svelte@5.57.0');
    link(root, 'components/cinder', 'svelte', 'svelte@5.57.1');
    const lock = readLockfile(
      lockfile(
        { '': { svelte: 'catalog:' }, 'components/cinder': { svelte: 'catalog:' } },
        { svelte: 'svelte@5.57.1' },
      ),
    );
    expect(staleInstalls(root, lock)).toEqual([
      { workspace: '.', name: 'svelte', problem: 'installed 5.57.0, but bun.lock resolves 5.57.1' },
    ]);
  });

  test('accepts an install that matches, including a version resolved only for one workspace', () => {
    const root = repository(['svelte-check@4.7.6', 'svelte-check@4.7.8', '@scope/tool@1.0.0']);
    link(root, '', 'svelte-check', 'svelte-check@4.7.6');
    link(root, 'packages/velveteen', 'svelte-check', 'svelte-check@4.7.8');
    link(root, '', '@scope/tool', '@scope/tool@1.0.0');
    const lock = readLockfile(
      lockfile(
        {
          '': { 'svelte-check': 'catalog:', '@scope/tool': '1.0.0' },
          'packages/velveteen': { 'svelte-check': '4.7.8' },
        },
        {
          'svelte-check': 'svelte-check@4.7.6',
          '@lostgradient/velveteen/svelte-check': 'svelte-check@4.7.8',
          '@scope/tool': '@scope/tool@1.0.0',
        },
      ),
    );
    expect(staleInstalls(root, lock)).toEqual([]);
  });

  test('reports a declared dependency that is not installed and a link whose target is gone', () => {
    const root = repository(['zod@4.0.0']);
    link(root, '', 'zod', 'zod@4.0.0');
    link(root, '', 'luxon', 'luxon@3.7.2');
    const lock = readLockfile(
      lockfile(
        { '': { zod: '4.0.0', luxon: '3.7.2', 'cron-parser': '5.10.1' } },
        { zod: 'zod@4.0.0', luxon: 'luxon@3.7.2', 'cron-parser': 'cron-parser@5.10.1' },
      ),
    );
    expect(staleInstalls(root, lock)).toEqual([
      { workspace: '.', name: 'cron-parser', problem: 'declared in bun.lock but not installed' },
      { workspace: '.', name: 'luxon', problem: 'linked to a store folder that no longer exists' },
    ]);
  });

  test('ignores workspace links and tool folders and reports packages removed from bun.lock', () => {
    const root = repository(['left-pad@1.0.0']);
    mkdirSync(join(root, 'packages', 'shared'), { recursive: true });
    mkdirSync(join(root, 'node_modules', '@lostgradient'), { recursive: true });
    symlinkSync(
      join(root, 'packages', 'shared'),
      join(root, 'node_modules', '@lostgradient', 'shared'),
    );
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    link(root, '', 'left-pad', 'left-pad@1.0.0');
    link(root, '', 'removed', 'removed@1.0.0');
    const lock = readLockfile(
      lockfile(
        { '': { '@lostgradient/shared': 'workspace:*' } },
        { '@lostgradient/shared': '@lostgradient/shared@workspace:packages/shared' },
      ),
    );
    expect(staleInstalls(root, lock)).toEqual([
      { workspace: '.', name: 'left-pad', problem: 'installed but absent from bun.lock' },
      {
        workspace: '.',
        name: 'removed',
        problem: 'linked to a store folder that no longer exists',
      },
    ]);
  });

  test("reads the repository's own lockfile", async () => {
    const text = await Bun.file(new URL('../bun.lock', import.meta.url)).text();
    const lock = readLockfile(text);
    expect(lock.workspaces).toContain('');
    expect(lock.versions.get('svelte')?.size).toBeGreaterThan(0);
  });
});
