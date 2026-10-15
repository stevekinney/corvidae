import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  coverageTestArguments,
  discoverCoverageTestFiles,
  parseLcov,
  selectCoverageTestFiles,
} from './check-coverage.ts';

describe('selectCoverageTestFiles', () => {
  it('keeps only repository test files and returns unknown files in lexical order', () => {
    expect(
      selectCoverageTestFiles([
        'src/zeta.test.ts',
        'README.md',
        'tests/smoke.test.ts',
        'tests/browser.spec.ts',
        'src/unit_test.tsx',
        'scripts/check_spec.js',
        'tests/e2e/browser.spec.ts',
        'src/not-a-test.ts',
        'scripts/coverage.test.ts',
        'node_modules/dependency.test.ts',
        'src/alpha.test.ts',
      ]),
    ).toEqual([
      'scripts/check_spec.js',
      'scripts/coverage.test.ts',
      'src/alpha.test.ts',
      'src/unit_test.tsx',
      'src/zeta.test.ts',
      'tests/browser.spec.ts',
      'tests/smoke.test.ts',
    ]);
  });

  it('preserves the explicit order that produced the recorded coverage baseline', () => {
    expect(
      selectCoverageTestFiles([
        'scripts/check-coverage.test.ts',
        'tests/tanstack-query-smoke.test.ts',
        'tests/component-harness.test.ts',
      ]),
    ).toEqual([
      'tests/component-harness.test.ts',
      'tests/tanstack-query-smoke.test.ts',
      'scripts/check-coverage.test.ts',
    ]);
  });

  it('uses the recorded order for each platform independently', () => {
    const files = ['src/app/fault-boundary.test.ts', 'src/lib/attribute-filters.test.ts'];

    expect(selectCoverageTestFiles(files, 'linux')).toEqual([
      'src/lib/attribute-filters.test.ts',
      'src/app/fault-boundary.test.ts',
    ]);
    expect(selectCoverageTestFiles(files, 'darwin')).toEqual([
      'src/app/fault-boundary.test.ts',
      'src/lib/attribute-filters.test.ts',
    ]);
  });

  it('passes exact relative paths so Bun executes files in the selected order', () => {
    expect(
      coverageTestArguments([
        'tests/smoke.test.ts',
        'src/alpha.test.ts',
        'scripts/coverage.test.ts',
      ]),
    ).toEqual(['./scripts/coverage.test.ts', './src/alpha.test.ts', './tests/smoke.test.ts']);
  });

  it('discovers every Bun-supported pattern and excludes configured e2e tests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coverage-discovery-'));
    try {
      await Promise.all(
        ['scripts', 'src', 'tests/e2e'].map((path) => mkdir(join(root, path), { recursive: true })),
      );
      await Promise.all(
        [
          'scripts/A.test.mts',
          'scripts/a.test.ts',
          'scripts/module.test.cjs',
          'src/b_test.tsx',
          'src/b_test.cts',
          'src/c.spec.js',
          'src/module.spec.mjs',
          'tests/d_spec.jsx',
          'tests/not-a-test.ts',
          'tests/e2e/browser.spec.ts',
        ].map((path) => writeFile(join(root, path), '')),
      );

      expect(discoverCoverageTestFiles(root, 'win32')).toEqual([
        'scripts/A.test.mts',
        'scripts/a.test.ts',
        'scripts/module.test.cjs',
        'src/b_test.cts',
        'src/b_test.tsx',
        'src/c.spec.js',
        'src/module.spec.mjs',
        'tests/d_spec.jsx',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('discovers the real repository suite in the platform baseline order', () => {
    const files = discoverCoverageTestFiles();

    expect(files.slice(0, 3)).toEqual([
      'tests/component-harness.test.ts',
      'tests/tanstack-query-smoke.test.ts',
      'scripts/check-coverage.test.ts',
    ]);
    expect(files).toContain('scripts/check-coverage.test.ts');
    expect(new Set(files).size).toBe(files.length);
    expect(files.every((file) => !file.startsWith('tests/e2e/'))).toBeTrue();
  });
});
describe('parseLcov', () => {
  it('parses a single record', () => {
    const lcov = [
      'TN:',
      'SF:src/lib/example.ts',
      'FNF:2',
      'FNH:1',
      'DA:1,5',
      'DA:2,0',
      'LF:10',
      'LH:7',
      'end_of_record',
      '',
    ].join('\n');

    expect(parseLcov(lcov)).toEqual([
      {
        file: 'src/lib/example.ts',
        linesFound: 10,
        linesHit: 7,
        functionsFound: 2,
        functionsHit: 1,
      },
    ]);
  });

  it('parses multiple records in one report', () => {
    const lcov = [
      'SF:a.ts',
      'FNF:1',
      'FNH:1',
      'LF:2',
      'LH:2',
      'end_of_record',
      'SF:b.ts',
      'FNF:3',
      'FNH:0',
      'LF:4',
      'LH:1',
      'end_of_record',
    ].join('\n');

    expect(parseLcov(lcov)).toEqual([
      { file: 'a.ts', linesFound: 2, linesHit: 2, functionsFound: 1, functionsHit: 1 },
      { file: 'b.ts', linesFound: 4, linesHit: 1, functionsFound: 3, functionsHit: 0 },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseLcov('')).toEqual([]);
  });

  it('drops a record with no SF: line rather than throwing', () => {
    const lcov = ['FNF:1', 'FNH:1', 'LF:2', 'LH:2', 'end_of_record'].join('\n');
    expect(parseLcov(lcov)).toEqual([]);
  });

  it('ignores unrecognized lines (e.g. DA:/TN:/BRDA:) between records', () => {
    const lcov = [
      'TN:',
      'SF:src/lib/example.ts',
      'FNF:1',
      'FNH:1',
      'BRDA:1,0,0,1',
      'DA:1,5',
      'LF:1',
      'LH:1',
      'end_of_record',
    ].join('\n');
    expect(parseLcov(lcov)).toEqual([
      {
        file: 'src/lib/example.ts',
        linesFound: 1,
        linesHit: 1,
        functionsFound: 1,
        functionsHit: 1,
      },
    ]);
  });

  it('resets state between records so one bad block cannot bleed into the next', () => {
    const lcov = [
      'SF:a.ts',
      'FNF:5',
      'FNH:5',
      'LF:5',
      'LH:5',
      'end_of_record',
      // No SF: for this block — dropped, and must not inherit a.ts's counts.
      'FNF:9',
      'FNH:9',
      'LF:9',
      'LH:9',
      'end_of_record',
      'SF:b.ts',
      'LF:2',
      'LH:2',
      'end_of_record',
    ].join('\n');
    expect(parseLcov(lcov)).toEqual([
      { file: 'a.ts', linesFound: 5, linesHit: 5, functionsFound: 5, functionsHit: 5 },
      { file: 'b.ts', linesFound: 2, linesHit: 2, functionsFound: 0, functionsHit: 0 },
    ]);
  });
});
