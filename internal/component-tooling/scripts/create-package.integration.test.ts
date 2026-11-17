import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createPackage, packageFiles } from './create-package.ts';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

/**
 * A repository root in a temporary directory: the new package is real, and everything it reaches
 * by path (`node_modules`, the root scripts, the tooling, the testing helpers) links to this
 * checkout, so no install runs and nothing reaches the network.
 */
function temporaryRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'create-package-'));
  mkdirSync(join(root, 'components'));
  for (const name of ['node_modules', 'scripts', 'internal', 'testing']) {
    symlinkSync(join(repositoryRoot, name), join(root, name), 'dir');
  }
  copyFileSync(join(repositoryRoot, 'package.json'), join(root, 'package.json'));
  return root;
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
const root = temporaryRepository();
const written = createPackage(root, 'demo');
const directory = join(root, 'components', 'demo');
// What `bun install` would link for the one workspace package the scaffold's source imports: the
// component tooling, whose example-mount helper `src/examples.test.ts` calls.
mkdirSync(join(directory, 'node_modules', '@lostgradient'), { recursive: true });
symlinkSync(
  join(repositoryRoot, 'internal', 'component-tooling'),
  join(directory, 'node_modules', '@lostgradient', 'component-tooling'),
  'dir',
);
const results: Awaited<ReturnType<typeof run>>[] = [];
for (const script of ['lint', 'typecheck', 'test']) results.push(await run(script, directory));

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('create-package demo', () => {
  test('writes every file of a family package', () => {
    expect(written.toSorted()).toEqual(
      Object.keys(packageFiles('demo'))
        .map((path) => `components/demo/${path}`)
        .toSorted(),
    );
  });

  test("the new package's lint, type-check and test exit 0", () => {
    expect(results).toEqual([
      { script: 'lint', exitCode: 0, output: '' },
      { script: 'typecheck', exitCode: 0, output: '' },
      { script: 'test', exitCode: 0, output: '' },
    ]);
  });

  test('refuses to overwrite a package that exists', () => {
    expect(() => createPackage(root, 'demo')).toThrow('already exist');
  });

  test('refuses a name that is not kebab-case', () => {
    expect(() => createPackage(root, 'Demo Package')).toThrow('not a kebab-case');
  });
});
