import { join } from 'node:path';

import type { MirrorTarget } from './manifests.ts';
import { planSurface, type SurfacePlan } from './surface.ts';
import { findSourceEscapes, type SourceEscape } from './target-resolvability.ts';

/**
 * Both targets' plans over the committed tree, built once for the whole process.
 *
 * `surface.test.ts`, `target-resolvability.test.ts` and `source.test.ts` all assert properties of
 * the real workspaces rather than of a fixture, so each needs a plan for both targets. Each file
 * used to memoize its own, which meant the cinder plan — nineteen workspaces, five and a half
 * thousand emitted files, roughly three seconds warm — was built twice per process, and whichever
 * test body happened to run first in each file paid for it on that test's clock. Under a loaded
 * machine that crossed bun's five-second per-test default and the run failed for a reason that had
 * nothing to do with what the test asserts.
 *
 * Importing this module does the work, at module scope. That is the point rather than a side
 * effect: bun's per-test timeout covers a test body, not module evaluation, so building here
 * attributes the cost to loading the file instead of to an arbitrary first test, and one memo
 * shared by both importers builds each plan once instead of once per file. Nothing is hidden —
 * the work still runs on every `bun test` that loads either file, and a plan that throws fails
 * the run loudly. The one thing it does trade away is the timeout: work that never finishes hangs
 * the runner here rather than failing a test, which is the deal any module-scope setup makes.
 *
 * It is a test helper and nothing else imports it. `sync.ts` plans the target it was asked for,
 * against the checkout it was pointed at, and must keep doing so — an import of this module would
 * build two plans over this worktree before the sync had decided anything.
 */

/** Corvidae's repository root, which is what these plans are built from. */
export const corvidaeRoot = join(import.meta.dir, '..', '..');

export interface CommittedPlan {
  plan: SurfacePlan;
  /**
   * The escapes in that plan's emitted files.
   *
   * Recorded rather than left to the caller because the scan is its own two-and-a-half seconds on
   * the cinder plan, which is the same problem one layer out: a test that rescans is a test body
   * paying for an AST walk over every emitted file. `planSurface` already refuses a plan that has
   * any, so this is always empty; asserting on it states that as a list of offenders rather than
   * as an unrelated `planSurface` call throwing.
   */
  escapes: SourceEscape[];
}

async function build(target: MirrorTarget): Promise<CommittedPlan> {
  const plan = await planSurface({ corvidaeRoot, target });
  return { plan, escapes: findSourceEscapes(plan.files) };
}

/**
 * Sequential and exhaustive: the work is CPU-bound, so planning both at once buys nothing, and a
 * `Record<MirrorTarget, …>` literal is what makes a third target a type error here rather than a
 * silently unplanned target in whichever test iterates `mirrorTargets`.
 */
export const committedPlans: Readonly<Record<MirrorTarget, CommittedPlan>> = {
  cinder: await build('cinder'),
  weft: await build('weft'),
  'agent-bureau': await build('agent-bureau'),
};
