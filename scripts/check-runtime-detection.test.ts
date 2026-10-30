import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import {
  findRuntimeDetection,
  isProductionSource,
  judge,
  scan,
  type RuntimeDetectionAllowlistEntry,
  type RuntimeDetectionFinding,
} from './check-runtime-detection.ts';

function inspect(source: string): string[] {
  const parsed = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  return findRuntimeDetection(parsed).map((finding) => `${finding.kind}: ${finding.text}`);
}

describe('runtime detection', () => {
  test.each([
    ["const environment = typeof Bun !== 'undefined' ? Bun.env : process.env;", 'typeof-bun'],
    ["if (typeof Bun === 'undefined') throw new Error('x');", 'typeof-bun'],
    ["const present = typeof globalThis.Bun !== 'undefined';", 'typeof-bun'],
    ['const runtime = globalThis.Bun;', 'global-bun'],
    ["const runtime = globalThis['Bun'];", 'global-bun'],
    ["const runtime = Reflect.get(globalThis, 'Bun');", 'global-bun'],
    ["const present = 'Bun' in globalThis;", 'global-bun'],
    ['const version = process.versions.bun;', 'process-versions-bun'],
    ["const version = process.versions['bun'];", 'process-versions-bun'],
    ['const version = process?.versions?.bun;', 'process-versions-bun'],
    ['function isBunRuntime(): boolean { return true; }', 'detection-identifier'],
    ["import { detectRuntime } from './portable.ts';", 'detection-identifier'],
    ['const name = detectRuntime();', 'detection-identifier'],
  ])('flags %s', (source, kind) => {
    const found = inspect(source);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((entry) => entry.startsWith(`${kind}:`))).toBe(true);
  });

  test.each([
    'type Server = ReturnType<typeof Bun.serve>;',
    'type Options = Parameters<typeof Bun.spawn>[0];',
    'let server: ReturnType<typeof Bun.serve> | undefined;',
    "const environment = typeof process !== 'undefined' ? process.env : {};",
    "const loader = process.getBuiltinModule('node:crypto');",
    'const version = process.versions.node;',
    "const value = Reflect.get(globalThis, 'process');",
    "const present = 'process' in globalThis;",
    "const message = 'typeof Bun is detection';",
    '// typeof Bun !== "undefined"\nconst value = 1;',
    'const detectRuntimeName = 1;',
    'const bun = settings.Bun;',
  ])('accepts %s', (source) => {
    expect(inspect(source)).toEqual([]);
  });

  test('reports a multi-line site on the line where it starts', () => {
    const parsed = ts.createSourceFile(
      'fixture.ts',
      "const a = 1;\nconst environment =\n  typeof Bun !== 'undefined' ? Bun.env : {};\n",
      ts.ScriptTarget.Latest,
      true,
    );
    expect(findRuntimeDetection(parsed).map((finding) => finding.line)).toEqual([3]);
  });

  test('counts each site once, not its parts', () => {
    expect(
      inspect("const a = typeof globalThis.Bun !== 'undefined' && globalThis.Bun;"),
    ).toHaveLength(2);
  });
});

describe('production source selection', () => {
  test.each([
    'packages/cryptography/src/hash.ts',
    'packages/weft/src/runtime/portable.ts',
    'packages/storage-sqlite/src/index.ts',
  ])('judges %s', (path) => {
    expect(isProductionSource(path)).toBe(true);
  });

  test.each([
    'packages/weft/src/runtime/portable.test.ts',
    'packages/bureau/src/http/a2a-push.test-support.ts',
    'packages/bureau/src/test/signal-shutdown/host-support.ts',
    'packages/storage/src/testing/durability/adapter-spec.ts',
    'packages/operative-anthropic/src/testing.ts',
    'packages/weft/src/types.d.ts',
    'packages/weft/test/portable.ts',
    'applications/playground/src/runtime.ts',
    'components/chat/src/lib/session.ts',
    'scripts/check-runtime-detection.ts',
    'packages/weft/README.md',
  ])('exempts %s', (path) => {
    expect(isProductionSource(path)).toBe(false);
  });
});

describe('allowlist judgment', () => {
  const site = (line: number, kind: RuntimeDetectionFinding['kind']): RuntimeDetectionFinding => ({
    line,
    kind,
    text: 'x',
  });
  const entry = (count: number): RuntimeDetectionAllowlistEntry => ({
    file: 'packages/a/src/a.ts',
    kind: 'typeof-bun',
    count,
    reason: 'a reason the reviewer accepted',
  });
  const found = (...sites: RuntimeDetectionFinding[]) => new Map([['packages/a/src/a.ts', sites]]);

  test('an unlisted site fails', () => {
    const verdict = judge(found(site(3, 'typeof-bun')), []);
    expect(verdict.unlisted).toEqual(['packages/a/src/a.ts:3 typeof-bun x']);
  });

  test('a listed site passes', () => {
    const verdict = judge(found(site(3, 'typeof-bun')), [entry(1)]);
    expect(verdict).toEqual({ unlisted: [], stale: [], shrunk: [entry(1)] });
  });

  test('a site beyond the listed count fails', () => {
    const verdict = judge(found(site(3, 'typeof-bun'), site(9, 'typeof-bun')), [entry(1)]);
    expect(verdict.unlisted).toEqual(['packages/a/src/a.ts:9 typeof-bun x']);
  });

  test('an entry for a different kind does not cover a site', () => {
    const verdict = judge(found(site(3, 'global-bun')), [entry(1)]);
    expect(verdict.unlisted).toHaveLength(1);
    expect(verdict.stale).toHaveLength(1);
  });

  test('an entry whose site is gone is stale', () => {
    const verdict = judge(new Map(), [entry(1)]);
    expect(verdict.stale).toEqual([
      'packages/a/src/a.ts typeof-bun: no site remains; remove the entry',
    ]);
    expect(verdict.shrunk).toEqual([]);
  });

  test('an entry that names more sites than remain is stale and shrinks', () => {
    const verdict = judge(found(site(3, 'typeof-bun')), [entry(3)]);
    expect(verdict.stale).toEqual(['packages/a/src/a.ts typeof-bun: lists 3 sites but 1 remain']);
    expect(verdict.shrunk).toEqual([entry(1)]);
  });
});

describe('scanning a repository', () => {
  function withRepository(
    files: Record<string, string>,
    run: (directory: string) => Promise<void>,
  ): Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), 'runtime-detection-'));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), content);
    }
    return run(directory).finally(() => rmSync(directory, { recursive: true, force: true }));
  }

  test('a seeded violation in production source is found, and tests and type queries are not', () =>
    withRepository(
      {
        'packages/demo/src/environment.ts':
          "export const environment = typeof Bun !== 'undefined' ? Bun.env : process.env;\n",
        'packages/demo/src/server.ts': 'export type Server = ReturnType<typeof Bun.serve>;\n',
        'packages/demo/src/environment.test.ts':
          "export const seeded = typeof Bun !== 'undefined';\n",
        'packages/demo/test/environment.ts': "export const seeded = typeof Bun !== 'undefined';\n",
        'packages/demo/node_modules/dependency/src/index.ts':
          'export const dependency = typeof Bun;\n',
      },
      async (directory) => {
        const found = await scan(directory);
        expect([...found.keys()]).toEqual(['packages/demo/src/environment.ts']);
        expect(judge(found, []).unlisted).toHaveLength(1);
      },
    ));
});

test('the repository holds no runtime detection outside the allowlist', async () => {
  const allowlist: RuntimeDetectionAllowlistEntry[] = await Bun.file(
    join(import.meta.dir, 'runtime-detection-allowlist.json'),
  ).json();
  const verdict = judge(await scan(), allowlist);
  expect(verdict.unlisted).toEqual([]);
  expect(verdict.stale).toEqual([]);
  for (const entry of allowlist) expect(entry.reason.trim().length).toBeGreaterThanOrEqual(20);
});
