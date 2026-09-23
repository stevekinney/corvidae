import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Glob } from 'bun';

import { loadPackageMap } from './package-map.ts';

/**
 * No published package augments one of its own modules by relative path.
 *
 * `declare module './history' { interface Conversation extends … }` merged fine against
 * conversationalist's source and vanished from its published declarations: the bundler moved the
 * class into a shared chunk under a local alias, `./history` became a file that only re-exports
 * it, and the augmentation merged into nothing, so `Conversation` shipped without a single action
 * method. Corvidae type-checks source and never bundles declarations, so nothing here could see it
 * until the agent-bureau mirror built conversationalist and type-checked operative against it.
 * Declare the merged interface in the class's own module instead.
 *
 * Augmenting another package (`declare module 'some-package'`) is a different mechanism and stays
 * allowed, and so does a type test (`*.test-d.ts`) augmenting the module it exercises, since no
 * test file reaches a package's declarations.
 */

const corvidaeRoot = join(import.meta.dir, '..', '..');
const relativeAugmentation = /^\s*declare\s+module\s+['"]\.{1,2}\//m;
/** Type tests augment the module under test on purpose and never reach a package's declarations. */
const testFile = /\.test(-d)?\.[cm]?tsx?$/;

function workspaceDirectories(): Map<string, string> {
  const directories = new Map<string, string>();
  for (const parent of ['packages', 'components']) {
    for (const child of readdirSync(join(corvidaeRoot, parent))) {
      const manifestPath = join(corvidaeRoot, parent, child, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string };
      if (manifest.name) directories.set(manifest.name, join(parent, child));
    }
  }
  return directories;
}

describe('published source', () => {
  test('augments none of its own modules by relative path', async () => {
    const packageMap = await loadPackageMap();
    const directories = workspaceDirectories();
    const offenders: string[] = [];
    let scanned = 0;
    for (const [workspace, entry] of Object.entries(packageMap.workspaces)) {
      if (entry.disposition !== 'publish-as') continue;
      const directory = directories.get(workspace);
      if (!directory)
        throw new Error(`${workspace} is published but no workspace carries that name`);
      const source = join(corvidaeRoot, directory, 'src');
      for await (const path of new Glob('**/*.{ts,tsx,mts,cts}').scan({ cwd: source })) {
        if (testFile.test(path)) continue;
        scanned++;
        if (relativeAugmentation.test(readFileSync(join(source, path), 'utf8'))) {
          offenders.push(`${directory}/src/${path}`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
