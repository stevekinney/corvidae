// Chef moved base: a delivery whose evidence was taken against an older `main` may still land when
// `main` has moved since, if the commits it gained cannot have changed what the evidence proved.
// Both delivery routes use it (`direct-merge.ts` for a branch, `merge-gate.ts` for a pull request):
//   1. the landing queue (`land-queue.ts`) classifies the commits on `main` since the head's
//      merge-base: each is outside the evidence plan, or verified by a green `main.yml` push run
//      on `main` itself (owner decision, 2026-11-21);
//   2. the integration-tree check shows that the tree about to land is the attested tree plus
//      exactly those commits of `main`, and nothing else.
// Anything short of both stays refused. This module reads Git and the provider and writes nothing.

import { discoverWorkspaces } from '../affected-tests.ts';
import { repositoryContext } from './evidence-plan.ts';
import {
  describeVerified,
  githubMainRuns,
  landQueueVerdict,
  type LandQueueResult,
  type MainRunReader,
} from './land-queue.ts';
import type { Runner } from './process-runner.ts';
import { computeEvidencePlan, type EvidencePlan } from './verification-plan.ts';

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, 200);
}

function defaultEvidencePlan(changed: string[], worktree: string): EvidencePlan {
  return computeEvidencePlan(changed, repositoryContext(worktree, new Set()));
}

/** What a caller may substitute: the evidence plan of a changed-file list, and main's CI runs. */
export interface MovedBaseDependencies {
  /** The evidence plan of a changed-file list, read from `worktree`; a test supplies one. */
  evidencePlan?: ((changed: string[], worktree: string) => EvidencePlan) | undefined;
  /** Main's own `main.yml` push runs; defaults to `gh run list`. */
  mainRuns?: MainRunReader | undefined;
}

/**
 * Why the landing queue refuses the head, or the verdict that classified every commit on the default
 * branch since the head's merge-base: outside the plan's scope, or verified by main's own CI. Fails
 * closed: a plan that cannot be computed is a refusal.
 */
export function landingQueue(
  options: { head: string; worktree: string },
  partial: MovedBaseDependencies,
  runner: Runner,
  base: string,
  defaultBranch: string,
  repository: string,
): { refusal: string } | { classified: LandQueueResult } {
  try {
    const changed = runner(
      ['git', 'diff', '-z', '--name-only', '--diff-filter=d', `${base}...${options.head}`],
      {
        cwd: options.worktree,
      },
    );
    if (changed.code !== 0) return { refusal: `git diff failed: ${firstLine(changed.stderr)}` };
    const files = changed.stdout.split('\0').filter(Boolean);
    const plan = (partial.evidencePlan ?? defaultEvidencePlan)(files, options.worktree);
    const verdict = landQueueVerdict({
      runner,
      evidence: options.head,
      plan,
      base,
      cwd: options.worktree,
      workspaces: discoverWorkspaces(options.worktree),
      // Commits main's own CI has verified do not make the evidence stale.
      mainRuns:
        partial.mainRuns ??
        githubMainRuns(runner, {
          branch: defaultBranch,
          cwd: options.worktree,
          repository: repository,
        }),
    });
    if (verdict.verdict === 'LAND') return { classified: verdict };
    const verifiedNote = describeVerified(verdict.verified);
    return {
      refusal: [
        verdict.refusal === undefined ? undefined : `${verdict.refusal}; `,
        `commits on origin/${defaultBranch} since the evidence head ${options.head.slice(0, 12)} touch what its plan reaches, so it needs a new evidence run: ${verdict.overlapping.join(', ')}`,
        verifiedNote.length === 0 ? undefined : ` (${verifiedNote.join('; ')})`,
      ]
        .filter((part) => part !== undefined)
        .join(''),
    };
  } catch (error) {
    return {
      refusal: `the landing queue could not decide: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }
}

/**
 * `main` moved after the evidence and the queue classified every new commit as outside the plan's
 * scope, or as verified by main's own CI (`classified.commits` holds both kinds: a verified commit
 * is classified like one outside the plan, and the checks below hold it to the same proof). The
 * integration-tree check may then accept the attested identity for the tree actually
 * pushed, but only when Git itself shows the two agree. Returns why not, or `undefined`:
 *   1. the attested base is an ancestor of the current one;
 *   2. merging the head onto the attested base reproduces the attested tree;
 *   3. the paths main's new commits touch are all among those the queue classified;
 *   4. the pushed tree differs from the attested tree only at those paths, and at each of them it
 *      holds exactly what the current base holds: the attested tree plus main's new commits, and
 *      nothing else.
 * A conflict, or a tree that differs anywhere else, stays refused.
 */
export function acceptMovedMain(
  git: (...args: string[]) => ReturnType<Runner>,
  attested: { base: string; tree: string },
  head: string,
  base: string,
  tree: string,
  classified: LandQueueResult,
): string | undefined {
  const refuse = (why: string) =>
    `main moved after the evidence and the merged tree cannot be shown to be the attested tree plus main's new commits: ${why}`;
  if (git('merge-base', '--is-ancestor', attested.base, base).code !== 0)
    return refuse(`the attested base ${attested.base.slice(0, 12)} is not an ancestor of main`);
  const reproduced = git('merge-tree', '--write-tree', attested.base, head);
  if (reproduced.code !== 0 || reproduced.stdout.split('\n')[0]?.trim() !== attested.tree)
    return refuse('merging the head onto the attested base does not give the attested tree');
  // `-z` throughout: a path Git would quote (a non-ASCII or special name) is read verbatim.
  const log = git('log', '-z', '--name-only', '--format=', `${attested.base}..${base}`);
  if (log.code !== 0) return refuse(`git log failed: ${firstLine(log.stderr)}`);
  const incoming = new Set(log.stdout.split('\0').filter((path) => path.trim() !== ''));
  const classifiedFiles = new Set(classified.commits.flatMap((commit) => commit.files));
  const unclassified = [...incoming].filter((path) => !classifiedFiles.has(path));
  if (unclassified.length > 0)
    return refuse(`the queue did not classify ${unclassified.slice(0, 5).join(', ')}`);
  const differing = git('diff', '-z', '--name-only', '--no-renames', attested.tree, tree);
  if (differing.code !== 0) return refuse(`git diff failed: ${firstLine(differing.stderr)}`);
  const outside = differing.stdout.split('\0').filter((path) => path !== '' && !incoming.has(path));
  if (outside.length > 0)
    return refuse(
      `the trees differ outside main's new commits at ${outside.slice(0, 5).join(', ')}`,
    );
  for (const path of incoming) {
    // The entry (mode, type, object) at the path in each tree; a path absent from both (main
    // deleted it, and the merge did too) is an empty entry on each side and matches.
    const merged = git('ls-tree', '-z', tree, '--', path);
    const current = git('ls-tree', '-z', base, '--', path);
    if (merged.code !== 0 || current.code !== 0 || merged.stdout !== current.stdout)
      return refuse(`${path} is not what main holds`);
  }
  return undefined;
}

/**
 * Whether a delivery whose evidence names an older base may land on the current one. Both checks
 * must pass: the queue classifies every commit between them, and Git shows the tree about to land
 * is the attested tree plus those commits. Returns the queue's verdict, which names the commits
 * main's own CI verified, or why not.
 */
export function acceptMovedBase(input: {
  runner: Runner;
  worktree: string;
  head: string;
  /** The current default-branch commit, and the tree of the head merged onto it. */
  base: string;
  tree: string;
  /** The identity the evidence and the coordinator's approval name. */
  attested: { base: string; tree: string };
  defaultBranch: string;
  repository: string;
  dependencies?: MovedBaseDependencies | undefined;
}): { problem: string } | { classified: LandQueueResult } {
  const queued = landingQueue(
    input,
    input.dependencies ?? {},
    input.runner,
    input.base,
    input.defaultBranch,
    input.repository,
  );
  if ('refusal' in queued) return { problem: queued.refusal };
  const problem = acceptMovedMain(
    (...args: string[]) => input.runner(['git', ...args], { cwd: input.worktree }),
    input.attested,
    input.head,
    input.base,
    input.tree,
    queued.classified,
  );
  return problem === undefined ? { classified: queued.classified } : { problem };
}
