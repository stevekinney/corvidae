import { expect, test } from 'bun:test';

import {
  declaresImportSpecifier,
  exportSourceTarget,
  sourceExportViolations,
} from './workspace-exports';

const existing = new Set(['src/index.ts', 'src/protocol/index.ts', 'src/bun/pty.ts']);
const exists = (path: string): boolean => existing.has(path);

test('accepts the root entry alone and plain subpaths that point at existing source', () => {
  expect(sourceExportViolations({ '.': './src/index.ts' }, exists)).toEqual([]);
  expect(
    sourceExportViolations(
      {
        '.': './src/index.ts',
        './protocol': './src/protocol/index.ts',
        './bun/pty': './src/bun/pty.ts',
      },
      exists,
    ),
  ).toEqual([]);
});

test('rejects exports that are missing, not an object, or lack the source root entry', () => {
  expect(sourceExportViolations(undefined, exists)).toEqual([
    'exports must be an object mapping "." to "./src/index.ts"',
  ]);
  expect(sourceExportViolations('./src/index.ts', exists)).toEqual([
    'exports must be an object mapping "." to "./src/index.ts"',
  ]);
  expect(sourceExportViolations({ './protocol': './src/protocol/index.ts' }, exists)).toEqual([
    '"." must map to "./src/index.ts"',
  ]);
  expect(sourceExportViolations({ '.': './src/protocol/index.ts' }, exists)).toEqual([
    '"." must map to "./src/index.ts"',
  ]);
});

test('rejects subpath keys that are not plain lowercase kebab-case segments', () => {
  for (const key of [
    './*',
    './protocol/*',
    './Protocol',
    './protocol_core',
    './../escape',
    'protocol',
    './',
    './protocol/',
  ]) {
    expect(
      sourceExportViolations({ '.': './src/index.ts', [key]: './src/protocol/index.ts' }, exists),
      key,
    ).toEqual([`${JSON.stringify(key)} is not a plain subpath export`]);
  }
});

test('rejects subpath targets that are conditional, outside src, not TypeScript, or missing', () => {
  const cases: readonly [unknown, string][] = [
    [{ bun: './src/bun/pty.ts' }, 'must be a string path'],
    ['./dist/protocol.js', 'must point at a ./src/**/*.ts file'],
    ['./src/protocol/index.js', 'must point at a ./src/**/*.ts file'],
    ['./src/../scripts/tool.ts', 'must point at a ./src/**/*.ts file'],
    ['./src/protocol/missing.ts', 'points at a file that does not exist'],
  ];
  for (const [target, message] of cases) {
    expect(
      sourceExportViolations({ '.': './src/index.ts', './protocol': target }, exists),
      JSON.stringify(target),
    ).toEqual([`"./protocol" ${message}`]);
  }
});

const declared = {
  types: './.types/src/index.d.ts',
  svelte: './src/index.ts',
  default: './src/index.ts',
};

test('accepts the declaration form only where a component library asks for it', () => {
  expect(sourceExportViolations({ '.': declared }, exists, { declarations: true })).toEqual([]);
  expect(sourceExportViolations({ '.': declared }, exists)).toEqual([
    '"." must map to "./src/index.ts"',
  ]);
});

test('rejects a declaration form whose types do not mirror its source', () => {
  const violations = (entry: unknown) =>
    sourceExportViolations({ '.': entry }, exists, { declarations: true });
  expect(violations({ ...declared, types: './dist/index.d.ts' })).toEqual([
    '"." must map to "./src/index.ts"',
  ]);
  expect(violations({ ...declared, svelte: './src/other.ts' })).toEqual([
    '"." must map to "./src/index.ts"',
  ]);
  expect(violations({ ...declared, import: './src/index.ts' })).toEqual([
    '"." must map to "./src/index.ts"',
  ]);
});

test('exportSourceTarget reads the source of a string or a declaration form', () => {
  expect(exportSourceTarget('./src/index.ts')).toBe('./src/index.ts');
  expect(exportSourceTarget(declared)).toBe('./src/index.ts');
  expect(exportSourceTarget({ ...declared, svelte: './src/other.ts' })).toBeNull();
  expect(exportSourceTarget(undefined)).toBeNull();
});

test('allows importing the workspace root or a subpath its exports declare, and nothing else', () => {
  const exports = { '.': './src/index.ts', './protocol': './src/protocol/index.ts' };
  expect(
    declaresImportSpecifier('@lostgradient/terminal-host', '@lostgradient/terminal-host', exports),
  ).toBe(true);
  expect(
    declaresImportSpecifier(
      '@lostgradient/terminal-host/protocol',
      '@lostgradient/terminal-host',
      exports,
    ),
  ).toBe(true);
  expect(
    declaresImportSpecifier(
      '@lostgradient/terminal-host/bun',
      '@lostgradient/terminal-host',
      exports,
    ),
  ).toBe(false);
  expect(
    declaresImportSpecifier(
      '@lostgradient/terminal-host/src/protocol/index.ts',
      '@lostgradient/terminal-host',
      exports,
    ),
  ).toBe(false);
  expect(declaresImportSpecifier('armorer/protocol', 'armorer', { '.': './src/index.ts' })).toBe(
    false,
  );
  expect(
    declaresImportSpecifier('@lostgradient/weft/server', '@lostgradient/weft', undefined),
  ).toBe(false);
});
