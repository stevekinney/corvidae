import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import ts from 'typescript';

/**
 * COR-1783: a storage adapter serves one runtime and carries no fallback to another. A Node user
 * picks the Node adapter and a Bun user picks the Bun adapter, so the source of an adapter, and of
 * Weft's storage layer, never asks which runtime it is on in order to choose a driver or a codec.
 *
 * This guard reads the syntax tree of every non-test source file under `packages/storage` and
 * `packages/storage-*`, and under `packages/weft/src/storage`, and flags the probes that selected a
 * runtime before: `typeof Bun`, `globalThis.Bun`, `process.versions.bun`, `isBunRuntime`,
 * `detectRuntime`, and `tryLoadNodeBuiltin`. A mention in a comment, a string, or a type position
 * such as `ReturnType<typeof Bun.spawn>` is not a probe, which a text search could not tell apart.
 *
 * It is separate from `storage-boundaries.test.ts` (COR-1780), which guards dependency edges.
 */

const root = join(import.meta.dir, '..');

/** The probes this guard flags, by the token a finding names. */
const PROBE_TOKENS = [
  'typeof Bun',
  'globalThis.Bun',
  'process.versions.bun',
  'isBunRuntime',
  'detectRuntime',
  'tryLoadNodeBuiltin',
] as const;

type ProbeToken = (typeof PROBE_TOKENS)[number];

type Finding = { token: ProbeToken; line: number };

/** A probe that is allowed to remain, and the decision that will remove it. */
type AllowedProbe = { file: string; token: ProbeToken; reason: string };

/**
 * Every probe still allowed. A stale entry (its file no longer holds the probe) fails the test, so
 * this list can only shrink.
 */
const allowedProbes: AllowedProbe[] = [
  {
    file: 'packages/storage-turso/src/turso.ts',
    token: 'tryLoadNodeBuiltin',
    reason:
      'COR-1783 is waiting on an owner decision about the one fallback left inside an adapter: ' +
      'createClient chooses the web libSQL client when node:module is absent. The decision removes ' +
      'this entry.',
  },
  {
    file: 'packages/storage/src/runtime.ts',
    token: 'tryLoadNodeBuiltin',
    reason:
      'The definition of the helper storage-turso still calls. It goes with the Turso decision above.',
  },
  {
    file: 'packages/storage/src/environment-configuration.ts',
    token: 'typeof Bun',
    reason:
      'COR-1784 owns the environment lookup (Bun.env or process.env). It is not a driver or codec choice.',
  },
];

const sourceDirectories = [
  ...readdirSync(join(root, 'packages'))
    .filter((name) => name === 'storage' || name.startsWith('storage-'))
    .map((name) => join('packages', name, 'src')),
  join('packages', 'weft', 'src', 'storage'),
];

/** File name suffixes of tests, fixtures, and test helpers, which may probe the runtime they run on. */
const TEST_FILE_SUFFIXES = [
  '.test.ts',
  '.test-d.ts',
  '.test-support.ts',
  '.integration.ts',
  '-fixture.ts',
  '.bench.ts',
];

/** Directories that hold only shared test suites and helpers. */
const TEST_DIRECTORIES = new Set(['testing', 'test', 'node_modules', '.types', 'coverage']);

function isTestFile(fileName: string): boolean {
  return TEST_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

function isTypeScriptSource(fileName: string): boolean {
  return fileName.endsWith('.ts') && !fileName.endsWith('.d.ts');
}

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!TEST_DIRECTORIES.has(entry.name)) {
        files.push(...collectSourceFiles(join(directory, entry.name)));
      }
    } else if (isTypeScriptSource(entry.name) && !isTestFile(entry.name)) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

function stringLiteralKey(node: ts.Expression): string | undefined {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

/** The member a property or element access reads, whichever way it is spelled. */
function accessedMember(node: ts.Node): { target: ts.Expression; member: string } | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return { target: node.expression, member: node.name.text };
  }
  if (ts.isElementAccessExpression(node)) {
    const member = stringLiteralKey(node.argumentExpression);
    return member === undefined ? undefined : { target: node.expression, member };
  }
  return undefined;
}

function isIdentifierNamed(node: ts.Node, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name;
}

function probeTokenFor(node: ts.Node): ProbeToken | undefined {
  if (ts.isIdentifier(node)) {
    if (node.text === 'isBunRuntime') return 'isBunRuntime';
    if (node.text === 'detectRuntime') return 'detectRuntime';
    if (node.text === 'tryLoadNodeBuiltin') return 'tryLoadNodeBuiltin';
  }
  if (ts.isTypeOfExpression(node) && isIdentifierNamed(node.expression, 'Bun')) {
    return 'typeof Bun';
  }
  const access = accessedMember(node);
  if (access?.member === 'Bun' && isIdentifierNamed(access.target, 'globalThis')) {
    return 'globalThis.Bun';
  }
  if (access?.member === 'bun') {
    const versions = accessedMember(access.target);
    if (versions?.member === 'versions' && isIdentifierNamed(versions.target, 'process')) {
      return 'process.versions.bun';
    }
  }
  return undefined;
}

/**
 * The runtime probes in one source file.
 *
 * @param sourceText - the file's text
 * @param fileName - the file's name, which selects the TypeScript parser
 */
function findRuntimeProbes(sourceText: string, fileName = 'source.ts'): Finding[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    const token = probeTokenFor(node);
    if (token !== undefined) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      findings.push({ token, line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function isAllowed(file: string, token: ProbeToken): boolean {
  return allowedProbes.some((entry) => entry.file === file && entry.token === token);
}

function scanStorageSources(): Array<{ file: string; token: ProbeToken; line: number }> {
  const hits: Array<{ file: string; token: ProbeToken; line: number }> = [];
  for (const directory of sourceDirectories) {
    for (const path of collectSourceFiles(directory)) {
      const file = path.split(sep).join('/');
      const text = readFileSync(join(root, path), 'utf8');
      for (const finding of findRuntimeProbes(text, path)) {
        hits.push({ file, ...finding });
      }
    }
  }
  return hits;
}

describe('findRuntimeProbes', () => {
  test.each([
    ["const isBun = typeof Bun !== 'undefined';", 'typeof Bun'],
    ["const isBun = typeof globalThis.Bun !== 'undefined';", 'globalThis.Bun'],
    ["const isBun = globalThis['Bun'] !== undefined;", 'globalThis.Bun'],
    ['const isBun = Boolean(process.versions.bun);', 'process.versions.bun'],
    ["const isBun = Boolean(process['versions']['bun']);", 'process.versions.bun'],
    ["import { isBunRuntime } from '../runtime/portable.ts';", 'isBunRuntime'],
    ['const runtime = detectRuntime();', 'detectRuntime'],
    ["const module = tryLoadNodeBuiltin('node:module');", 'tryLoadNodeBuiltin'],
  ] as const)('flags the seeded probe %p', (source, token) => {
    expect(findRuntimeProbes(source).map((finding) => finding.token)).toContain(token);
  });

  test('reports the line of a probe', () => {
    expect(findRuntimeProbes('const a = 1;\n\nconst b = typeof Bun;\n')).toEqual([
      { token: 'typeof Bun', line: 3 },
    ]);
  });

  test('ignores mentions in comments and strings, and a typeof in type position', () => {
    const source = [
      '// typeof Bun, globalThis.Bun, process.versions.bun, detectRuntime, tryLoadNodeBuiltin',
      '/** isBunRuntime */',
      "const message = 'typeof Bun is not read here';",
      'type Child = ReturnType<typeof Bun.spawn>;',
      'const environment = process.env;',
    ].join('\n');
    expect(findRuntimeProbes(source)).toEqual([]);
  });
});

describe('storage runtime boundaries (COR-1783)', () => {
  const hits = scanStorageSources();

  test('scans the storage packages and Weft storage layer', () => {
    const scanned = new Set(hits.map((hit) => hit.file));
    expect(sourceDirectories).toContain('packages/storage/src');
    expect(sourceDirectories).toContain('packages/storage-bun-sqlite/src');
    expect(sourceDirectories).toContain('packages/storage-node-sqlite/src');
    expect(sourceDirectories).toContain(join('packages', 'weft', 'src', 'storage'));
    expect(collectSourceFiles(sourceDirectories[0]!).length).toBeGreaterThan(0);
    // The allowed sites are the proof the walk reaches into src: each must still be found.
    expect(scanned.has('packages/storage-turso/src/turso.ts')).toBe(true);
  });

  test('no storage source outside tests probes the runtime to choose a driver or a codec', () => {
    const violations = hits
      .filter((hit) => !isAllowed(hit.file, hit.token))
      .map((hit) => `${hit.file}:${hit.line} ${hit.token}`);
    expect(violations).toEqual([]);
  });

  test('every allowed probe is still there, so the allowlist only shrinks', () => {
    const stale = allowedProbes
      .filter((entry) => !hits.some((hit) => hit.file === entry.file && hit.token === entry.token))
      .map((entry) => `${entry.file} ${entry.token}`);
    expect(stale).toEqual([]);
  });

  test('every allowed probe names its reason', () => {
    for (const entry of allowedProbes) {
      expect(entry.reason.length).toBeGreaterThan(40);
    }
  });
});
