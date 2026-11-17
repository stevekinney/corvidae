import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { planMoves, rewritePaths } from './rename-cinder-to-core.ts';

const OLD = ['components', 'cinder'].join('/');
const NEW = ['components', 'core'].join('/');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rename-cinder-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe('rewritePaths', () => {
  test('rewrites the repository path, its separate segments, and a climb to Cinder', () => {
    expect(rewritePaths(`See \`${OLD}/src/styles/all.css\` and ${OLD}.`)).toBe(
      `See \`${NEW}/src/styles/all.css\` and ${NEW}.`,
    );
    expect(rewritePaths("join(root, 'components', 'cinder', 'src')")).toBe(
      "join(root, 'components', 'core', 'src')",
    );
    expect(rewritePaths('[Cinder](../cinder/README.md) and ../../../cinder/src/styles/x.css')).toBe(
      '[Cinder](../core/README.md) and ../../../core/src/styles/x.css',
    );
    expect(rewritePaths(String.raw`/^components\/cinder\/src\/components\//`)).toBe(
      String.raw`/^components\/core\/src\/components\//`,
    );
  });

  test('leaves the package name, node_modules paths and lookalikes alone', () => {
    const untouched = [
      "import { Button } from '@lostgradient/cinder';",
      "join(runtime, '@lostgradient', 'cinder', 'src', 'panel')",
      `${OLD}-legacy/readme.md`,
      'packages/components/src/components/button',
      './cinder/src/index.ts',
    ].join('\n');
    expect(rewritePaths(untouched)).toBe(untouched);
  });
});

describe('planMoves', () => {
  test('moves the whole directory when nothing is at the new path', () => {
    const root = tree({ [`${OLD}/package.json`]: '{}' });
    expect(planMoves(root, [`${OLD}/package.json`]).moves).toEqual([[OLD, NEW]]);
  });

  test('after the move, moves each file a merge left at the old path', () => {
    const root = tree({
      [`${NEW}/package.json`]: '{}',
      [`${OLD}/src/new.ts`]: 'new',
      [`${OLD}/src/same.ts`]: 'same',
      [`${NEW}/src/same.ts`]: 'same',
      [`${OLD}/src/other.ts`]: 'old',
      [`${NEW}/src/other.ts`]: 'new',
    });
    const plan = planMoves(root, [
      `${NEW}/package.json`,
      `${OLD}/src/new.ts`,
      `${OLD}/src/same.ts`,
      `${NEW}/src/same.ts`,
      `${OLD}/src/other.ts`,
      `${NEW}/src/other.ts`,
    ]);
    expect(plan.moves).toEqual([[`${OLD}/src/new.ts`, `${NEW}/src/new.ts`]]);
    expect(plan.duplicates).toEqual([`${OLD}/src/same.ts`]);
    expect(plan.problems).toEqual([
      `${OLD}/src/other.ts: ${NEW}/src/other.ts already exists with different content`,
    ]);
  });

  test('plans nothing once the old directory is gone', () => {
    const root = tree({ [`${NEW}/package.json`]: '{}' });
    expect(planMoves(root, [`${NEW}/package.json`])).toEqual({
      moves: [],
      duplicates: [],
      problems: [],
    });
  });
});
