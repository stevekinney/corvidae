import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createPackage, packageFiles } from './create-package.ts';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

/**
 * A repository root in a temporary directory: the new package is real, and everything it reaches
 * by path (`node_modules`, the root scripts, the tooling, the testing helpers) links to this
 * checkout, so no install runs and nothing reaches the network.
 */
async function temporaryRepository(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'create-package-'));
  mkdirSync(join(root, 'components'));
  for (const name of ['node_modules', 'scripts', 'internal', 'testing']) {
    symlinkSync(join(repositoryRoot, name), join(root, name), 'dir');
  }
  copyFileSync(join(repositoryRoot, 'package.json'), join(root, 'package.json'));
  // The package's `test` script runs through the host test pool, which keeps its slots in the
  // checkout's Git directory and refuses to run outside one (exit 76, its admission error).
  const init = await command(['git', 'init', '--quiet'], root);
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr}`);
  return root;
}

async function command(argv: string[], cwd: string) {
  const child = spawnWithHangGuard(argv, { cwd, stdout: 'pipe', stderr: 'pipe', env: process.env });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function run(script: string, cwd: string) {
  const child = spawnWithHangGuard([process.execPath, 'run', script], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { script, exitCode, output: exitCode === 0 ? '' : `${stdout}\n${stderr}` };
}

// The package's own commands are the behavior under test, so they run once at module scope, off
// Bun's per-test clock; the tests below assert on the settled results.
const root = await temporaryRepository();
const written = createPackage(root, 'demo');
const directory = join(root, 'components', 'demo');
const results: Awaited<ReturnType<typeof run>>[] = [];
for (const script of ['types', 'lint', 'typecheck', 'test']) {
  results.push(await run(script, directory));
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('create-package demo', () => {
  test('writes every file of a family package', () => {
    expect(written.toSorted()).toEqual(
      Object.keys(packageFiles('demo'))
        .map((path) => `components/demo/${path}`)
        .toSorted(),
    );
  });

  test("the new package's declarations, lint, type-check and test exit 0", () => {
    expect(results).toEqual([
      { script: 'types', exitCode: 0, output: '' },
      { script: 'lint', exitCode: 0, output: '' },
      { script: 'typecheck', exitCode: 0, output: '' },
      { script: 'test', exitCode: 0, output: '' },
    ]);
  });

  // The `types` export condition names this file, so a consumer type-checks against it.
  test('emits the declaration its `types` export condition names', () => {
    expect(existsSync(join(directory, '.types/src/index.d.ts'))).toBe(true);
  });

  test('refuses to overwrite a package that exists', () => {
    expect(() => createPackage(root, 'demo')).toThrow('already exist');
  });

  test('refuses a name that is not kebab-case', () => {
    expect(() => createPackage(root, 'Demo Package')).toThrow('not a kebab-case');
  });
});
