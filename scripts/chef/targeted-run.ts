#!/usr/bin/env bun
// Chef targeted run: builds, validates and dispatches `targeted-checks.yml` for a correction round,
// so a mistyped fixture slug or spec path is refused here, with the valid choices listed, instead
// of after a runner has started. With no input given, it derives each one from
// `git diff --name-only origin/main...HEAD` through the evidence plan (`evidence-plan.ts`):
//
//   fixture components  every manifest slug on a token change, otherwise the changed components'
//   fixture specs       specs that name a changed component, and changed specs
//   e2e specs           specs that reference a changed route or test id, or the whole Interborough
//                       suite for a Cinder change, as `tests/e2e/*.spec.ts`
//   unit files          the selected test files of one workspace: Cinder's when it has any, else
//                       the busiest; the plan's other unit tests are listed on stderr, because the
//                       workflow runs one workspace
//
// The valid slugs are the ones `components.playwright.ts` accepts: the generated manifest's, which
// this script regenerates first with `prepare-manifest.ts`. The slug check is the workflow's own
// `parseComponentFilter`.
//
// Usage:
//   bun scripts/chef/targeted-run.ts [--ref <branch>] [--fixture-components a,b]
//       [--fixture-spec <path>]... [--e2e-spec <path>]... [--unit-workspace <dir>]
//       [--unit-path <path>]... [--unit-config <file>] [--dry-run] [--json]
//
// Without `--dry-run` it dispatches the workflow, once, on `--ref` (default: the current branch).
// A plan that sets `requires_full_run` (a one-way door, the whole Interborough suite, or every
// fixture slug: none fits a targeted job's 30 minutes) dispatches `main.yml`, the sharded full run,
// instead, and says so; this script is the one dispatcher of `main.yml` on a branch. Explicit
// inputs always dispatch `targeted-checks.yml`. A newer dispatch on a ref cancels the older one.
// With `--json` it prints
// `{ ref, inputs, command, requiresFullRun }`; `requiresFullRun` is the plan's full-run flag
// (one-way doors and whole-suite plans), computed the same way for explicit inputs. Exit codes: 0 dispatched (or printed), 2 invalid input,
// with nothing dispatched.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseComponentFilter } from '../../testing/testing/src/helpers/component-filter.ts';
import {
  changedFiles,
  preparedSlugs,
  REPOSITORY_ROOT,
  repositoryContext,
} from './evidence-plan.ts';
import { landingPlan } from './landing-plan.ts';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  type Runner,
  shellQuote,
  UsageError,
} from './process-runner.ts';
import {
  computeEvidencePlan,
  type EvidenceContext,
  type EvidencePlan,
  oneWayDoorMatches,
  wholeSuiteMatches,
} from './verification-plan.ts';

export { UsageError };

const FIXTURE_SPEC = /^scripts\/browser-fixtures\/tests\/[\w.-]+\.playwright\.ts$/;
const E2E_SPEC = /^tests\/e2e\/[\w.-]+\.spec\.ts$/;
const WORKSPACE = /^(applications|components|packages|plugins|testing|internal)\/[\w.-]+$/;
const SAFE_PATH = /^[\w@./-]+$/;
/**
 * The most characters the unit paths take in one dispatch. GitHub caps all of a dispatch's inputs at
 * 65,535 characters together, and the e2e and fixture inputs of a Cinder change take about 10,000.
 */
const UNIT_PATH_BUDGET = 30_000;

/**
 * The test paths as the unit input: each file, or, when they would not fit one dispatch, the
 * folders holding them. `bun test` takes a path as a filter, so a folder runs every file in it; the
 * selection only ever grows, and no file outside a named folder is dropped.
 */
export function fitUnitPaths(paths: readonly string[]): string[] {
  const fits = (candidate: readonly string[]) => candidate.join(' ').length <= UNIT_PATH_BUDGET;
  if (fits(paths)) return [...paths];
  // A file at the workspace root stays named: an empty folder would match every test.
  const within = (path: string, depth: number) => {
    const parts = path.split('/');
    return parts.length <= 1
      ? path
      : `${parts.slice(0, Math.min(depth, parts.length - 1)).join('/')}/`;
  };
  const folders = [...new Set(paths.map((path) => within(path, Number.MAX_SAFE_INTEGER)))];
  if (fits(folders)) return folders.toSorted();
  return [...new Set(paths.map((path) => within(path, 2)))].toSorted();
}

export interface TargetedInputs {
  fixtureComponents: string[];
  fixtureSpecs: string[];
  e2eSpecs: string[];
  unitWorkspace: string;
  unitPaths: string[];
  unitConfig: string;
}

export interface TargetedDependencies {
  runner: Runner;
  /** Whether a path exists, from the repository root. */
  exists: (path: string) => boolean;
  /** The slugs the fixture manifest holds. */
  knownSlugs: () => ReadonlySet<string>;
  /** The repository's files and unit-test selection, for the evidence plan. */
  context: (known: ReadonlySet<string>) => EvidenceContext;
}

/**
 * The bunfig a unit test file runs under, as its workspace's `test` script runs it. Interborough
 * runs `src/host` and `fixtures` under the default bunfig and every other test under
 * `bunfig.ui.toml`, whose preload compiles Svelte and sets up the DOM.
 */
export function unitConfigFor(workspace: string, path: string): string {
  if (workspace !== 'applications/interborough') return '';
  return /^(src\/host|fixtures)\//.test(path) ? '' : './bunfig.ui.toml';
}

/**
 * The workflow inputs an evidence plan maps to, and the unit tests it cannot carry. The workflow
 * runs one workspace and one bunfig, so Cinder's lane wins when the plan has one (its top-level
 * tests are the ones the import graph misses), otherwise the busiest; Interborough's host and UI
 * tests never share a run. A workspace with no test script of its own (the root) has no lane.
 */
export function inputsFromPlan(plan: EvidencePlan): {
  inputs: TargetedInputs;
  uncovered: string[];
} {
  const lanes = plan.unit_tests.flatMap((lane) => {
    if (lane.workspace === '' || !WORKSPACE.test(lane.workspace)) return [];
    if (lane.workspace !== 'applications/interborough')
      return [{ workspace: lane.workspace, config: '', full: lane.full, paths: lane.paths }];
    const ui = lane.paths.filter((path) => unitConfigFor(lane.workspace, path) !== '');
    const host = lane.paths.filter((path) => unitConfigFor(lane.workspace, path) === '');
    return [
      { workspace: lane.workspace, config: './bunfig.ui.toml', full: lane.full, paths: ui },
      { workspace: lane.workspace, config: '', full: false, paths: host },
    ].filter((candidate) => candidate.paths.length > 0);
  });
  const size = (lane: (typeof lanes)[number]) => lane.paths.length;
  const chosen = [...lanes].toSorted((a, b) => {
    const cinder =
      Number(b.workspace === 'components/cinder') - Number(a.workspace === 'components/cinder');
    return cinder === 0 ? size(b) - size(a) : cinder;
  })[0];
  const uncovered: string[] = [];
  for (const lane of plan.unit_tests) {
    const left = lane.paths.filter(
      (path) =>
        !(
          chosen !== undefined &&
          lane.workspace === chosen.workspace &&
          chosen.paths.includes(path)
        ),
    );
    if (left.length > 0)
      uncovered.push(
        `${lane.workspace === '' ? 'root' : lane.workspace}: ${left.length} test files`,
      );
  }
  return {
    inputs: {
      fixtureComponents: plan.fixture_slugs,
      fixtureSpecs: plan.fixture_specs,
      e2eSpecs: plan.e2e_specs,
      unitWorkspace: chosen?.workspace ?? '',
      unitPaths: chosen === undefined ? [] : fitUnitPaths(chosen.paths),
      unitConfig: chosen?.config ?? '',
    },
    uncovered,
  };
}

/** Every problem with `inputs`, each naming what the workflow accepts; empty when all is valid. */
export function validateInputs(
  inputs: TargetedInputs,
  dependencies: TargetedDependencies,
): string[] {
  const problems: string[] = [];
  const known = dependencies.knownSlugs();
  try {
    parseComponentFilter(inputs.fixtureComponents.join(','), known);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  for (const spec of inputs.fixtureSpecs)
    if (!FIXTURE_SPEC.test(spec) || !dependencies.exists(spec))
      problems.push(
        `Fixture spec '${spec}' must be an existing scripts/browser-fixtures/tests/<name>.playwright.ts.`,
      );
  for (const spec of inputs.e2eSpecs)
    if (!E2E_SPEC.test(spec) || !dependencies.exists(`applications/interborough/${spec}`))
      problems.push(
        `End-to-end spec '${spec}' must be an existing tests/e2e/<name>.spec.ts in applications/interborough.`,
      );
  if (inputs.unitWorkspace !== '' || inputs.unitPaths.length > 0) {
    if (
      !WORKSPACE.test(inputs.unitWorkspace) ||
      !dependencies.exists(`${inputs.unitWorkspace}/package.json`)
    )
      problems.push(
        `Unit workspace '${inputs.unitWorkspace}' must be a workspace folder such as components/cinder.`,
      );
    else if (inputs.unitPaths.length === 0)
      problems.push('A unit workspace needs at least one --unit-path.');
    for (const path of inputs.unitPaths)
      if (!SAFE_PATH.test(path) || !dependencies.exists(`${inputs.unitWorkspace}/${path}`))
        problems.push(`Unit path '${path}' does not exist in ${inputs.unitWorkspace}.`);
  }
  if (inputs.unitConfig !== '' && inputs.unitWorkspace === '')
    problems.push(`Unit config '${inputs.unitConfig}' needs --unit-workspace to say whose it is.`);
  else if (
    inputs.unitConfig !== '' &&
    (!SAFE_PATH.test(inputs.unitConfig) ||
      !dependencies.exists(`${inputs.unitWorkspace}/${inputs.unitConfig}`))
  )
    problems.push(`Unit config '${inputs.unitConfig}' does not exist in ${inputs.unitWorkspace}.`);
  return problems;
}

/** The `gh workflow run` command for `inputs`; only inputs that name something are passed. */
export function buildCommand(ref: string, inputs: TargetedInputs, planDigest = ''): string[] {
  const command = ['gh', 'workflow', 'run', 'targeted-checks.yml', '--ref', ref];
  const add = (name: string, value: string): void => {
    if (value !== '') command.push('-f', `${name}=${value}`);
  };
  // The run's name carries this digest; landing (`landing-evidence.ts`) accepts the run as coverage
  // only for the plan it computes itself from the same diff (`landing-plan.ts`).
  add('plan_digest', planDigest);
  add('fixture_components', inputs.fixtureComponents.join(','));
  add('fixture_specs', inputs.fixtureSpecs.join(' '));
  add('e2e_specs', inputs.e2eSpecs.join(' '));
  add('unit_workspace', inputs.unitWorkspace);
  add('unit_paths', inputs.unitPaths.join(' '));
  add('unit_config', inputs.unitConfig);
  return command;
}

/** The full sharded run. A plan that requires one dispatches this, never `targeted-checks.yml`. */
export function buildFullRunCommand(ref: string): string[] {
  return ['gh', 'workflow', 'run', 'main.yml', '--ref', ref];
}

function emptyInputs(): TargetedInputs {
  return {
    fixtureComponents: [],
    fixtureSpecs: [],
    e2eSpecs: [],
    unitWorkspace: '',
    unitPaths: [],
    unitConfig: '',
  };
}

function git(runner: Runner, args: string[]): string {
  const result = runner(['git', ...args]);
  if (result.code !== 0)
    throw new UsageError(
      `git ${args[0] ?? ''} failed: ${result.stderr.trim().split('\n')[0] ?? ''}`,
    );
  return result.stdout.trim();
}

export function run(
  argv: string[],
  dependencies: TargetedDependencies = {
    runner: defaultRunner,
    exists: (path) => existsSync(resolve(REPOSITORY_ROOT, path)),
    knownSlugs: () => preparedSlugs(defaultRunner),
    context: (known) => repositoryContext(REPOSITORY_ROOT, known),
  },
): { code: number; output: string; notes: string[] } {
  const parsed = parseOptions(argv, {
    values: ['ref', 'fixture-components', 'unit-workspace', 'unit-config'],
    repeated: ['fixture-spec', 'e2e-spec', 'unit-path'],
    flags: ['dry-run', 'json'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError('targeted-run.ts takes options only; see its header.');
  const { runner } = dependencies;
  const explicit: TargetedInputs = {
    fixtureComponents: (parsed.values['fixture-components'] ?? '')
      .split(',')
      .map((slug) => slug.trim())
      .filter((slug) => slug !== ''),
    fixtureSpecs: parsed.repeated['fixture-spec'] ?? [],
    e2eSpecs: parsed.repeated['e2e-spec'] ?? [],
    unitWorkspace: parsed.values['unit-workspace'] ?? '',
    unitPaths: parsed.repeated['unit-path'] ?? [],
    unitConfig: parsed.values['unit-config'] ?? '',
  };
  const given =
    explicit.fixtureComponents.length +
      explicit.fixtureSpecs.length +
      explicit.e2eSpecs.length +
      explicit.unitPaths.length >
    0;
  // A deleted file has nothing to run, so the plan reads only files the branch keeps.
  const changed = changedFiles(runner, 'origin/main');
  const notes: string[] = [];
  let inputs = explicit;
  let requiresFullRun = [...oneWayDoorMatches(changed), ...wholeSuiteMatches(changed)];
  let fullDispatch = false;
  if (!given) {
    const plan = computeEvidencePlan(changed, dependencies.context(dependencies.knownSlugs()));
    requiresFullRun = plan.full_run_rules;
    // A plan that needs a one-way-door check, the whole Interborough suite or every fixture slug
    // does not fit the targeted workflow's single jobs: the sharded `main.yml` runs it.
    fullDispatch = plan.requires_full_run;
    const mapped = inputsFromPlan(plan);
    inputs = fullDispatch
      ? emptyInputs()
      : explicit.unitConfig === ''
        ? mapped.inputs
        : { ...mapped.inputs, unitConfig: explicit.unitConfig };
    if (!fullDispatch)
      for (const left of mapped.uncovered)
        notes.push(`the plan requires ${left} the workflow cannot run in one dispatch`);
  }
  const ref = parsed.values['ref'] ?? git(runner, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!/^[\w./-]+$/.test(ref)) throw new UsageError(`'${ref}' is not a branch name.`);
  const problems = validateInputs(inputs, dependencies);
  if (problems.length > 0) throw new UsageError(problems.join('\n'));
  // The digest names the diff with every status, deletions included, as landing reads it.
  const planDigest = landingPlan(
    git(runner, ['diff', '--name-only', 'origin/main...HEAD']).split('\n').filter(Boolean),
  ).digest;
  const command = fullDispatch ? buildFullRunCommand(ref) : buildCommand(ref, inputs, planDigest);
  // With no input the run is the `checks` job alone: lint and type-check of the changed workspaces.
  const note = fullDispatch
    ? '\n# Dispatching main.yml, the full sharded run, because the plan requires one (rules below).'
    : command.length === 8
      ? '\n# No fixture, spec or unit test file to run: only lint and type-check of the changed workspaces will.'
      : '';
  const fullRun =
    requiresFullRun.length === 0
      ? '\n# requires_full_run: false'
      : `\n# requires_full_run: true\n${requiresFullRun.map(({ path, rule }) => `#   ${path}: ${rule}`).join('\n')}`;
  const text = command.map(shellQuote).join(' ') + note + fullRun;
  if (!parsed.flags.has('dry-run')) {
    const result = runner(command);
    if (result.code !== 0)
      throw new UsageError(`gh workflow run failed: ${result.stderr.trim().split('\n')[0] ?? ''}`);
  }
  return {
    code: 0,
    output: parsed.flags.has('json')
      ? JSON.stringify({ ref, inputs, command, requiresFullRun: requiresFullRun.length > 0 })
      : text,
    notes,
  };
}

if (import.meta.main) {
  try {
    const { code, output, notes } = run(Bun.argv.slice(2));
    for (const note of notes) process.stderr.write(`targeted-run: ${note}\n`);
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
