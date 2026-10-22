import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

import {
  findUndocumentedExports,
  judgeCoverage,
  readEntryPoints,
} from './check-documentation-coverage.ts';

const fixture = mkdtempSync(join(tmpdir(), 'documentation-coverage-'));
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

const files: Record<string, string> = {
  'neighbor/src/index.ts': 'export const borrowed = 1;\n',
  'package/src/ambient.d.ts':
    "declare module '*.svelte' {\n  const component: unknown;\n  export default component;\n}\n",
  'package/src/button.svelte': '',
  'package/src/declared.ts': [
    '/** Documented where it is declared. */',
    'export const reexported = 1;',
    'export function bare(): void {}',
    '/** Shared by both entry points. */',
    'export interface Shared {}',
    'export type SharedUndocumented = string;',
  ].join('\n'),
  'package/src/index.ts': [
    "export { reexported, bare } from './declared.ts';",
    "export type { Shared, SharedUndocumented } from './declared.ts';",
    "export { borrowed } from '../../neighbor/src/index.ts';",
    "export { default as Button } from './button.svelte';",
    '/** Documented in place. */',
    'export class Documented {}',
    'export class Undocumented {}',
    '/** @deprecated A tag alone is not documentation. */',
    'export const tagged = 1;',
  ].join('\n'),
  'package/src/extra.ts':
    "export type { Shared, SharedUndocumented } from './declared.ts';\nexport const onlyHere = 1;\n",
};
for (const [path, contents] of Object.entries(files)) {
  await Bun.write(join(fixture, path), contents);
}

const options: ts.CompilerOptions = {
  noLib: true,
  types: [],
  allowImportingTsExtensions: true,
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};
const directory = join(fixture, 'package');

describe('findUndocumentedExports', () => {
  test('judges each export at its declaration, once, and only where this workspace owns it', () => {
    const entryPoints = readEntryPoints(directory, {
      '.': './src/index.ts',
      './extra': './src/extra.ts',
    });
    const declarationFiles = [join(directory, 'src/ambient.d.ts')];
    expect(findUndocumentedExports(directory, entryPoints, options, declarationFiles)).toEqual([
      '. SharedUndocumented',
      '. Undocumented',
      '. bare',
      '. tagged',
      './extra onlyHere',
    ]);
  });
});

describe('readEntryPoints', () => {
  test('accepts a bare string export as the root entry point', () => {
    expect(readEntryPoints(directory, './src/index.ts')).toEqual([
      { subpath: '.', file: join(directory, 'src/index.ts') },
    ]);
  });

  test('rejects a conditional or non-TypeScript export rather than skipping it', () => {
    expect(() => readEntryPoints(directory, { '.': { default: './src/index.ts' } })).toThrow(
      'must map to a TypeScript source file',
    );
    expect(() => readEntryPoints(directory, { './styles': './src/styles.css' })).toThrow(
      'must map to a TypeScript source file',
    );
  });
});

describe('judgeCoverage', () => {
  test('fails new undocumented exports and allowlist entries that no longer apply', () => {
    expect(judgeCoverage(['. kept', '. added'], ['. kept', '. documentedSince'])).toEqual({
      missing: ['. added'],
      stale: ['. documentedSince'],
    });
  });

  test('passes when the allowlist names exactly the undocumented exports', () => {
    expect(judgeCoverage(['. kept'], ['. kept'])).toEqual({ missing: [], stale: [] });
  });
});
