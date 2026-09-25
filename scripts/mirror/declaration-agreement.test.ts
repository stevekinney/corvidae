import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkDeclarationAgreement,
  describeDeclarationFinding,
  type DeclarationAgreement,
} from './declaration-agreement.ts';
import type { SurfaceExportsMap } from './package-surface.ts';

/**
 * A throwaway package holding `files`, checked against `exports`. It carries no `tsconfig.json`,
 * so the check's own fallback compiler options apply, and it lives outside the repository so no
 * workspace configuration reaches it.
 */
async function checkFixture(
  files: Record<string, string>,
  exports: SurfaceExportsMap,
): Promise<DeclarationAgreement> {
  const packageRoot = await mkdtemp(join(tmpdir(), 'corvidae-declaration-agreement-'));
  try {
    for (const [path, contents] of Object.entries(files)) {
      await Bun.write(join(packageRoot, path), contents);
    }
    return checkDeclarationAgreement({
      publicName: '@fixture/package',
      exports,
      sourceRoot: 'src',
      packageRoot,
    });
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
}

/** Weft's `./storage/sqlite` shape: one authored declaration, two runtime modules. */
const sqliteShape: SurfaceExportsMap = {
  './storage': {
    types: './dist/storage.d.ts',
    bun: './dist/bun-storage.js',
    node: './dist/node-storage.js',
    default: './dist/node-storage.js',
  },
};

const declaration = `import type { BunStorage } from './bun-storage.ts';
export type StorageInstance = BunStorage;
export interface StorageOptions { path: string }
export declare const Storage: { new (path?: string): StorageInstance };
export declare function openStorage(path: string): StorageInstance;
`;

describe('checkDeclarationAgreement', () => {
  test('names each value a declaration exports that a runtime module lacks', async () => {
    const result = await checkFixture(
      {
        'src/storage.ts': declaration,
        'src/bun-storage.ts': `export class BunStorage {}
export { BunStorage as Storage };
export function openStorage() { return new BunStorage(); }
`,
        // The consolidation defect: the runtime class is here, the alias the declaration promises
        // is not, and neither is the function.
        'src/node-storage.ts': 'export class NodeStorage {}\n',
      },
      sqliteShape,
    );
    expect(result.examined).toEqual(['./storage']);
    expect(result.findings).toEqual([
      {
        publicName: '@fixture/package',
        subpath: './storage',
        declaration: 'src/storage.ts',
        runtime: 'src/node-storage.ts',
        missing: ['Storage', 'openStorage'],
      },
    ]);
    expect(describeDeclarationFinding(result.findings[0]!)).toBe(
      '@fixture/package ./storage: src/storage.ts declares Storage, openStorage, which src/node-storage.ts does not export',
    );
  });

  test('passes when every runtime module exports the declared values, aliased or re-exported', async () => {
    const result = await checkFixture(
      {
        'src/storage.ts': declaration,
        'src/bun-storage.ts': `export class BunStorage {}
export { BunStorage as Storage };
export function openStorage() { return new BunStorage(); }
`,
        'src/node-implementation.ts': `export class NodeStorage {}
export const openStorage = () => new NodeStorage();
`,
        'src/node-storage.ts': `export * from './node-implementation.ts';
export { NodeStorage as Storage } from './node-implementation.ts';
`,
      },
      sqliteShape,
    );
    expect(result.examined).toEqual(['./storage']);
    expect(result.findings).toEqual([]);
  });

  test('type-only exports never require a runtime counterpart', async () => {
    const result = await checkFixture(
      {
        'src/types.ts': `export class Reached {}
export const reachedValue = 1;
export interface ReachedShape { value: number }
`,
        'src/storage.ts': `import type { reachedValue } from './types.ts';
export type Alias = string;
export interface Options { path: string }
export type { Reached as Renamed } from './types.ts';
export { type ReachedShape } from './types.ts';
export type * from './types.ts';
export { reachedValue };
export declare namespace TypesOnly { type Inner = number }
`,
        'src/bun-storage.ts': 'export {};\n',
        'src/node-storage.ts': 'export {};\n',
      },
      sqliteShape,
    );
    // Examined, so the pass is a judgement about the declaration rather than a skipped entry.
    expect(result.examined).toEqual(['./storage']);
    expect(result.findings).toEqual([]);
  });

  test('a value reached through a type-only re-export in the runtime module does not count', async () => {
    const result = await checkFixture(
      {
        'src/storage.ts': 'export declare const Storage: unknown;\n',
        'src/implementation.ts': 'export class Storage {}\n',
        'src/bun-storage.ts': "export type * from './implementation.ts';\n",
        'src/node-storage.ts': "export { Storage } from './implementation.ts';\n",
      },
      sqliteShape,
    );
    expect(result.findings.map((finding) => [finding.runtime, finding.missing])).toEqual([
      ['src/bun-storage.ts', ['Storage']],
    ]);
  });

  test('a declaration promising values over a stylesheet is a finding, an empty stub is not', async () => {
    const stylesheet = {
      './styles': { types: './src/styles.css.d.ts', default: './src/styles.css' },
    };
    const stub = await checkFixture(
      { 'src/styles.css.d.ts': 'export {};\n', 'src/styles.css': ':root {}\n' },
      stylesheet,
    );
    expect(stub.examined).toEqual(['./styles']);
    expect(stub.findings).toEqual([]);

    const promising = await checkFixture(
      {
        'src/styles.css.d.ts':
          'declare const classes: Record<string, string>;\nexport default classes;\n',
        'src/styles.css': ':root {}\n',
      },
      stylesheet,
    );
    expect(promising.findings.map((finding) => finding.missing)).toEqual([['default']]);
  });

  test('three emitted paths built from one source module are not examined', async () => {
    // A cinder component subpath: the declaration is generated from the runtime module, so there
    // is nothing authored separately to disagree with it.
    const result = await checkFixture(
      { 'src/components/button/index.ts': 'export {};\n' },
      {
        './components/button': {
          types: './dist/components/button/index.d.ts',
          browser: './src/components/button/index.ts',
          node: './dist/server/components/button/index.js',
          default: './dist/components/button/index.js',
        },
      },
    );
    expect(result).toEqual({ publicName: '@fixture/package', examined: [], findings: [] });
  });

  test('a nested runtime condition is paired with the declaration that governs it', async () => {
    const result = await checkFixture(
      {
        'src/index.ts': 'export const root = 1;\n',
        'src/bun.ts': 'export const bunOnly = 1;\n',
      },
      {
        '.': {
          bun: { types: './dist/bun.d.ts', default: './dist/bun.js' },
          types: './dist/index.d.ts',
          default: './dist/index.js',
        },
      },
    );
    // `bun.default` answers to `bun.types` and `default` to `types`; each pair is one module.
    expect(result.examined).toEqual([]);
  });
});
