/**
 * A Playwright specification (`*.spec.ts`) calls `test.beforeAll()` and its siblings when it loads,
 * and Playwright throws "did not expect test.beforeAll() to be called here" anywhere but its own
 * runner. So no Bun unit test may load one, by `import`, `export … from` or `import()`, directly or
 * through a module it imports (COR-2643). A targeted run named seven `tests/panels/*.spec.ts` files
 * as unit test files and each one failed that way; `scripts/chef/verification-plan.ts` no longer
 * selects a specification, and this guard keeps a unit test from importing one.
 */
import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const WORKSPACE = join(import.meta.dir, '..');
const SPECIFICATION = /\.spec\.[cm]?[jt]sx?$/;
const transpilers = {
  '.ts': new Bun.Transpiler({ loader: 'ts' }),
  '.tsx': new Bun.Transpiler({ loader: 'tsx' }),
};

/**
 * The workspace files a module loads, as the paths its relative specifiers resolve to. Only
 * TypeScript modules are read: a stylesheet, a Svelte component or a data file is a leaf, and
 * `scanImports` skips an `import type`, which loads nothing.
 */
function relativeImportsOf(file: string): string[] {
  if (!/\.tsx?$/.test(file)) return [];
  const transpiler = file.endsWith('.tsx') ? transpilers['.tsx'] : transpilers['.ts'];
  // `scanImports` does not take a hashbang line.
  const source = readFileSync(file, 'utf8').replace(/^#!.*/, '');
  const resolved: string[] = [];
  for (const { path } of transpiler.scanImports(source)) {
    if (!path.startsWith('.')) continue;
    try {
      resolved.push(Bun.resolveSync(path, dirname(file)));
    } catch {
      // A specifier that resolves to nothing is the type-checker's finding, not this guard's.
    }
  }
  return resolved;
}

/**
 * The specifications `entry` loads, each with the chain of modules that reaches it. `importsOf` is
 * the module graph; the walk visits every module once.
 */
function specificationsReachedFrom(
  entry: string,
  importsOf: (file: string) => readonly string[],
): string[] {
  const reached: string[] = [];
  const chains = new Map<string, string[]>([[entry, [entry]]]);
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    const chain = chains.get(file) ?? [file];
    for (const next of importsOf(file)) {
      if (chains.has(next)) continue;
      chains.set(next, [...chain, next]);
      if (SPECIFICATION.test(next)) reached.push([...chain, next].join(' -> '));
      else pending.push(next);
    }
  }
  return reached;
}

describe('the guard', () => {
  test('names a specification a unit test loads, directly and through another module', () => {
    const graph: Record<string, string[]> = {
      '/w/a.test.ts': ['/w/support.ts', '/w/direct.spec.ts'],
      '/w/support.ts': ['/w/helper.ts'],
      '/w/helper.ts': ['/w/deep.spec.ts', '/w/support.ts'],
    };
    expect(specificationsReachedFrom('/w/a.test.ts', (file) => graph[file] ?? [])).toEqual([
      '/w/a.test.ts -> /w/direct.spec.ts',
      '/w/a.test.ts -> /w/support.ts -> /w/helper.ts -> /w/deep.spec.ts',
    ]);
  });

  test('finds nothing in a graph that holds no specification', () => {
    const graph: Record<string, string[]> = { '/w/a.test.ts': ['/w/b.ts'], '/w/b.ts': [] };
    expect(specificationsReachedFrom('/w/a.test.ts', (file) => graph[file] ?? [])).toEqual([]);
  });

  test('reads the specifiers of a module, and not a type-only import', () => {
    const found = new Set(relativeImportsOf(join(import.meta.dir, 'design-review-shards.test.ts')));
    expect(found.has(join(import.meta.dir, 'design-review-capture.ts'))).toBe(true);
    expect(found.has(join(import.meta.dir, 'design-review-shards.ts'))).toBe(true);
    const typeOnly = new Bun.Transpiler({ loader: 'ts' }).scanImports(
      "import type { A } from './a.spec.ts'; import { b } from './b.ts';",
    );
    expect(typeOnly.map(({ path }) => path)).toEqual(['./b.ts']);
  });
});

describe('the Bun unit tests of Interborough', () => {
  const unitTests = [
    ...new Glob('{src,scripts,tests,fixtures}/**/*.test.{ts,tsx}').scanSync({ cwd: WORKSPACE }),
  ]
    .filter((path) => !path.includes('node_modules/'))
    .toSorted();

  test('are found, so the guard below is not vacuous', () => {
    expect(unitTests.length).toBeGreaterThan(100);
    expect(unitTests).toContain('scripts/design-review-render-boards.test.ts');
  });

  test('import no Playwright specification, directly or through another module', () => {
    const cache = new Map<string, readonly string[]>();
    const importsOf = (file: string): readonly string[] => {
      const known = cache.get(file);
      if (known !== undefined) return known;
      const imports = relativeImportsOf(file).filter(
        (path) => path.startsWith(WORKSPACE) && !path.includes('node_modules/'),
      );
      cache.set(file, imports);
      return imports;
    };
    const offenders = unitTests.flatMap((path) =>
      specificationsReachedFrom(join(WORKSPACE, path), importsOf).map((chain) =>
        chain
          .split(' -> ')
          .map((file) => relative(WORKSPACE, file))
          .join(' -> '),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
