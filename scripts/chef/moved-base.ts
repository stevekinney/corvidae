// Chef moved base (owner decision, 2026-11-21): a change with green evidence that merges into the
// current `main` without a conflict lands. `main` moving while the evidence ran is not a reason to
// refuse it, and it never asks for a new evidence run: the only reason a moved base refuses a
// landing is a merge conflict. Both delivery routes use this module (`direct-merge.ts` for a
// branch, `merge-gate.ts` for a pull request), and it holds the whole rule:
//   1. the attested base (the one the evidence and the approval name) is an ancestor of the
//      current base;
//   2. the head merged onto the attested base reproduces the attested tree, so the evidence still
//      tested this head;
//   3. the head merges into the current base without a conflict (`git merge-tree --write-tree`),
//      and that merge tree is the tree about to land. A conflict refuses, naming its paths, and the
//      worker merges `main` in and returns a new head.
// A moved base needs nothing else: not a green run of `main`'s own CI, not a comparison of the
// files `main` gained with the evidence plan, and not a tree that differs from the attested one
// only where `main` changed (an edit to the same file at a different place is not a conflict).
// This module reads Git and writes nothing.

import type { Runner } from './process-runner.ts';

type Git = (...args: string[]) => ReturnType<Runner>;

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, 200);
}

/** The head merged into a base: its tree, the conflicting paths, or why Git could not say. */
type HeadMerge = { tree: string } | { conflicts: string[] } | { failure: string };

/**
 * `git merge-tree --write-tree` of `head` onto `base`. Exit 0 is a clean merge and the first field
 * is its tree; exit 1 is a conflict and the fields after the tree are the conflicting paths. `-z`
 * reads a path Git would quote (a non-ASCII or special name) verbatim, and `--no-messages` leaves
 * the informational messages out of the output.
 */
export function mergeHeadOnto(git: Git, base: string, head: string): HeadMerge {
  const merged = git(
    'merge-tree',
    '--write-tree',
    '--name-only',
    '--no-messages',
    '-z',
    base,
    head,
  );
  const [first = '', ...rest] = merged.stdout.split('\0');
  const tree = first.trim();
  if (merged.code === 0 && /^[0-9a-f]{40,64}$/.test(tree)) return { tree };
  if (merged.code === 1) return { conflicts: rest.filter((path) => path !== '') };
  return {
    failure: `git merge-tree failed (exit ${merged.code}): ${firstLine(merged.stderr || merged.stdout)}`,
  };
}

/** The conflicting paths as a phrase for a refusal, the first few of them; empty when none. */
export function describeConflicts(conflicts: readonly string[]): string {
  if (conflicts.length === 0) return '';
  const shown = conflicts.slice(0, 5).join(', ');
  return ` at ${shown}${conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : ''}`;
}

/**
 * `main` moved after the evidence: whether the tree about to land is the attested head merged into
 * the current base. Returns the commits of `main` the head was merged onto since the attested base,
 * oldest first (so the landing comment can name them), or why not.
 */
export function acceptMovedMain(
  git: Git,
  attested: { base: string; tree: string },
  head: string,
  base: string,
  tree: string,
): { problem: string } | { mergedIn: string[] } {
  const refuse = (why: string) => ({
    problem: `main moved after the evidence and the head cannot be landed on it: ${why}`,
  });
  if (git('merge-base', '--is-ancestor', attested.base, base).code !== 0)
    return refuse(`the attested base ${attested.base.slice(0, 12)} is not an ancestor of main`);
  const reproduced = mergeHeadOnto(git, attested.base, head);
  if (!('tree' in reproduced) || reproduced.tree !== attested.tree)
    return refuse('merging the head onto the attested base does not give the attested tree');
  const current = mergeHeadOnto(git, base, head);
  if ('failure' in current) return refuse(current.failure);
  if ('conflicts' in current)
    return refuse(
      `the head conflicts with main${describeConflicts(current.conflicts)}; merge main in, resolve the conflict, and return the new head for acceptance`,
    );
  if (current.tree !== tree)
    return refuse(
      `the tree about to land ${tree.slice(0, 12)} is not the head merged into main (${current.tree.slice(0, 12)})`,
    );
  const gained = git('rev-list', '--reverse', `${attested.base}..${base}`);
  if (gained.code !== 0) return refuse(`git rev-list failed: ${firstLine(gained.stderr)}`);
  return { mergedIn: gained.stdout.split('\n').filter((line) => line.trim() !== '') };
}

/**
 * Whether a delivery whose evidence names an older base may land on the current one (a pull
 * request: the route has no step of its own that merges the head into the current base).
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
}): { problem: string } | { mergedIn: string[] } {
  return acceptMovedMain(
    (...args: string[]) => input.runner(['git', ...args], { cwd: input.worktree }),
    input.attested,
    input.head,
    input.base,
    input.tree,
  );
}
