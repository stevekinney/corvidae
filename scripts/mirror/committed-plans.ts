import { join } from 'node:path';

import { discoverWorkspaces } from './manifests.ts';
import { loadPackageMap, type PackageMap } from './package-map.ts';
import {
  collectDigestedFiles,
  hashDigestedFiles,
  publicationInputContract,
} from './source-digest.ts';
import { planSurface, type SurfacePlan } from './surface.ts';
import { type MirrorTarget } from './target-definitions.ts';
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

/**
 * Synthetic publication snapshots let emission tests exercise the complete workspace graph.
 * These fixtures do not claim a registry publication. Guard regressions independently verify
 * missing snapshots and changed source or publication inputs against explicit negative cases.
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
    const sourceFiles = await collectDigestedFiles({
      corvidaeRoot,
      corvidaeDirectory: workspace.directory,
      workspace: workspace.name,
    });
    const input = await publicationInputContract({
      corvidaeRoot,
      corvidaeDirectory: workspace.directory,
      workspace: workspace.name,
    });
    overlaid[name] = {
      ...entry,
      publishedSnapshot: {
        schemaVersion: 1,
        version: entry.lastPublishedVersion ?? '0.0.0',
        gitHead: '0'.repeat(40),
        corvidaeCommit: '0'.repeat(40),
        source: {
          algorithm: 'sha256-files-v1',
          paths: sourceFiles.map((file) => file.path),
          digest: hashDigestedFiles(sourceFiles),
        },
        publicationInputContract: input,
        registryManifestContract: input,
        registryPayloadContract: {
          algorithm: 'sha256-package-payload-v1',
          files: [],
          digest: '0'.repeat(64),
        },
      },
    };
  }
  return { ...map, workspaces: overlaid };
}

async function build(target: MirrorTarget, packageMap: PackageMap): Promise<CommittedPlan> {
  const plan = await planSurface({ corvidaeRoot, target, packageMap });
  return { plan, escapes: findSourceEscapes(plan.files) };
}

/**
 * Sequential and exhaustive: the work is CPU-bound, so planning both at once buys nothing, and a
 * `Record<MirrorTarget, …>` literal is what makes a new target a type error here rather than a
 * silently unplanned target in whichever test iterates `mirrorTargets`.
 */
/**
 * The package map every plan below is built from, exported so a suite that needs the same
 * current-digest overlay (`source-digest.test.ts`) reads this one instead of hashing every
 * published workspace again inside a test body.
 */
export const packageMapForFixtures = await packageMapWithCurrentDigests();

export const committedPlans: Readonly<Record<MirrorTarget, CommittedPlan>> = {
  cinder: await build('cinder', packageMapForFixtures),
  weft: await build('weft', packageMapForFixtures),
};
