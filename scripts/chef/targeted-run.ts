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
//   unit lanes          every lane of the plan (a workspace, its test files, its bunfig; the root,
//                       workspace `.`, runs its `scripts/` files through `bun scripts/bun-test.ts`),
//                       sent as the `unit_lanes` JSON list the workflow runs as a matrix. Files
//                       become folders when they exceed the input limit; a plan that still does
//                       not fit, or wants a whole suite, sets `requires_full_run` under the rule
//                       "plan exceeds one targeted dispatch" and dispatches `main.yml`: nothing is
//                       dropped, and only a plan dispatched whole carries a `plan_digest`
//
// The valid slugs are the ones `components-sweep.playwright.ts` accepts: the generated manifest's, which
// this script regenerates first with `prepare-manifest.ts`. The slug check is the workflow's own
// `parseComponentFilter`.
//
// Usage:
//   bun scripts/chef/targeted-run.ts [--ref <branch>] [--fixture-components a,b]
//       [--fixture-spec <path>]... [--e2e-spec <path>]... [--unit-workspace <dir>]
//       [--unit-path <path>]... [--unit-config <file>] [--dry-run] [--json]
//       [--approve <file> --head <sha> --review-ref <reference> | --decision <file> |
//        --required-check <criterion> --head <sha>]
//   bun scripts/chef/targeted-run.ts --ref <branch> --verification-request <key>
//       --verification-plan <sha256> --verification-base <sha> [--dry-run] [--json]
//
// The second form dispatches the one `main.yml` run a delivery request binds: the three inputs are
// the ones `ci-evidence-github.ts` sends and `main.yml` records in its receipt, and the run's name
// becomes `P07 <key>`. It always dispatches `main.yml` whatever the diff, takes no other input, and
// plans nothing. The CLI form previews only. `delivery-request.ts prepare` dispatches it.
//
// Plan with --dry-run. A coordinator records the reviewed plan with
// --approve <new-decision.json> --head <full SHA> --review-ref <local evidence reference>.
// Repeat the same plan arguments with --decision <file> to dispatch.
// Named required checks may instead use --required-check COR-<n>:<criterion> --head <full SHA>
// with explicit lanes. Required full verification uses delivery-request.ts prepare.
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

import { bindCandidateDispatch } from './discretionary-ci-decision.ts';

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
  inputsFromPlan,
  OVERSIZE_RULE,
  type TargetedDependencies,
  type TargetedInputs,
  type UnitLane,
  validateInputs,
} from './targeted-inputs.ts';
import { computeEvidencePlan, oneWayDoorMatches, wholeSuiteMatches } from './verification-plan.ts';

export { UsageError };

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
  // Every lane, as the JSON list the workflow runs as a matrix.
  add('unit_lanes', inputs.unitLanes.length === 0 ? '' : JSON.stringify(inputs.unitLanes));
  return command;
}

/**
 * The identity a delivery request binds to its `main.yml` run: `main.yml`'s three
 * `workflow_dispatch` inputs, which its run name and evidence receipt carry.
 */
export interface VerificationBinding {
  /** `ciEvidenceRequestKey` of the request's CI evidence identity. */
  request: string;
  /** `batchVerificationPlanDigest` of the request's members. */
  plan: string;
  /** The candidate's base commit. */
  base: string;
}

/** Why `binding` is not a well-formed one, or `undefined` when it is. */
function bindingProblem(binding: VerificationBinding): string | undefined {
  if (!/^[0-9a-f]{64}$/.test(binding.request))
    return '--verification-request must be a SHA-256 request key.';
  if (!/^[0-9a-f]{64}$/.test(binding.plan)) return '--verification-plan must be a SHA-256 digest.';
  if (!/^[0-9a-f]{40}$/.test(binding.base)) return '--verification-base must be a commit SHA.';
  return undefined;
}

/**
 * The full sharded run. A plan that requires one dispatches this, never `targeted-checks.yml`. With
 * a binding it carries the three inputs a delivery request pins (`main.yml` `on.workflow_dispatch`).
 */
export function buildFullRunCommand(ref: string, binding?: VerificationBinding): string[] {
  const command = ['gh', 'workflow', 'run', 'main.yml', '--ref', ref];
  if (binding !== undefined)
    command.push(
      '-f',
      `verification_request=${binding.request}`,
      '-f',
      `verification_plan=${binding.plan}`,
      '-f',
      `verification_base=${binding.base}`,
    );
  return command;
}

/**
 * Dispatches the bound `main.yml` run, once. It is the dispatcher `delivery-request.ts` uses.
 * `ci-evidence-github.ts`'s provider `dispatch` sends the same three inputs and is reached only by
 * `ci-evidence-run.ts`; sending one head's run through both would dispatch it twice. Throws a
 * `UsageError` for a malformed binding or a failed dispatch.
 */
export function dispatchVerificationRun(
  runner: Runner,
  ref: string,
  binding: VerificationBinding,
  options: { cwd?: string; dryRun?: boolean } = {},
): { command: string[]; printed: string } {
  const problem = bindingProblem(binding);
  if (problem !== undefined) throw new UsageError(problem);
  if (!/^[\w./-]+$/.test(ref)) throw new UsageError(`'${ref}' is not a branch name.`);
  const command = buildFullRunCommand(ref, binding);
  if (options.dryRun === true) return { command, printed: '' };
  const result = runner(command, options.cwd === undefined ? undefined : { cwd: options.cwd });
  if (result.code !== 0)
    throw new UsageError(`gh workflow run failed: ${result.stderr.trim().split('\n')[0] ?? ''}`);
  return { command, printed: `${result.stdout}${result.stderr}`.trim() };
}

function emptyInputs(): TargetedInputs {
  return {
    fixtureComponents: [],
    fixtureSpecs: [],
    e2eSpecs: [],
    unitLanes: [],
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
    values: [
      'ref',
      'approve',
      'decision',
      'head',
      'review-ref',
      'required-check',
      'fixture-components',
      'unit-workspace',
      'unit-config',
      'verification-request',
      'verification-plan',
      'verification-base',
    ],
    repeated: ['fixture-spec', 'e2e-spec', 'unit-path'],
    flags: ['dry-run', 'json'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError('targeted-run.ts takes options only; see its header.');
  const { runner } = dependencies;
  const dryRun = parsed.flags.has('dry-run');
  const approvalPath = parsed.values['approve'];
  const decisionPath = parsed.values['decision'];
  const expectedHead = parsed.values['head'];
  const reviewReference = parsed.values['review-ref'];
  const requiredCheck = parsed.values['required-check'];
  if (
    dryRun &&
    [approvalPath, decisionPath, expectedHead, reviewReference, requiredCheck].some(
      (value) => value !== undefined,
    )
  )
    throw new UsageError(
      '--dry-run only plans CI. Supply decision options on a separate invocation.',
    );
  if (approvalPath === undefined && reviewReference !== undefined)
    throw new UsageError('--review-ref belongs to --approve.');
  if (approvalPath === undefined && requiredCheck === undefined && expectedHead !== undefined)
    throw new UsageError('--head belongs to --approve or --required-check.');
  const bindingValues = ['verification-request', 'verification-plan', 'verification-base'];
  if (bindingValues.some((name) => parsed.values[name] !== undefined)) {
    if (!dryRun)
      throw new UsageError(
        'Use delivery-request.ts prepare for required, bound Main verification.',
      );
    const ref = parsed.values['ref'];
    const others = [
      'fixture-components',
      'unit-workspace',
      'unit-config',
      'fixture-spec',
      'e2e-spec',
      'unit-path',
    ].filter((name) => parsed.values[name] !== undefined || parsed.repeated[name] !== undefined);
    if (ref === undefined)
      throw new UsageError('--verification-* needs --ref: a bound run is dispatched on a branch.');
    if (bindingValues.some((name) => parsed.values[name] === undefined))
      throw new UsageError(
        '--verification-request, --verification-plan and --verification-base go together.',
      );
    if (others.length > 0)
      throw new UsageError(
        `--verification-* dispatches main.yml and takes no ${others.map((name) => `--${name}`).join(', ')}.`,
      );
    const binding: VerificationBinding = {
      request: parsed.values['verification-request'] ?? '',
      plan: parsed.values['verification-plan'] ?? '',
      base: parsed.values['verification-base'] ?? '',
    };
    const dispatched = dispatchVerificationRun(runner, ref, binding, {
      dryRun: parsed.flags.has('dry-run'),
    });
    return {
      code: 0,
      output: parsed.flags.has('json')
        ? JSON.stringify({
            ref,
            inputs: emptyInputs(),
            command: dispatched.command,
            requiresFullRun: true,
          })
        : dispatched.command.map(shellQuote).join(' ') +
          '\n# Dispatching main.yml, bound to the delivery request (verification inputs above).',
      notes: dispatched.printed === '' ? [] : [`dispatched: ${dispatched.printed.split('\n')[0]}`],
    };
  }
  const explicit: TargetedInputs = {
    fixtureComponents: (parsed.values['fixture-components'] ?? '')
      .split(',')
      .map((slug) => slug.trim())
      .filter((slug) => slug !== ''),
    fixtureSpecs: parsed.repeated['fixture-spec'] ?? [],
    e2eSpecs: parsed.repeated['e2e-spec'] ?? [],
    unitLanes: [],
  };
  // The command line names one unit lane: `--unit-workspace`, its `--unit-path`s and its config.
  const explicitLane: UnitLane = {
    workspace: parsed.values['unit-workspace'] ?? '',
    paths: parsed.repeated['unit-path'] ?? [],
    config: parsed.values['unit-config'] ?? '',
  };
  if (explicitLane.workspace !== '' || explicitLane.paths.length > 0 || explicitLane.config !== '')
    explicit.unitLanes = [explicitLane];
  const given =
    explicit.fixtureComponents.length +
      explicit.fixtureSpecs.length +
      explicit.e2eSpecs.length +
      explicitLane.paths.length >
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
    const mapped = inputsFromPlan(plan);
    // A plan that needs a one-way-door check, the whole Interborough suite or every fixture slug
    // does not fit the targeted workflow's single jobs: the sharded `main.yml` runs it. So does a
    // plan the dispatch would have to truncate: every lane is dispatched, or none is.
    if (mapped.undispatchable.length > 0)
      requiresFullRun = [
        ...requiresFullRun,
        { rule: OVERSIZE_RULE, path: mapped.undispatchable.join('; ') },
      ];
    fullDispatch = plan.requires_full_run || mapped.undispatchable.length > 0;
    inputs = fullDispatch
      ? emptyInputs()
      : explicitLane.config === ''
        ? mapped.inputs
        : {
            ...mapped.inputs,
            unitLanes: mapped.inputs.unitLanes.map((lane) =>
              lane.workspace === '.' ? lane : { ...lane, config: explicitLane.config },
            ),
          };
    if (explicitLane.config !== '' && explicitLane.workspace === '' && fullDispatch)
      notes.push('--unit-config is ignored: the plan dispatches the full run');
  }
  const ref = parsed.values['ref'] ?? git(runner, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!/^[\w./-]+$/.test(ref)) throw new UsageError(`'${ref}' is not a branch name.`);
  const problems = validateInputs(inputs, dependencies);
  if (problems.length > 0) throw new UsageError(problems.join('\n'));
  // The digest names the diff with every status, deletions included, as landing reads it. Only a
  // plan dispatched whole carries one: an explicit selection names no plan, and a plan that does
  // not fit goes to the full run, so no targeted run ever covers a truncated plan.
  const planDigest =
    given || fullDispatch
      ? ''
      : landingPlan(
          git(runner, ['diff', '--name-only', 'origin/main...HEAD']).split('\n').filter(Boolean),
        ).digest;
  const planCommand = fullDispatch
    ? buildFullRunCommand(ref)
    : buildCommand(ref, inputs, planDigest);
  if (requiredCheck !== undefined && (!given || fullDispatch))
    throw new UsageError(
      '--required-check needs an explicitly selected fixture, browser spec or unit test.',
    );
  const command = dryRun
    ? planCommand
    : bindCandidateDispatch({
        runner,
        command: planCommand,
        ref,
        head: git(runner, ['rev-parse', '--verify', 'HEAD']),
        approvalPath,
        decisionPath,
        expectedHead,
        reviewReference,
        requiredCheck,
      });
  // With no input the run is the `checks` job alone: lint and type-check of the changed workspaces.
  const nothingToRun =
    inputs.fixtureComponents.length +
      inputs.fixtureSpecs.length +
      inputs.e2eSpecs.length +
      inputs.unitLanes.length ===
    0;
  const note = fullDispatch
    ? '\n# Dispatching main.yml, the full sharded run, because the plan requires one (rules below).'
    : nothingToRun
      ? '\n# No fixture, spec or unit test file to run: only lint and type-check of the changed workspaces will.'
      : '';
  const fullRun =
    requiresFullRun.length === 0
      ? '\n# requires_full_run: false'
      : `\n# requires_full_run: true\n${requiresFullRun.map(({ path, rule }) => `#   ${path}: ${rule}`).join('\n')}`;
  const text = command.map(shellQuote).join(' ') + note + fullRun;
  if (approvalPath !== undefined) notes.push(`recorded coordinator decision: ${approvalPath}`);
  if (!dryRun && approvalPath === undefined) {
    const result = runner(command);
    if (result.code !== 0)
      throw new UsageError(`gh workflow run failed: ${result.stderr.trim().split('\n')[0] ?? ''}`);
    // What `gh` prints (the run's URL or id) is the receipt a worker records.
    const printed = `${result.stdout}${result.stderr}`.trim();
    if (printed !== '') notes.push(`dispatched: ${printed.split('\n')[0] ?? ''}`);
    if (requiredCheck !== undefined) notes.push(`required check: ${requiredCheck}`);
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
