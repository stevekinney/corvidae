#!/usr/bin/env bun
// Chef targeted run: builds, validates and dispatches `targeted-checks.yml` for a correction round,
// so a mistyped fixture slug or spec path is refused here, with the valid choices listed, instead
// of after a runner has started. With no input given, it derives each one from
// `git diff --name-only origin/main...HEAD`:
//
//   fixture components  `components/cinder/src/components/<slug>/...`, `components/chat/src/lib/
//                       components/<slug>/...` and `scripts/browser-fixtures/src/fixtures/<slug>.svelte`
//                       whose slug is in the fixture manifest
//   fixture specs       `scripts/browser-fixtures/tests/*.playwright.ts`
//   e2e specs           `applications/interborough/tests/e2e/*.spec.ts`, as `tests/e2e/*.spec.ts`
//   unit files          `*.test.ts` files of the one workspace holding the most of them
//
// The valid slugs are the ones `components.playwright.ts` accepts: the manifest's, which are the
// directories of `*/*-fixtures.ts` under the fixture roots plus the declared application fixtures.
// The slug check is the workflow's own `parseComponentFilter`.
//
// Usage:
//   bun scripts/chef/targeted-run.ts [--ref <branch>] [--fixture-components a,b]
//       [--fixture-spec <path>]... [--e2e-spec <path>]... [--unit-workspace <dir>]
//       [--unit-path <path>]... [--unit-config <file>] [--dry-run] [--json]
//
// Without `--dry-run` it dispatches the workflow, once, on `--ref` (default: the current branch).
// A newer dispatch on a ref cancels the older one. Exit codes: 0 dispatched (or printed), 2 invalid
// input, with nothing dispatched.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseComponentFilter } from '../../testing/testing/src/helpers/component-filter.ts';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  type Runner,
  shellQuote,
  UsageError,
} from './process-runner.ts';

export { UsageError };

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..');
const FIXTURE_SPEC = /^scripts\/browser-fixtures\/tests\/[\w.-]+\.playwright\.ts$/;
const E2E_SPEC = /^tests\/e2e\/[\w.-]+\.spec\.ts$/;
const WORKSPACE = /^(applications|components|packages|plugins|testing|internal)\/[\w.-]+$/;
const SAFE_PATH = /^[\w@./-]+$/;
const COMPONENT_DIRECTORIES = [
  /^components\/cinder\/src\/components\/([\w-]+)\//,
  /^components\/chat\/src\/lib\/components\/([\w-]+)\//,
  /^scripts\/browser-fixtures\/src\/fixtures\/([\w-]+)\.svelte$/,
];

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
}

/** The slugs `components.playwright.ts` accepts, without running the manifest's extraction. */
export function manifestSlugs(): ReadonlySet<string> {
  const slugs = new Set<string>();
  for (const root of ['components/cinder/src/components', 'components/chat/src/lib/components']) {
    const cwd = resolve(REPOSITORY_ROOT, root);
    if (!existsSync(cwd)) continue;
    for (const path of new Bun.Glob('*/*-fixtures.ts').scanSync({ cwd }))
      slugs.add(path.split('/')[0] ?? '');
  }
  const declarations = readAppFixtureSlugs();
  for (const slug of declarations) slugs.add(slug);
  return slugs;
}

function readAppFixtureSlugs(): string[] {
  const source = new Bun.Glob('src/app-fixture-declarations.ts').scanSync({
    cwd: resolve(REPOSITORY_ROOT, 'scripts/browser-fixtures'),
    absolute: true,
  });
  const [path] = [...source];
  if (path === undefined) return [];
  const text = readFileSync(path, 'utf8');
  // Keys of the declaration object: `name: [` or `'name': [`, one per line.
  return [...text.matchAll(/^\s*(?:'([\w-]+)'|([\w-]+)):\s*[\w[]/gmu)].map(
    (match) => match[1] ?? match[2] ?? '',
  );
}

/** The inputs a branch's changed files reach; unknown component directories are left out. */
export function deriveInputs(changed: string[], known: ReadonlySet<string>): TargetedInputs {
  const slugs = new Set<string>();
  const fixtureSpecs: string[] = [];
  const e2eSpecs: string[] = [];
  const unitByWorkspace = new Map<string, string[]>();
  for (const file of changed) {
    for (const pattern of COMPONENT_DIRECTORIES) {
      const slug = pattern.exec(file)?.[1];
      if (slug !== undefined && known.has(slug)) slugs.add(slug);
    }
    if (FIXTURE_SPEC.test(file)) fixtureSpecs.push(file);
    const e2e = /^applications\/interborough\/(tests\/e2e\/[\w.-]+\.spec\.ts)$/.exec(file)?.[1];
    if (e2e !== undefined) e2eSpecs.push(e2e);
    const unit =
      /^((?:applications|components|packages|plugins|testing|internal)\/[\w.-]+)\/(.+\.test\.ts)$/.exec(
        file,
      );
    if (unit?.[1] !== undefined && unit[2] !== undefined)
      unitByWorkspace.set(unit[1], [...(unitByWorkspace.get(unit[1]) ?? []), unit[2]]);
  }
  let unitWorkspace = '';
  let unitPaths: string[] = [];
  for (const [workspace, paths] of unitByWorkspace)
    if (paths.length > unitPaths.length) {
      unitWorkspace = workspace;
      unitPaths = paths;
    }
  return {
    fixtureComponents: [...slugs].toSorted(),
    fixtureSpecs,
    e2eSpecs,
    unitWorkspace,
    unitPaths,
    unitConfig: '',
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
  if (
    inputs.unitConfig !== '' &&
    (!SAFE_PATH.test(inputs.unitConfig) ||
      !dependencies.exists(`${inputs.unitWorkspace}/${inputs.unitConfig}`))
  )
    problems.push(`Unit config '${inputs.unitConfig}' does not exist in ${inputs.unitWorkspace}.`);
  return problems;
}

/** The `gh workflow run` command for `inputs`; only inputs that name something are passed. */
export function buildCommand(ref: string, inputs: TargetedInputs): string[] {
  const command = ['gh', 'workflow', 'run', 'targeted-checks.yml', '--ref', ref];
  const add = (name: string, value: string): void => {
    if (value !== '') command.push('-f', `${name}=${value}`);
  };
  add('fixture_components', inputs.fixtureComponents.join(','));
  add('fixture_specs', inputs.fixtureSpecs.join(' '));
  add('e2e_specs', inputs.e2eSpecs.join(' '));
  add('unit_workspace', inputs.unitWorkspace);
  add('unit_paths', inputs.unitPaths.join(' '));
  add('unit_config', inputs.unitConfig);
  return command;
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
    knownSlugs: manifestSlugs,
  },
): { code: number; output: string } {
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
  const inputs = given
    ? explicit
    : {
        ...deriveInputs(
          git(runner, ['diff', '--name-only', 'origin/main...HEAD']).split('\n').filter(Boolean),
          dependencies.knownSlugs(),
        ),
        unitConfig: explicit.unitConfig,
      };
  const ref = parsed.values['ref'] ?? git(runner, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!/^[\w./-]+$/.test(ref)) throw new UsageError(`'${ref}' is not a branch name.`);
  const problems = validateInputs(inputs, dependencies);
  if (problems.length > 0) throw new UsageError(problems.join('\n'));
  const command = buildCommand(ref, inputs);
  // With no input the run is the `checks` job alone: lint and type-check of the changed workspaces.
  const note =
    command.length === 6
      ? '\n# No fixture, spec or unit test file to run: only lint and type-check of the changed workspaces will.'
      : '';
  const text = command.map(shellQuote).join(' ') + note;
  if (!parsed.flags.has('dry-run')) {
    const result = runner(command);
    if (result.code !== 0)
      throw new UsageError(`gh workflow run failed: ${result.stderr.trim().split('\n')[0] ?? ''}`);
  }
  return {
    code: 0,
    output: parsed.flags.has('json') ? JSON.stringify({ ref, inputs, command }) : text,
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
