#!/usr/bin/env bun
// Chef direct merge: squash a pushed branch straight into the default branch with no pull request
// (owner decision, 2026-11-11: a pull request is optional). It is the library behind
// `deliver.ts --branch`; it has no command line of its own.
//
// It runs no test gate, changes no working tree and never merges the default branch into the branch.
// The worker ran its focused checks before pushing; the text guards (`bun run lint:guards`) run here
// on the exact tree that is pushed, in a temporary worktree, and GitHub Actions' full suite on every
// push to `main` is the backstop (AGENTS.md "Gate on local checks").
//
// The steps run in order and stop at the first failure, which is named:
//   1. head       fetch `origin/<default>` and the branch; `origin/<branch>` must be exactly the head
//                 the coordinator accepted;
//   2. revert     `revert-check.ts` for that head against `origin/<default>` finds no file set back to
//                 the state it had before a recent commit on the base;
//   3. conflict   `git merge-tree --write-tree <base> <head>` builds the merged tree; a conflict is
//                 refused and nothing is merged in: the worker merges the base in and returns a new
//                 head. A branch that changes nothing relative to the base is refused at `merge`;
//   4. guards     each guard of `lint:guards` runs as its own process on the tree that will be
//                 pushed (the one squash commit, in a temporary detached Git worktree that is
//                 always removed afterwards; `text-guards.ts` says why a worktree and not an
//                 archive). A failure names the guard whose process failed and refuses, unless
//                 `--fixes-main` is given and every failing guard's findings are a subset of that
//                 guard's findings on `origin/<default>`;
//   5. merge      `git push origin <commit>:refs/heads/<default>`, where the commit is ONE squash
//                 commit, `git commit-tree <tree> -p <base> -F <message file>`. A rejected push (the
//                 default branch moved after the fetch) changes nothing; run it again;
//   6. delete     the remote branch is deleted. A failure leaves `merged` true;
//   7. usage      optional spend record, as `merge-gate.ts` appends it, with the column that holds a
//                 pull request number there holding `branch:<name>` here.
//
// Merge lock: `directMergeExclusively` holds the same lock `merge-gate.ts` holds for a pull request
// merge (`withMergeLock`), from before step 1 to after step 7, so a direct merge and a pull request
// merge never interleave their pushes.
//
// A red `main` is a warning in the report, never a refusal. `--fixes-main` is not recorded in the
// health file, which keys its records by pull request number; here it only lets step 4 pass.
//
// This module is a library; it has no command line.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AcquireHostLockOptions } from '../run-exclusively.ts';
import { fetchWithRetry } from './fetch-retry.ts';
import { mainHealth, renderMainHealth, resolveHealthFile } from './main-health.ts';
import { withMergeLock } from './merge-gate.ts';
import { defaultRunner, UsageError, type Runner } from './process-runner.ts';
import { loadRepositoryConfig } from './repository-config.ts';
import { revertCheck, RevertCheckError } from './revert-check.ts';
import { runTextGuards, waivedBy, type GuardsResult } from './text-guards.ts';
import { totalUsage, type UsageTotals } from './transcript-usage.ts';

export interface DirectMergeOptions {
  configPath: string;
  /** The remote branch to merge; it is deleted after the merge. */
  branch: string;
  /** The head pinned at acceptance; the merge refuses unless `origin/<branch>` is exactly it. */
  head: string;
  /** The squash commit's message. */
  messageFile: string;
  /** A checkout of the repository, where the Git commands run; it is never modified. */
  worktree: string;
  /** Lets step 4 pass when each failing guard's findings are already findings on the default branch. */
  fixesMain?: boolean | undefined;
  /** Where the batch-validate record is read; defaults to the main checkout's. */
  healthFile?: string | undefined;
  /** Read the main-health record. Library callers opt in; the command line does. */
  checkMainHealth?: boolean | undefined;
  lockDirectory?: string | undefined;
  lockPollIntervalMs?: number | undefined;
  /** Where to append the spend record after a successful merge; needs `transcripts`. */
  usageLog?: string | undefined;
  transcripts?: string[] | undefined;
}

export interface DirectMergeReport {
  branch: string;
  head: string;
  /** `origin/<default>` as fetched before the merge; the squash commit's parent. */
  base: string | null;
  merged: boolean;
  mergeCommit: string | null;
  /** Set when `main`'s last batch validate failed; a warning, never a refusal. */
  mainHealthWarning?: string;
  /** Set when step 4 failed and `--fixes-main` let it pass because the base fails the same guard. */
  guardWaiver?: string;
  failedStep: string | null;
  detail: string | null;
  usage?: UsageTotals;
}

export interface DirectMergeDependencies {
  runner: Runner;
  /**
   * Runs the text guards on the tree of one commit, only the named ones when `only` is given;
   * defaults to `runTextGuards`.
   */
  guards: (revision: string, only?: readonly string[]) => GuardsResult;
  usage: (paths: string[]) => UsageTotals;
  now: () => Date;
  sleep: (milliseconds: number) => void;
}

/** The refusal's detail: the first failing guard by name, and the others that failed after it. */
function guardsDetail(result: GuardsResult): string {
  const [first, ...rest] = result.failures;
  if (first === undefined) return 'a text guard failed on the merged tree';
  const others = rest.length === 0 ? '' : ` (also: ${rest.map((one) => one.guard).join(', ')})`;
  return `${first.guard} failed on the merged tree: ${first.output}${others}`;
}

/** A branch name that is safe as a Git ref and cannot be read as an option. */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, 200);
}

/** Run the steps. Never throws for a failed step; the report names it. */
export function directMerge(
  options: DirectMergeOptions,
  partial: Partial<DirectMergeDependencies> = {},
): DirectMergeReport {
  const runner = partial.runner ?? defaultRunner;
  const config = loadRepositoryConfig(options.configPath);
  const { defaultBranch } = config;
  if (!existsSync(options.worktree)) throw new UsageError(`No such worktree: ${options.worktree}`);
  if (!SAFE_BRANCH.test(options.branch) || options.branch.includes('..'))
    throw new UsageError(`"${options.branch}" is not a safe branch name.`);
  if (options.branch === defaultBranch)
    throw new UsageError(`--branch cannot be the default branch ${defaultBranch}.`);
  if (!/^[0-9a-f]{40}$/.test(options.head))
    throw new UsageError(`--head "${options.head}" is not a full commit SHA.`);
  if (!existsSync(options.messageFile))
    throw new UsageError(`No such message file: ${options.messageFile}`);
  if (readFileSync(options.messageFile, 'utf8').trim() === '')
    throw new UsageError(`${options.messageFile} is empty.`);
  const transcripts = options.transcripts ?? [];
  if ((options.usageLog === undefined) !== (transcripts.length === 0))
    throw new UsageError('--usage-log and --transcript go together.');
  for (const transcript of transcripts) {
    if (!existsSync(transcript)) throw new UsageError(`No such transcript: ${transcript}`);
  }

  const report: DirectMergeReport = {
    branch: options.branch,
    head: options.head,
    base: null,
    merged: false,
    mergeCommit: null,
    failedStep: null,
    detail: null,
  };
  const git = (...args: string[]) => runner(['git', ...args], { cwd: options.worktree });
  const fail = (step: string, detail: string): DirectMergeReport => {
    report.failedStep = step;
    report.detail = detail;
    return report;
  };
  const guards =
    partial.guards ?? ((revision, only) => runTextGuards(runner, options.worktree, revision, only));

  // 1. head
  const fetched = fetchWithRetry(() => git('fetch', 'origin', defaultBranch, options.branch), {
    sleep: partial.sleep,
  });
  if (fetched.code !== 0)
    return fail(
      'head',
      `git fetch origin ${defaultBranch} ${options.branch} failed (exit ${fetched.code}): ${firstLine(fetched.stderr)}`,
    );
  const branchHead = git('rev-parse', '--verify', `refs/remotes/origin/${options.branch}^{commit}`);
  if (branchHead.code !== 0 || branchHead.stdout.trim() !== options.head)
    return fail(
      'head',
      `origin/${options.branch} is ${branchHead.stdout.trim().slice(0, 12) || 'unreadable'}, not the head pinned at acceptance, ${options.head.slice(0, 12)}.`,
    );
  const baseResult = git('rev-parse', '--verify', `refs/remotes/origin/${defaultBranch}^{commit}`);
  const base = baseResult.stdout.trim();
  if (baseResult.code !== 0 || base === '')
    return fail('head', `could not read origin/${defaultBranch}: ${firstLine(baseResult.stderr)}`);
  report.base = base;

  // 2. revert
  try {
    const reverts = revertCheck({ head: options.head, base, cwd: options.worktree }, runner);
    if (reverts.findings.length > 0)
      return fail(
        'revert',
        reverts.findings
          .map((finding) => `${finding.file} undoes ${finding.undoes}`)
          .join('; ')
          .slice(0, 400),
      );
  } catch (error) {
    if (!(error instanceof RevertCheckError)) throw error;
    return fail('revert', error.message);
  }

  // 3. conflict
  const mergedTree = git('merge-tree', '--write-tree', base, options.head);
  const tree = mergedTree.stdout.split('\n')[0]?.trim() ?? '';
  if (mergedTree.code !== 0 || !/^[0-9a-f]{40,64}$/.test(tree))
    return fail(
      'conflict',
      mergedTree.code === 1
        ? `${options.branch} conflicts with origin/${defaultBranch}; merge it in, resolve the conflict, and return the new head for acceptance.`
        : `git merge-tree failed (exit ${mergedTree.code}): ${firstLine(mergedTree.stderr || mergedTree.stdout)}`,
    );
  const baseTree = git('rev-parse', `${base}^{tree}`).stdout.trim();
  if (tree === baseTree)
    return fail('merge', `${options.branch} changes nothing relative to origin/${defaultBranch}.`);
  const created = git('commit-tree', tree, '-p', base, '-F', options.messageFile);
  const commit = created.stdout.trim();
  if (created.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit))
    return fail(
      'merge',
      `git commit-tree failed (exit ${created.code}): ${firstLine(created.stderr)}`,
    );

  // main health: a warning in the report, never a refusal
  const healthFile =
    options.healthFile ??
    (options.checkMainHealth === true ? resolveHealthFile(runner, options.worktree) : undefined);
  if (healthFile !== undefined) {
    const health = mainHealth(runner, options.worktree, defaultBranch, healthFile);
    if (health.red && health.run !== undefined)
      report.mainHealthWarning = renderMainHealth(health, defaultBranch).split('\n')[0] ?? '';
  }

  // 4. guards, on the tree that will be pushed
  const checked = guards(commit);
  if (!checked.ok) {
    // Only the guards that failed on the squash tree are run on the base; the failure is waived when
    // every one of them fails there too, with no finding the base does not already have.
    const onBase =
      options.fixesMain === true
        ? guards(
            base,
            checked.failures.map((failure) => failure.guard),
          )
        : undefined;
    const waived = onBase === undefined ? null : waivedBy(checked, onBase);
    if (waived === null) return fail('guards', guardsDetail(checked));
    report.guardWaiver = `${waived.guards.join(', ')}: all ${waived.findings} output lines of the failure also appear in the same guard's run on origin/${defaultBranch}; merged as the declared fix.`;
  }

  // 5. merge
  const pushed = git('push', 'origin', `${commit}:refs/heads/${defaultBranch}`);
  if (pushed.code !== 0)
    return fail(
      'merge',
      `git push origin ${commit.slice(0, 12)}:refs/heads/${defaultBranch} was rejected (exit ${pushed.code}): ${firstLine(pushed.stderr)}. Nothing changed; run delivery again.`,
    );
  report.merged = true;
  report.mergeCommit = commit;

  // 6. delete
  const deleted = git('push', 'origin', '--delete', options.branch);
  if (deleted.code !== 0)
    return fail(
      'delete',
      `merged as ${commit.slice(0, 12)}, but deleting origin/${options.branch} failed (exit ${deleted.code}): ${firstLine(deleted.stderr)}`,
    );

  // 7. usage (optional)
  if (options.usageLog !== undefined) {
    try {
      const totals = (partial.usage ?? totalUsage)(transcripts);
      mkdirSync(dirname(options.usageLog), { recursive: true });
      appendFileSync(
        options.usageLog,
        `${[
          (partial.now ?? (() => new Date()))().toISOString(),
          `branch:${options.branch}`,
          commit,
          totals.input,
          totals.cachedInput,
          totals.output,
        ].join('\t')}\n`,
      );
      report.usage = totals;
    } catch (error) {
      return fail(
        'usage',
        `merged, but the spend record was not written: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return report;
}

/** `directMerge` under the cross-session merge lock that `merge-gate.ts` holds for a pull request. */
export async function directMergeExclusively(
  options: DirectMergeOptions,
  partial: Partial<DirectMergeDependencies> = {},
  onWait?: AcquireHostLockOptions['onWait'],
): Promise<DirectMergeReport> {
  return withMergeLock(
    {
      worktree: options.worktree,
      command: `direct-merge ${options.branch}`,
      lockDirectory: options.lockDirectory,
      lockPollIntervalMs: options.lockPollIntervalMs,
    },
    () => directMerge(options, partial),
    partial.runner ?? defaultRunner,
    onWait,
  );
}
