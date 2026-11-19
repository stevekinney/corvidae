// What a head must be landed on, computed by the coordinator from the diff alone. Pure rules
// (`oneWayDoorMatches`, `wholeSuiteMatches`) over `git diff --name-only <base>...<head>` with every
// status, deletions included: deleting a wire golden is as much a one-way door as editing it. Nothing
// here runs a file of the worker's checkout; `git` only reads the repository's objects.
//
// `landingPlanDigest` names that plan for `targeted-checks.yml`: `targeted-run.ts` passes it as
// `plan_digest` and the workflow's run name carries it, so landing accepts a targeted run only for
// the plan it computes itself.

import { createHash } from 'node:crypto';

import type { Runner } from './process-runner.ts';
import { oneWayDoorMatches, wholeSuiteMatches, type FullRunRule } from './verification-plan.ts';

export interface LandingPlan {
  /** Every changed path, deletions included, sorted. */
  changed: string[];
  oneWayDoors: FullRunRule[];
  wholeSuite: FullRunRule[];
  /** A one-way door or a whole-suite change: only the sharded `main.yml` run covers it. */
  requiresFullRun: boolean;
  digest: string;
}

/** The plan for a list of changed paths (every status). */
export function landingPlan(changedPaths: readonly string[]): LandingPlan {
  const changed = [...new Set(changedPaths)].toSorted();
  const oneWayDoors = oneWayDoorMatches(changed);
  const wholeSuite = wholeSuiteMatches(changed);
  const digest = createHash('sha256')
    .update(JSON.stringify({ changed, oneWayDoors, wholeSuite }))
    .digest('hex');
  return {
    changed,
    oneWayDoors,
    wholeSuite,
    requiresFullRun: oneWayDoors.length + wholeSuite.length > 0,
    digest,
  };
}

/** `git diff --name-only <base>...<head>`, every status; a problem string when git fails. */
export function changedPaths(
  runner: Runner,
  cwd: string,
  base: string,
  head: string,
): string[] | string {
  const result = runner(['git', 'diff', '--name-only', `${base}...${head}`], { cwd });
  if (result.code !== 0)
    return `the changed files of ${base}...${head} could not be read (git exit ${result.code})`;
  return result.stdout.split('\n').filter((line) => line !== '');
}
