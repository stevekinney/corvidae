import { join } from 'node:path';

import { discoverWorkspaces, type MirrorTarget } from './manifests.ts';
import { loadPackageMap, type PackageMap } from './package-map.ts';
import { computeSourceDigest } from './source-digest.ts';
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

/**
 * The declared budget for a test that must build a real plan inside its own body, because it
 * needs a package map the shared plans above were not built with (`source-digest.test.ts`).
 *
 * Declared rather than discovered, as `sync.test.ts`'s `endToEndTimeout` is. A real plan is
 * bounded CPU work: measured at about 1.7s for cinder and 0.9s for weft with the machine at a load
 * of 45 on ten cores, and a test builds at most two. The five-second default holds on a quiet
 * machine but not on a shared one, where the load reached 100 and validate failed three times on
 * unrelated tests for that reason alone (COR-1198). Thirty seconds covers a tenfold slowdown of
 * the two-plan case with margin; a plan that genuinely hangs still fails.
 */
export const realPlanTimeout = 30_000;

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

/**
 * `package-map.json`, with every `publish-as` entry's `sourceDigest` overlaid to corvidae's
 * current digest for it, computed once and shared by every target's `build()` below.
 *
 * This fixture already rests on treating the committed tree as ground truth: `the committed
 * workspaces` in `source.test.ts` asserts every byte `planSource` emits for a real workspace is
 * the byte corvidae itself wrote. Overlaying "corvidae's current source is what would be recorded
 * as published" is the same assumption applied to `assertEdgeNotStale` (source-digest.ts) instead
 * of to emission — it is what lets `surface.test.ts`, `target-resolvability.test.ts` and
 * `source.test.ts` keep testing what they were built to test (source emission, TypeScript
 * configuration, coverage) without every one of them also incidentally exercising the digest
 * guard's refusal. That refusal is tested directly, against the real, unoverlaid map, in
 * `source-digest.test.ts` — which is where a reader should look to see today's cross-target edges
 * actually fail, since this fixture is built specifically so they do not.
 */
export async function packageMapWithCurrentDigests(): Promise<PackageMap> {
  const map = await loadPackageMap();
  const workspaces = await discoverWorkspaces(corvidaeRoot);
  const overlaid: PackageMap['workspaces'] = {};
  for (const [name, entry] of Object.entries(map.workspaces)) {
    if (entry.disposition !== 'publish-as') {
      overlaid[name] = entry;
      continue;
    }
    const workspace = workspaces.find((candidate) => candidate.name === name);
    if (workspace === undefined) {
      overlaid[name] = entry;
      continue;
    }
    const sourceDigest = await computeSourceDigest({
      corvidaeRoot,
      corvidaeDirectory: workspace.directory,
      workspace: workspace.name,
    });
    overlaid[name] = { ...entry, sourceDigest };
  }
  return { ...map, workspaces: overlaid };
}

async function build(target: MirrorTarget, packageMap: PackageMap): Promise<CommittedPlan> {
  const plan = await planSurface({ corvidaeRoot, target, packageMap });
  return { plan, escapes: findSourceEscapes(plan.files) };
}

/**
 * Sequential and exhaustive: the work is CPU-bound, so planning both at once buys nothing, and a
 * `Record<MirrorTarget, …>` literal is what makes a third target a type error here rather than a
 * silently unplanned target in whichever test iterates `mirrorTargets`.
 */
const packageMapForFixtures = await packageMapWithCurrentDigests();

export const committedPlans: Readonly<Record<MirrorTarget, CommittedPlan>> = {
  cinder: await build('cinder', packageMapForFixtures),
  weft: await build('weft', packageMapForFixtures),
  'agent-bureau': await build('agent-bureau', packageMapForFixtures),
};
