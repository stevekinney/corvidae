import { parseComponentFilter } from '../../testing/testing/src/helpers/component-filter.ts';
import type { Runner } from './process-runner.ts';
import type { EvidenceContext, EvidencePlan } from './verification-plan.ts';

const FIXTURE_SPEC = /^scripts\/browser-fixtures\/tests\/[\w.-]+\.playwright\.ts$/;
const E2E_SPEC = /^tests\/e2e\/[\w.-]+\.spec\.ts$/;
/**
 * Every workspace the root `package.json` lists: the globbed folders and the two named ones under
 * `scripts/`. The unit job enters any of them with `cd <workspace> && bun test`; a test keeps this
 * equal to the manifest's `workspaces`.
 */
export const WORKSPACE =
  /^(?:(?:applications|components|packages|plugins|testing|internal)\/[\w.-]+|scripts\/(?:browser-fixtures|groom))$/;
const SAFE_PATH = /^[\w@./-]+$/;
/**
 * The most characters the `unit_lanes` input takes in one dispatch. GitHub caps all of a dispatch's
 * inputs at 65,535 characters together, and the e2e and fixture inputs of a Cinder change take about
 * 10,000.
 */
const UNIT_PATH_BUDGET = 30_000;

/** The most test files a workspace's whole suite may name and still run as a targeted lane. */
export const WHOLE_SUITE_FILE_LIMIT = 40;

/** The rule a plan carries when its unit lanes do not fit one targeted dispatch. */
export const OVERSIZE_RULE = 'plan exceeds one targeted dispatch';

/** One unit test lane of the dispatch: a workspace (`.` is the repository root), its paths, its bunfig. */
export interface UnitLane {
  workspace: string;
  paths: string[];
  config: string;
}

/**
 * The lanes with their paths named file by file when they fit one dispatch, else as the folders
 * holding them. `bun test` takes a path as a filter, so a folder runs every file in it; the
 * selection only ever grows. `undefined` when even folders do not fit: nothing is dropped, so the
 * caller must dispatch the full run instead.
 */
export function fitUnitLanes(lanes: readonly UnitLane[]): UnitLane[] | undefined {
  const fits = (candidate: readonly UnitLane[]) =>
    JSON.stringify(candidate).length <= UNIT_PATH_BUDGET;
  // A file at the workspace root stays named: an empty folder would match every test.
  const within = (path: string, depth: number) => {
    const parts = path.split('/');
    return parts.length <= 1
      ? path
      : `${parts.slice(0, Math.min(depth, parts.length - 1)).join('/')}/`;
  };
  const folded = (depth: number): UnitLane[] =>
    lanes.map((lane) => ({
      ...lane,
      paths: [...new Set(lane.paths.map((path) => within(path, depth)))].toSorted(),
    }));
  if (fits(lanes)) return lanes.map((lane) => ({ ...lane, paths: [...lane.paths] }));
  for (const depth of [Number.MAX_SAFE_INTEGER, 2]) {
    const candidate = folded(depth);
    if (fits(candidate)) return candidate;
  }
  return undefined;
}

export interface TargetedInputs {
  fixtureComponents: string[];
  fixtureSpecs: string[];
  e2eSpecs: string[];
  /** Every unit lane the plan names; none is dropped. */
  unitLanes: UnitLane[];
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
function unitConfigFor(workspace: string, path: string): string {
  if (workspace !== 'applications/interborough') return '';
  return /^(src\/host|fixtures)\//.test(path) ? '' : './bunfig.ui.toml';
}

/**
 * The workflow inputs an evidence plan maps to. Every unit lane of the plan becomes a lane of the
 * dispatch (the root, `.`, runs its `scripts/` files through `bun scripts/bun-test.ts`;
 * Interborough's host and UI tests run under their own bunfigs), and nothing is dropped. What one
 * targeted dispatch cannot carry is named in `undispatchable`: a lane that wants its whole suite,
 * a workspace the workflow cannot enter, or lanes that do not fit the input limit. A plan with any
 * is dispatched as the full run, never truncated.
 */
export function inputsFromPlan(plan: EvidencePlan): {
  inputs: TargetedInputs;
  undispatchable: string[];
} {
  const undispatchable: string[] = [];
  const lanes: UnitLane[] = [];
  for (const lane of plan.unit_tests) {
    const workspace = lane.workspace === '' ? '.' : lane.workspace;
    if (workspace !== '.' && !WORKSPACE.test(workspace)) {
      undispatchable.push(`${workspace}: a workspace the targeted workflow cannot enter`);
      continue;
    }
    // `full` means the selection is every test file of the workspace, named in `paths`. A small
    // suite runs file by file inside a targeted job's 30 minutes; a large one (Cinder's takes 47)
    // wants the sharded full run.
    if (lane.full && (lane.paths.length === 0 || lane.paths.length > WHOLE_SUITE_FILE_LIMIT))
      undispatchable.push(`${workspace}: its whole suite`);
    if (workspace !== 'applications/interborough') {
      if (lane.paths.length > 0) lanes.push({ workspace, config: '', paths: lane.paths });
      continue;
    }
    for (const config of ['./bunfig.ui.toml', '']) {
      const paths = lane.paths.filter((path) => unitConfigFor(workspace, path) === config);
      if (paths.length > 0) lanes.push({ workspace, config, paths });
    }
  }
  const fitted = fitUnitLanes(lanes);
  if (fitted === undefined)
    undispatchable.push(
      `${lanes.length} unit lanes, ${lanes.reduce((sum, lane) => sum + lane.paths.length, 0)} test files, over the dispatch input limit`,
    );
  return {
    inputs: {
      fixtureComponents: plan.fixture_slugs,
      fixtureSpecs: plan.fixture_specs,
      e2eSpecs: plan.e2e_specs,
      unitLanes: fitted ?? [],
    },
    undispatchable,
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
  for (const lane of inputs.unitLanes) {
    const root = lane.workspace === '.';
    const at = (path: string) => (root ? path : `${lane.workspace}/${path}`);
    if (lane.workspace === '' && lane.config !== '' && lane.paths.length === 0) {
      problems.push(`Unit config '${lane.config}' needs --unit-workspace to say whose it is.`);
      continue;
    }
    if (
      !root &&
      (!WORKSPACE.test(lane.workspace) || !dependencies.exists(`${lane.workspace}/package.json`))
    ) {
      problems.push(
        `Unit workspace '${lane.workspace}' must be a workspace folder such as components/cinder.`,
      );
      continue;
    }
    if (lane.paths.length === 0) problems.push('A unit workspace needs at least one --unit-path.');
    for (const path of lane.paths)
      if (!SAFE_PATH.test(path) || !dependencies.exists(at(path)))
        problems.push(`Unit path '${path}' does not exist in ${lane.workspace}.`);
    if (
      lane.config !== '' &&
      (root || !SAFE_PATH.test(lane.config) || !dependencies.exists(at(lane.config)))
    )
      problems.push(`Unit config '${lane.config}' does not exist in ${lane.workspace}.`);
  }
  return problems;
}
