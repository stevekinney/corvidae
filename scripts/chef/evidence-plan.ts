#!/usr/bin/env bun
// Chef evidence plan: the evidence a branch must carry, computed from `git diff` and never named by
// a model. `computeEvidencePlan` (verification-plan.ts) is the rule; this script wires it to the
// repository: the unit-test selection of `scripts/affected-tests.ts` (consumers included), the
// fixture manifest's slugs, and the files of the working tree.
//
// Usage:
//   bun scripts/chef/evidence-plan.ts [--base origin/main] [--changed-from <file>] [--json]
//
// The changed files are `git diff --name-only --diff-filter=d <base>...HEAD`, or the lines of
// `--changed-from` (a replay of an earlier landing). The plan lists unit tests, `lint:root` and
// `typecheck:root`, fixture slugs and specs, and Interborough end-to-end specs, and sets
// `requires_full_run` for a one-way-door path, naming the rule each one matched. Exit codes: 0 plan
// printed, 2 invalid input.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadManifest } from '../../testing/testing/src/helpers/manifest.ts';
import { selectTests } from '../affected-tests-selection.ts';
import { discoverWorkspaces, listTree } from '../affected-tests.ts';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  type Runner,
  UsageError,
} from './process-runner.ts';
import {
  computeEvidencePlan,
  type EvidenceContext,
  type EvidencePlan,
  type UnitSelection,
} from './verification-plan.ts';

export { UsageError };

export const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * Where `scripts/browser-fixtures/scripts/prepare-manifest.ts` writes the root suite's manifest
 * (`defaultManifestLayout.outputDirectory`), which `components.playwright.ts` reads its slugs from.
 */
export const MANIFEST_PATH = resolve(
  REPOSITORY_ROOT,
  'scripts/browser-fixtures/.playwright/manifest.json',
);

/**
 * The slugs `components.playwright.ts` accepts: the generated manifest's own entries, never a copy
 * of the layout's fixture roots, which went stale when a package moved its fixtures.
 */
export function manifestSlugs(path = MANIFEST_PATH): ReadonlySet<string> {
  return new Set(loadManifest(path).map((entry) => entry.slug));
}

/** Regenerates the manifest (a no-op when its inputs are unchanged), then reads its slugs. */
export function preparedSlugs(runner: Runner): ReadonlySet<string> {
  const result = runner(['bun', 'scripts/browser-fixtures/scripts/prepare-manifest.ts']);
  if (result.code !== 0)
    throw new UsageError(
      `prepare-manifest.ts failed: ${result.stderr.trim().split('\n')[0] ?? ''}`,
    );
  return manifestSlugs();
}

/** The repository's files and unit-test selection, read from `root`. */
export function repositoryContext(root: string, knownSlugs: ReadonlySet<string>): EvidenceContext {
  const workspaces = discoverWorkspaces(root);
  const tree = listTree(root);
  return {
    knownSlugs,
    paths: tree.paths,
    read: (path) => tree.read(path),
    selectUnitTests: (changed): UnitSelection[] =>
      selectTests({ changed: [...changed], tree, workspaces })
        .workspaces.filter((selection) => selection.mode !== 'none')
        .map((selection) => ({
          directory: selection.directory,
          mode: selection.mode === 'full' ? 'full' : 'partial',
          tests: [...selection.tests.keys()],
        })),
  };
}

/** The branch's changed files that still exist: a deleted file has nothing to run. */
export function changedFiles(runner: Runner, base: string): string[] {
  const result = runner(['git', 'diff', '--name-only', '--diff-filter=d', `${base}...HEAD`]);
  if (result.code !== 0)
    throw new UsageError(`git diff failed: ${result.stderr.trim().split('\n')[0] ?? ''}`);
  return result.stdout.split('\n').filter(Boolean);
}

/** The plan as lines: what to run, then the full-run rules. */
export function formatPlan(plan: EvidencePlan): string {
  const lines = [
    `changed files: ${plan.changed.length}`,
    `required: ${plan.root_checks.join(', ')}`,
  ];
  for (const lane of plan.unit_tests)
    lines.push(
      `unit tests ${lane.workspace === '' ? '(root)' : lane.workspace}: ${lane.full ? 'whole suite, ' : ''}${lane.paths.length} files`,
    );
  lines.push(`fixture slugs: ${plan.fixture_slugs.length}`);
  lines.push(`fixture specs: ${plan.fixture_specs.join(' ') || 'none'}`);
  lines.push(`e2e specs: ${plan.e2e_specs.length}`);
  lines.push(`requires_full_run: ${plan.requires_full_run}`);
  for (const { rule, path } of plan.full_run_rules) lines.push(`  ${path}: ${rule}`);
  return lines.join('\n');
}

export interface EvidencePlanDependencies {
  runner: Runner;
  context: (knownSlugs: ReadonlySet<string>) => EvidenceContext;
  knownSlugs: () => ReadonlySet<string>;
  readLines: (path: string) => string[];
}

export function run(
  argv: string[],
  dependencies: EvidencePlanDependencies = {
    runner: defaultRunner,
    context: (known) => repositoryContext(REPOSITORY_ROOT, known),
    knownSlugs: () => preparedSlugs(defaultRunner),
    readLines: (path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line !== ''),
  },
): { code: number; output: string } {
  const parsed = parseOptions(argv, { values: ['base', 'changed-from'], flags: ['json'] });
  if (parsed.positionals.length > 0)
    throw new UsageError('evidence-plan.ts takes options only; see its header.');
  const from = parsed.values['changed-from'];
  const changed =
    from === undefined
      ? changedFiles(dependencies.runner, parsed.values['base'] ?? 'origin/main')
      : dependencies.readLines(from);
  const plan = computeEvidencePlan(changed, dependencies.context(dependencies.knownSlugs()));
  return {
    code: 0,
    output: parsed.flags.has('json') ? JSON.stringify(plan) : formatPlan(plan),
  };
}

if (import.meta.main) {
  try {
    const { code, output } = run(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
