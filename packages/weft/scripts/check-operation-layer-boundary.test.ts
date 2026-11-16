import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { write } from 'bun';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  ALLOWLIST_PATH,
  collectSpecifiers,
  ENTRY_FILES,
  runCli,
} from './check-operation-layer-boundary.ts';

type RunResult = { exitCode: number; stdout: string; stderr: string };

/**
 * Runs the checker's CLI in process with `console` captured, as
 * `bun scripts/check-operation-layer-boundary.ts` would print it. Spawning it would put a Bun boot
 * inside the test's budget; the package's `lint` script runs the real entry point.
 */
async function run(args: readonly string[]): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]): void => {
    stdout.push(values.map(String).join(' '));
  };
  console.error = (...values: unknown[]): void => {
    stderr.push(values.map(String).join(' '));
  };
  try {
    const exitCode = await runCli(args);
    return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe('check-operation-layer-boundary', () => {
  let root: string;

  const fixture = (relativePath: string, body: string): Promise<number> =>
    write(join(root, relativePath), body);

  const checkEntry = (...extra: string[]): Promise<RunResult> =>
    run(['--root', root, '--entry', 'src/server/entry.ts', ...extra]);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'operation-layer-boundary-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes when every reachable import stays in src/server or names zod', async () => {
    await fixture(
      'src/server/entry.ts',
      `import { z } from 'zod';\nimport { helper } from './helper.ts';\nexport const value = z.string();\nexport { helper };\n`,
    );
    await fixture(
      'src/server/helper.ts',
      `import type { ZodType } from 'zod/v4';\nexport const helper = 1;\n`,
    );
    const result = await checkEntry();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK: 2 reachable files; 0 allowlisted imports remain.');
  });

  it('fails on an import that leaves src/server, naming the file, line and specifier', async () => {
    await fixture(
      'src/server/entry.ts',
      `import { helper } from './helper.ts';\nimport { version } from '../version.ts';\nexport { helper, version };\n`,
    );
    await fixture('src/server/helper.ts', `export const helper = 1;\n`);
    await fixture('src/version.ts', `export const version = '1';\n`);
    const result = await checkEntry();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('src/server/entry.ts:2 imports "../version.ts"');
  });

  it('fails on a type-only import, a re-export, and a type-position import()', async () => {
    await fixture(
      'src/server/entry.ts',
      [
        `import type { A } from '../core/a.ts';`,
        `export * from '../core/b.ts';`,
        `export type { C } from '../core/c.ts';`,
        `export type D = import('../core/d.ts').D;`,
        `export type { A };`,
        '',
      ].join('\n'),
    );
    const result = await checkEntry();
    expect(result.exitCode).toBe(1);
    for (const specifier of ['a', 'b', 'c', 'd']) {
      expect(result.stderr).toContain(`"../core/${specifier}.ts"`);
    }
  });

  it('fails on a package other than zod, a Node built-in included', async () => {
    await fixture(
      'src/server/entry.ts',
      `import { readFile } from 'node:fs/promises';\nimport { other } from 'valibot';\nexport { readFile, other };\n`,
    );
    const result = await checkEntry();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('"node:fs/promises"');
    expect(result.stderr).toContain('"valibot"');
  });

  it('follows imports inside src/server and records a violation against the importing file', async () => {
    await fixture('src/server/entry.ts', `export { deep } from './nested/deep.ts';\n`);
    await fixture(
      'src/server/nested/deep.ts',
      `import { engine } from '../../core/engine.ts';\nexport const deep = engine;\n`,
    );
    const result = await checkEntry();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('src/server/nested/deep.ts:1 imports "../../core/engine.ts"');
  });

  it('follows a directory import to its index file', async () => {
    await fixture('src/server/entry.ts', `export { thing } from './group';\n`);
    await fixture(
      'src/server/group/index.ts',
      `import { x } from '../../core/x.ts';\nexport const thing = x;\n`,
    );
    const result = await checkEntry('--list');
    expect(result.stdout.split('\n')).toEqual(['src/server/entry.ts', 'src/server/group/index.ts']);
  });

  it('does not walk files outside src/server', async () => {
    await fixture('src/server/entry.ts', `export { version } from '../version.ts';\n`);
    await fixture(
      'src/version.ts',
      `import { other } from './other.ts';\nexport const version = other;\n`,
    );
    await fixture('src/other.ts', `export const other = 1;\n`);
    const violations = await checkEntry('--violations');
    expect(JSON.parse(violations.stdout)).toEqual([
      { file: 'src/server/entry.ts', specifier: '../version.ts' },
    ]);
    const listed = await checkEntry('--list');
    expect(listed.stdout).toBe('src/server/entry.ts');
  });

  it('passes an import the allowlist names', async () => {
    await fixture(
      'src/server/entry.ts',
      `import { version } from '../version.ts';\nexport { version };\n`,
    );
    await fixture(
      ALLOWLIST_PATH,
      JSON.stringify([{ file: 'src/server/entry.ts', specifier: '../version.ts' }]),
    );
    const result = await checkEntry();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('1 allowlisted imports remain.');
  });

  it('fails on an allowlist entry whose import no longer occurs', async () => {
    await fixture('src/server/entry.ts', `export const value = 1;\n`);
    await fixture(
      ALLOWLIST_PATH,
      JSON.stringify([{ file: 'src/server/entry.ts', specifier: '../version.ts' }]),
    );
    const result = await checkEntry();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('src/server/entry.ts no longer imports "../version.ts"');
  });

  it('fails on an allowlist entry for a file the walk no longer reaches', async () => {
    await fixture('src/server/entry.ts', `export const value = 1;\n`);
    await fixture('src/server/orphan.ts', `import { v } from '../version.ts';\nexport { v };\n`);
    await fixture(
      ALLOWLIST_PATH,
      JSON.stringify([{ file: 'src/server/orphan.ts', specifier: '../version.ts' }]),
    );
    const result = await checkEntry();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('src/server/orphan.ts no longer imports');
  });

  it('--update removes stale entries and keeps the ones still needed', async () => {
    await fixture('src/server/entry.ts', `import { v } from '../version.ts';\nexport { v };\n`);
    await fixture(
      ALLOWLIST_PATH,
      JSON.stringify([
        { file: 'src/server/entry.ts', specifier: '../version.ts' },
        { file: 'src/server/entry.ts', specifier: '../gone.ts' },
      ]),
    );
    const updated = await checkEntry('--update');
    expect(updated.exitCode).toBe(0);
    expect(updated.stdout).toContain('Removed 1 stale allowlist entries.');
    const after = await checkEntry();
    expect(after.exitCode).toBe(0);
    expect(after.stdout).toContain('1 allowlisted imports remain.');
  });

  it('--update never adds an entry for a new violation', async () => {
    await fixture('src/server/entry.ts', `import { v } from '../version.ts';\nexport { v };\n`);
    const result = await checkEntry('--update');
    expect(result.exitCode).toBe(1);
  });

  it('prints the reachable files with --list', async () => {
    await fixture('src/server/entry.ts', `import './b.ts';\nimport './a.ts';\n`);
    await fixture('src/server/a.ts', `export {};\n`);
    await fixture('src/server/b.ts', `import './a.ts';\n`);
    const result = await checkEntry('--list');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split('\n')).toEqual([
      'src/server/a.ts',
      'src/server/b.ts',
      'src/server/entry.ts',
    ]);
  });

  it('fails on an import inside src/server that names no file', async () => {
    await fixture('src/server/entry.ts', `import './missing.ts';\n`);
    const result = await checkEntry();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('"./missing.ts", which names no file');
  });

  it('exits 2 on an unknown argument', async () => {
    const result = await run(['--nope']);
    expect(result.exitCode).toBe(2);
  });

  it('collects each form of module specifier with its line', () => {
    const edges = collectSpecifiers(
      [
        `import a from './a.ts';`,
        `import type { B } from './b.ts';`,
        `export * from './c.ts';`,
        `export type D = import('./d.ts').D;`,
        `const e = await import('./e.ts');`,
        `const dynamic = await import(variable);`,
        '',
      ].join('\n'),
      'fixture.ts',
    );
    expect(edges).toEqual([
      { specifier: './a.ts', line: 1 },
      { specifier: './b.ts', line: 2 },
      { specifier: './c.ts', line: 3 },
      { specifier: './d.ts', line: 4 },
      { specifier: './e.ts', line: 5 },
    ]);
  });

  it("holds for this package: Weft's declared entry files reach nothing the allowlist does not name", async () => {
    expect(ENTRY_FILES.length).toBeGreaterThan(0);
    const result = await run([]);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
