/**
 * Importing `@lostgradient/bungalow` loads no FFI: `bun:ffi` is imported only dynamically, when the
 * default `flock(2)` lock is first acquired, so a host with its own lock, a remote home, or another
 * runtime can import the package without it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const SOURCE = dirname(new URL(import.meta.url).pathname);
const transpiler = new Bun.Transpiler({ loader: 'ts' });

/** Every module specifier `code` imports without `import(...)`: imports and re-exports alike. */
function staticImports(code: string): string[] {
  return transpiler
    .scanImports(code)
    .filter(({ kind }) => kind !== 'dynamic-import')
    .map(({ path }) => path);
}

/** The package's own source modules: everything in `src` but tests and their support files. */
function sourceModules(): string[] {
  return readdirSync(SOURCE)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !name.endsWith('.test.ts') && !name.endsWith('.test-support.ts'))
    .toSorted();
}

describe('bun:ffi', () => {
  test('the scan sees a static import and a re-export, and tells a dynamic import apart', () => {
    expect(staticImports("import { dlopen } from 'bun:ffi';")).toEqual(['bun:ffi']);
    expect(staticImports("export { dlopen } from 'bun:ffi';")).toEqual(['bun:ffi']);
    expect(staticImports("const ffi = await import('bun:ffi');")).toEqual([]);
  });

  test('no source module imports bun:ffi statically', () => {
    const modules = sourceModules();
    expect(modules).toContain('index.ts');
    expect(modules).toContain('lock.ts');
    const offenders = modules.filter((name) =>
      staticImports(readFileSync(join(SOURCE, name), 'utf8')).includes('bun:ffi'),
    );
    expect(offenders).toEqual([]);
  });

  test('nothing the index reaches through static imports is bun:ffi', () => {
    const reached = new Set<string>();
    const pending = ['index.ts'];
    for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
      if (reached.has(name)) continue;
      reached.add(name);
      for (const specifier of staticImports(readFileSync(join(SOURCE, name), 'utf8'))) {
        expect(specifier).not.toBe('bun:ffi');
        if (specifier.startsWith('./')) pending.push(specifier.slice(2));
      }
    }
    // The lock module is reached, and loads the FFI only on demand.
    expect(reached.has('lock.ts')).toBe(true);
    expect(
      transpiler
        .scanImports(readFileSync(join(SOURCE, 'lock.ts'), 'utf8'))
        .filter(({ path }) => path === 'bun:ffi'),
    ).toEqual([{ kind: 'dynamic-import', path: 'bun:ffi' }]);
  });
});
