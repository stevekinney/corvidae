import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { corePackagePath, cssImportOrder } from './css-import-order.ts';
import { barrelDirectories, ROOT_EXPORT_ORDER_PATH } from './generate-root-registries.ts';

const packageRoot = join(import.meta.dir, '../../../components/core');
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
    // Read through the packages the split extracted, under the paths core gave their stylesheets.
    const current = cssImportOrder(join(packageRoot, 'src', 'index.ts')).map((path) =>
      corePackagePath(path, packageRoot),
    );
    const recordedSet = new Set(recorded);
    expect(current.filter((path) => recordedSet.has(path))).toEqual(recorded);
  });

  test('evaluates the recorded barrels in the recorded order', () => {
    const recorded: string[] = JSON.parse(readFileSync(ROOT_EXPORT_ORDER_PATH, 'utf8'));
    const index = readFileSync(join(packageRoot, 'src', 'index.ts'), 'utf8');
    const evaluated = [
      ...new Set(
        [
          // A component's barrel, in core or (P-COR-101) in the family that holds it.
          ...index.matchAll(
            /^export \{[^}]*\} from '(?:\.\/|@lostgradient\/[^/']+\/)components\/([^/]+)\/index\.ts';$/gm,
          ),
        ].map((match) => match[1] ?? ''),
      ),
    ];
    // The pattern must still find the barrels, wherever they are, or the order test passes on none.
    expect(evaluated.length).toBeGreaterThan(200);
    const recordedSet = new Set(recorded);
    expect(evaluated.filter((name) => recordedSet.has(name))).toEqual(
      recorded.filter((name) => evaluated.includes(name)),
    );
  });
});

describe('cssImportOrder through an extracted package', () => {
  test('follows a followed package to its stylesheets, and stops at any other package', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'css-order-package-')));
    roots.push(root);
    const family = join(root, 'node_modules', '@lostgradient', 'family');
    mkdirSync(join(family, 'src'), { recursive: true });
    writeFileSync(
      join(family, 'package.json'),
      JSON.stringify({
        name: '@lostgradient/family',
        exports: { '.': './src/index.ts', './part.css': './src/part.css' },
      }),
    );
    writeFileSync(
      join(family, 'src', 'index.ts'),
      "import './family.css';\nimport '@lostgradient/family/part.css';\nexport const x = 1;\n",
    );
    writeFileSync(join(family, 'src', 'family.css'), '');
    writeFileSync(join(family, 'src', 'part.css'), '');
    writeFileSync(join(root, 'own.css'), '');
    writeFileSync(
      join(root, 'entry.ts'),
      "import './own.css';\nexport { x } from '@lostgradient/family';\n",
    );
    const entry = join(root, 'entry.ts');
    expect(cssImportOrder(entry, new Set(['@lostgradient/family']))).toEqual([
      join(root, 'own.css'),
      join(family, 'src', 'family.css'),
      join(family, 'src', 'part.css'),
    ]);
    expect(cssImportOrder(entry, new Set())).toEqual([join(root, 'own.css')]);
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
