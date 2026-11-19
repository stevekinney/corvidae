/**
 * The token generator's outputs stay out of version control: every Cinder commit that changes a
 * token regenerates them, so tracking them made each such commit re-add files a branch that moved or
 * deleted them (CS:20). There is no `prepare` or install step, because
 * `workspace-contract.integration.test.ts` forbids install lifecycle scripts in every workspace.
 * The `metadata` task generates them (Turborepo runs it before every consumer), and
 * `scripts/ensure-cinder-generated.ts` does the same for paths that bypass Turbo. The outputs that
 * stay tracked are named by `isVersionControlledOutput`: the token sources the generator normalizes
 * and `documentation/tokens.md`, whose authored sections it reads back.
 *
 * The list comes from the generator itself (`generate-artifacts.ts --list`), never from a copy
 * kept here, so a new output is covered the day it exists. Runs `bun` and `git` as subprocesses,
 * so this is an integration test (and `bun` for the same `--conditions` reason as
 * `generate-artifacts-check.integration.test.ts`).
 */

import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { CINDER_GENERATED_OUTPUTS } from '../../../../scripts/ensure-cinder-generated.ts';
import { isVersionControlledOutput, packageRoot } from './generator-configuration.ts';

async function command(args: string[]): Promise<{ stdout: string; code: number }> {
  const child = spawnWithHangGuard(args, { cwd: packageRoot, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { stdout, code };
}

const listed = await command([
  'bun',
  join(packageRoot, 'scripts/tokens/generate-artifacts.ts'),
  '--list',
]);
const allOutputs = listed.stdout.split('\n').filter(Boolean);
const ignoredOutputs = allOutputs.filter(
  (path) => !isVersionControlledOutput(join(packageRoot, path)),
);

// Both git commands run at module scope, like the generator above, and the tests assert on the result.
const tracked = await command(['git', 'ls-files', '--', ...ignoredOutputs]);
// `--no-index` asks the ignore rules alone, so the answer does not depend on what is tracked.
const ignored = await command(['git', 'check-ignore', '--no-index', '--', ...ignoredOutputs]);

test('the generator lists its outputs, and most of them are ignored', () => {
  expect(listed.code).toBe(0);
  expect(allOutputs).toContain('documentation/tokens.md');
  expect(allOutputs).toContain('src/tokens/index.json');
  expect(ignoredOutputs).toContain('src/styles/tokens-base.css');
  expect(ignoredOutputs).toContain('src/tokens/runtime/format-validator.generated.js');
  expect(ignoredOutputs.length).toBeGreaterThanOrEqual(14);
});

test('git ls-files lists none of the token generator outputs that are not version controlled', () => {
  expect(tracked.stdout.split('\n').filter(Boolean)).toEqual([]);
});

test('ensureCinderGenerated watches every output the generator writes', () => {
  expect(
    ignoredOutputs.filter((path) => !CINDER_GENERATED_OUTPUTS.includes(path)),
    'add the output to CINDER_GENERATED_OUTPUTS in scripts/ensure-cinder-generated.ts',
  ).toEqual([]);
});

test('every such output is ignored by git', () => {
  expect(ignored.stdout.split('\n').filter(Boolean).toSorted()).toEqual(ignoredOutputs.toSorted());
});
