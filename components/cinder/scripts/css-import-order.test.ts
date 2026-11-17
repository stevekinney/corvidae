import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { cssImportOrder } from './css-import-order.ts';
import { barrelDirectories, ROOT_EXPORT_ORDER_PATH } from './generate-root-registries.ts';

const packageRoot = join(import.meta.dir, '..');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function lines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

describe('the root barrel’s CSS evaluation order', () => {
  // `fixtures/root-css-order.txt` is the order `main`'s hand-written `src/index.ts` evaluated the
  // stylesheets in before COR-2393 generated it. Every application that imports the root gets the
  // component rules of `@layer cinder.components` in this order, so the generated barrel keeps it:
  // a stylesheet added since may appear anywhere, but the recorded ones never move.
  test('keeps every recorded stylesheet, in the recorded order', () => {
    const recorded = lines(join(import.meta.dir, 'fixtures', 'root-css-order.txt'));
    const current = cssImportOrder(join(packageRoot, 'src', 'index.ts')).map((path) =>
      relative(packageRoot, path),
    );
    const recordedSet = new Set(recorded);
    expect(current.filter((path) => recordedSet.has(path))).toEqual(recorded);
  });

  test('evaluates the recorded barrels in the recorded order', () => {
    const recorded: string[] = JSON.parse(readFileSync(ROOT_EXPORT_ORDER_PATH, 'utf8'));
    const index = readFileSync(join(packageRoot, 'src', 'index.ts'), 'utf8');
    const evaluated = [
      ...new Set(
        [...index.matchAll(/^export \{[^}]*\} from '\.\/components\/([^/]+)\/index\.ts';$/gm)].map(
          (match) => match[1] ?? '',
        ),
      ),
    ];
    const recordedSet = new Set(recorded);
    expect(evaluated.filter((name) => recordedSet.has(name))).toEqual(
      recorded.filter((name) => evaluated.includes(name)),
    );
  });
});

describe('barrelDirectories', () => {
  test('places a component the recorded order lacks after its alphabetical predecessor', () => {
    const root = mkdtempSync(join(tmpdir(), 'barrel-order-'));
    roots.push(root);
    for (const name of ['alpha', 'beta', 'gamma', 'delta', 'aardvark']) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, 'index.ts'), 'export default 1;\n');
    }
    // `aardvark` has no predecessor and goes first; `beta` follows `alpha`, and `delta` follows
    // `beta`. The recorded `gamma` before `alpha` stands, and the removed entry is ignored.
    expect(barrelDirectories(root, ['gamma', 'alpha', 'removed'])).toEqual([
      'aardvark',
      'gamma',
      'alpha',
      'beta',
      'delta',
    ]);
  });
});
