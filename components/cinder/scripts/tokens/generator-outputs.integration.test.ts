/**
 * The token generator's outputs stay out of version control: every Cinder commit that changes a
 * token regenerates them, so tracking them made each such commit re-add files a branch that moved or
 * deleted them (CS:20). `prepare` and the `metadata` task generate them instead. The tracked token
 * files that remain are inputs or hand-maintained: the corpus sources (`sets/`, `themes/`), the
 * resolver, `index.json` (a published export) and `documentation/tokens.md` (partly authored, and
 * read back by the generator).
 *
 * Runs `git` as a subprocess, so this is an integration test.
 */

import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { expect, test } from 'bun:test';
import { join, relative } from 'node:path';

import { RESOLVED_CONTEXT_COMBOS } from '../../src/tokens/runtime/context-order.ts';
import { baseCorpusMetadataPath, packageVersionPath } from './base-corpus-metadata.ts';
import {
  authoringCataloguePath,
  packageRoot,
  registryJsonPath,
  registryModulePath,
  resolvedDirectory,
  tokensBaseCssPath,
} from './generator-configuration.ts';
import { buildSchemaValidatorOutputs } from './schema-validators.ts';

const generatorOutputs = [
  tokensBaseCssPath,
  registryJsonPath,
  registryModulePath,
  authoringCataloguePath,
  baseCorpusMetadataPath,
  packageVersionPath,
  ...RESOLVED_CONTEXT_COMBOS.map(({ name }) => join(resolvedDirectory, `${name}.json`)),
  ...buildSchemaValidatorOutputs().keys(),
].map((path) => relative(packageRoot, path));

async function git(args: string[]): Promise<{ stdout: string; code: number }> {
  const child = spawnWithHangGuard(['git', ...args], {
    cwd: packageRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { stdout, code };
}

test('the generator names the outputs this test covers', () => {
  expect(generatorOutputs.length).toBeGreaterThanOrEqual(13);
});

test('git ls-files lists none of the token generator outputs', async () => {
  const { stdout } = await git(['ls-files', '--', ...generatorOutputs]);
  expect(stdout.split('\n').filter(Boolean)).toEqual([]);
});

test('every token generator output is ignored by git', async () => {
  for (const path of generatorOutputs) {
    const { code } = await git(['check-ignore', '--quiet', '--no-index', path]);
    expect(code, `${path} is not ignored`).toBe(0);
  }
});
