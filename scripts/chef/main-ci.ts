// Chef main CI: main's health is the conclusion of the newest conclusive completed `main.yml` run
// on the default branch, read from GitHub (`gh run list --workflow main.yml --branch <default>
// --status completed`). A `cancelled` run says nothing (the shared queue cancels a superseded
// run), so the newest run that is not cancelled or skipped decides. `merge-gate.ts` and
// `direct-merge.ts` warn in their report while it is red and never refuse a merge on it; when
// GitHub cannot be read, the state is unknown and the merge proceeds. Nothing is recorded locally.
//
// This module is a library; it has no command line.

import type { Runner } from './process-runner.ts';

export const MAIN_WORKFLOW = 'main.yml';

/** Conclusions of a completed run that mean `main` is broken. */
const redConclusions = new Set(['failure', 'timed_out', 'startup_failure']);
/** Conclusions that are no verdict on `main`. */
const inconclusive = new Set(['cancelled', 'skipped']);

export interface MainRun {
  conclusion: string;
  head: string;
  url: string;
  time: string;
}

export interface MainCiHealth {
  /** True when the latest completed `main.yml` run failed. */
  red: boolean;
  run: MainRun | undefined;
  /** Why the state is unknown, when GitHub could not say. */
  problem?: string;
}

function unknown(problem: string): MainCiHealth {
  return { red: false, run: undefined, problem };
}

/** Main's health from the latest completed `main.yml` run on `<repository>`'s `<defaultBranch>`. */
export function mainCiHealth(
  runner: Runner,
  repository: string,
  defaultBranch: string,
): MainCiHealth {
  let listed;
  try {
    listed = runner([
    'gh',
    'run',
    'list',
    '--repo',
    repository,
    '--workflow',
    MAIN_WORKFLOW,
    '--branch',
    defaultBranch,
    '--status',
    'completed',
    '--limit',
    '10',
    '--json',
    'conclusion,headSha,url,createdAt',
  ]);
  } catch (error) {
    return unknown(`gh could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (listed.code !== 0)
    return unknown(
      `gh run list failed (exit ${listed.code}): ${listed.stderr.trim().split('\n')[0] ?? ''}`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(listed.stdout);
  } catch {
    return unknown('gh run list printed no JSON');
  }
  if (!Array.isArray(parsed)) return unknown('gh run list printed an unexpected shape');
  const records = parsed.filter(
    (candidate): candidate is Record<string, unknown> =>
      candidate !== null &&
      typeof candidate === 'object' &&
      typeof (candidate as Record<string, unknown>)['conclusion'] === 'string' &&
      !inconclusive.has((candidate as Record<string, unknown>)['conclusion'] as string),
  );
  const record = records[0];
  if (record === undefined)
    return unknown(`no conclusive completed ${MAIN_WORKFLOW} run on ${defaultBranch}`);
  const run: MainRun = {
    conclusion: record['conclusion'] as string,
    head: typeof record['headSha'] === 'string' ? record['headSha'] : '',
    url: typeof record['url'] === 'string' ? record['url'] : '',
    time: typeof record['createdAt'] === 'string' ? record['createdAt'] : '',
  };
  return { red: redConclusions.has(run.conclusion), run };
}

/** One line for the report. */
export function renderMainCiHealth(health: MainCiHealth, defaultBranch: string): string {
  if (health.problem !== undefined) return `main health unknown: ${health.problem}.`;
  if (health.run === undefined) return `main health unknown: no ${MAIN_WORKFLOW} run on ${defaultBranch}.`;
  const { run } = health;
  return `${defaultBranch} ${MAIN_WORKFLOW} at ${run.head.slice(0, 12)}: ${run.conclusion} at ${run.time} (${health.red ? 'RED' : 'green'}) ${run.url}`.trim();
}

/** The warning to put in a merge report, or `undefined` when `main` is green. */
export function mainCiWarning(health: MainCiHealth, defaultBranch: string): string | undefined {
  return health.red || health.problem !== undefined
    ? renderMainCiHealth(health, defaultBranch)
    : undefined;
}
