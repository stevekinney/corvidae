#!/usr/bin/env bun
// Chef merge gate: the whole verify, comment, merge and confirm sequence for one pull request, so
// a coordinator merges with one call instead of nine, and the merge cannot skip a check the
// hand-run sequence used to forget.
//
// Usage:
//   bun scripts/chef/merge-gate.ts [--config <json>] --pr <n> --worktree <dir> --gate-log <file>
//                                  --comment-file <md> [--dry-run] [--json]
//
// The steps run in order and stop at the first failure, which is named:
//   1. fetch          `git fetch origin <default>`;
//   2. head           the worktree's HEAD equals the pull request's `headRefOid`, and it is open;
//   3. contains-base  HEAD contains `origin/<default>`;
//   4. gate           the gate log's exit code is 0, its HEAD equals the pull request's head, and the
//                     worktree was clean (`git status --porcelain` empty) at the start and at the end
//                     of the run with HEAD unmoved (start head = end head = the pull request's head);
//   5. threads        every review thread is resolved, and SEEN equals TOTAL;
//   6. comment        post the comment file (skipped with --dry-run);
//   7. refetch        fetch again; HEAD still contains `origin/<default>`;
//   8. merge          `gh pr merge --<method> --match-head-commit <head>` (skipped with --dry-run);
//   9. confirm        the pull request is MERGED, and `git diff --quiet <mergeCommit> <head>` holds,
//                     which is `treesMatch` (skipped with --dry-run).
//
// It prints { pr, head, base, gateRc, threads, merged, mergeCommit, treesMatch, failedStep }.
//
// Exit codes: 0 every step passed (under --dry-run: every check passed), 1 a step failed or the
// merged tree differs from the gated tree, 2 invalid CLI usage.

import { existsSync, readFileSync } from 'node:fs';
import { readGateLog } from './gate-run.ts';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  requireOption,
  type Runner,
  UsageError,
} from './process-runner.ts';
import { DEFAULT_CONFIGURATION_PATH, loadRepositoryConfig } from './repository-config.ts';
import { listThreads, ReviewThreadsError } from './review-threads.ts';

export { UsageError };

export interface MergeGateOptions {
  configPath: string;
  pr: number;
  worktree: string;
  gateLog: string;
  commentFile: string;
  dryRun: boolean;
}

export interface MergeGateReport {
  pr: number;
  /** The worktree's HEAD, which is the commit that was gated and merged. */
  head: string | null;
  /** `origin/<default>` as fetched before the merge. */
  base: string | null;
  gateRc: number | null;
  threads: { seen: number; total: number; unresolved: number } | null;
  merged: boolean;
  mergeCommit: string | null;
  /** Whether the merge commit's tree equals the gated head's; `null` when it was not checked. */
  treesMatch: boolean | null;
  /** The step that failed, or `null` when every step passed. */
  failedStep: string | null;
  /** Why it failed, in one line. */
  detail: string | null;
}

export interface MergeGateDependencies {
  runner: Runner;
}

interface PullRequestView {
  headRefOid?: unknown;
  mergeStateStatus?: unknown;
  state?: unknown;
  mergeCommit?: { oid?: unknown } | null;
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, 200);
}

function viewPullRequest(
  runner: Runner,
  repository: string,
  pr: number,
  fields: string,
): PullRequestView | string {
  const result = runner(['gh', 'pr', 'view', String(pr), '--repo', repository, '--json', fields]);
  if (result.code !== 0)
    return `gh pr view failed (exit ${result.code}): ${firstLine(result.stderr || result.stdout)}`;
  try {
    return JSON.parse(result.stdout) as PullRequestView;
  } catch {
    return 'gh pr view printed output that is not JSON.';
  }
}

/** Run the nine steps. Never throws for a failed step; the report names it. */
export function mergeGate(
  options: MergeGateOptions,
  partial: Partial<MergeGateDependencies> = {},
): MergeGateReport {
  const runner = partial.runner ?? defaultRunner;
  const config = loadRepositoryConfig(options.configPath);
  if (!existsSync(options.worktree)) throw new UsageError(`No such worktree: ${options.worktree}`);
  if (!existsSync(options.gateLog)) throw new UsageError(`No such gate log: ${options.gateLog}`);
  if (!existsSync(options.commentFile))
    throw new UsageError(`No such comment file: ${options.commentFile}`);
  if (readFileSync(options.commentFile, 'utf8').trim() === '')
    throw new UsageError(`${options.commentFile} is empty.`);

  const { repository, defaultBranch } = config;
  const report: MergeGateReport = {
    pr: options.pr,
    head: null,
    base: null,
    gateRc: null,
    threads: null,
    merged: false,
    mergeCommit: null,
    treesMatch: null,
    failedStep: null,
    detail: null,
  };
  const git = (...args: string[]) => runner(['git', ...args], { cwd: options.worktree });
  const fail = (step: string, detail: string): MergeGateReport => {
    report.failedStep = step;
    report.detail = detail;
    return report;
  };
  const fetchBase = (step: string): string | undefined => {
    const fetched = git('fetch', 'origin', defaultBranch);
    return fetched.code === 0
      ? undefined
      : `${step}: git fetch origin ${defaultBranch} failed (exit ${fetched.code}): ${firstLine(fetched.stderr)}`;
  };
  const containsBase = (): boolean =>
    git('merge-base', '--is-ancestor', `origin/${defaultBranch}`, 'HEAD').code === 0;

  // 1. fetch
  const fetchProblem = fetchBase('fetch');
  if (fetchProblem !== undefined) return fail('fetch', fetchProblem);
  report.base = git('rev-parse', `origin/${defaultBranch}`).stdout.trim() || null;

  // 2. head
  const headResult = git('rev-parse', 'HEAD');
  if (headResult.code !== 0)
    return fail(
      'head',
      `${options.worktree} is not a Git worktree: ${firstLine(headResult.stderr)}`,
    );
  const head = headResult.stdout.trim();
  report.head = head;
  const view = viewPullRequest(runner, repository, options.pr, 'headRefOid,mergeStateStatus,state');
  if (typeof view === 'string') return fail('head', view);
  if (view.state !== 'OPEN')
    return fail('head', `the pull request is ${String(view.state)}, not OPEN.`);
  const pullRequestHead = typeof view.headRefOid === 'string' ? view.headRefOid : '';
  if (pullRequestHead !== head)
    return fail(
      'head',
      `the worktree is at ${head.slice(0, 12)} but the pull request head is ${pullRequestHead.slice(0, 12) || 'unknown'}.`,
    );

  // 3. contains-base
  if (!containsBase())
    return fail(
      'contains-base',
      `HEAD does not contain origin/${defaultBranch}; merge it in and re-gate.`,
    );

  // 4. gate
  const summary = readGateLog(readFileSync(options.gateLog, 'utf8'));
  report.gateRc = summary.exitCode ?? null;
  if (summary.exitCode === undefined)
    return fail(
      'gate',
      `${options.gateLog} holds no exit code (${summary.problem ?? 'still running or cut off'}).`,
    );
  if (summary.exitCode !== 0) return fail('gate', `the gate exited ${summary.exitCode}.`);
  if (summary.head !== head)
    return fail(
      'gate',
      `the gate ran at ${summary.head?.slice(0, 12) ?? 'an unknown commit'}, not at ${head.slice(0, 12)}.`,
    );
  for (const [label, tree] of [
    ['start', summary.treeStart],
    ['end', summary.treeEnd],
  ] as const) {
    if (tree === undefined)
      return fail(
        'gate',
        `the gate log records no single TREE_${label.toUpperCase()} line, so the tree at the ${label} is unknown.`,
      );
    if (tree.clean !== true)
      return fail(
        'gate',
        `the worktree was ${tree.clean === false ? 'dirty' : 'in an unknown state'} at the ${label} of the gate run, so the result may not describe the commit.`,
      );
    if (tree.head !== head)
      return fail(
        'gate',
        `HEAD was ${tree.head.slice(0, 12)} at the ${label} of the gate run, not ${head.slice(0, 12)}.`,
      );
  }

  // 5. threads
  let listing;
  try {
    listing = listThreads(repository, options.pr, runner);
  } catch (error) {
    if (!(error instanceof ReviewThreadsError)) throw error;
    return fail('threads', error.message);
  }
  report.threads = { seen: listing.seen, total: listing.total, unresolved: listing.unresolved };
  if (listing.seen !== listing.total)
    return fail('threads', `read ${listing.seen} of ${listing.total} review threads.`);
  if (listing.unresolved > 0)
    return fail('threads', `${listing.unresolved} review thread(s) are unresolved.`);

  // 6. comment
  if (!options.dryRun) {
    const commented = runner([
      'gh',
      'pr',
      'comment',
      String(options.pr),
      '--repo',
      repository,
      '--body-file',
      options.commentFile,
    ]);
    if (commented.code !== 0)
      return fail(
        'comment',
        `gh pr comment failed (exit ${commented.code}): ${firstLine(commented.stderr)}`,
      );
  }

  // 7. refetch
  const refetchProblem = fetchBase('refetch');
  if (refetchProblem !== undefined) return fail('refetch', refetchProblem);
  if (!containsBase())
    return fail(
      'refetch',
      `${defaultBranch} moved: HEAD no longer contains origin/${defaultBranch}.`,
    );
  report.base = git('rev-parse', `origin/${defaultBranch}`).stdout.trim() || report.base;
  if (options.dryRun) return report;

  // 8. merge
  const merge = runner([
    'gh',
    'pr',
    'merge',
    String(options.pr),
    '--repo',
    repository,
    `--${config.mergeMethod}`,
    '--match-head-commit',
    head,
  ]);
  if (merge.code !== 0)
    return fail(
      'merge',
      `gh pr merge failed (exit ${merge.code}): ${firstLine(merge.stderr || merge.stdout)}`,
    );

  // 9. confirm
  const merged = viewPullRequest(runner, repository, options.pr, 'state,mergeCommit');
  if (typeof merged === 'string') return fail('confirm', merged);
  if (merged.state !== 'MERGED')
    return fail('confirm', `the pull request is ${String(merged.state)} after the merge call.`);
  report.merged = true;
  const mergeCommit = merged.mergeCommit?.oid;
  if (typeof mergeCommit !== 'string' || mergeCommit === '')
    return fail('confirm', 'the pull request is MERGED but reports no merge commit.');
  report.mergeCommit = mergeCommit;
  const fetchedCommit = git('fetch', 'origin', mergeCommit);
  if (fetchedCommit.code !== 0)
    return fail(
      'confirm',
      `could not fetch merge commit ${mergeCommit.slice(0, 12)}: ${firstLine(fetchedCommit.stderr)}`,
    );
  const diff = git('diff', '--quiet', mergeCommit, head);
  if (diff.code > 1)
    return fail('confirm', `git diff failed (exit ${diff.code}): ${firstLine(diff.stderr)}`);
  report.treesMatch = diff.code === 0;
  if (!report.treesMatch)
    return fail(
      'confirm',
      `merged but the merge commit's tree differs from the gated head ${head.slice(0, 12)}.`,
    );
  return report;
}

export function renderMergeGate(report: MergeGateReport, dryRun: boolean): string {
  const lines = [
    `pr #${report.pr} head=${report.head?.slice(0, 12) ?? 'unknown'} base=${report.base?.slice(0, 12) ?? 'unknown'} gate rc=${report.gateRc ?? 'none'}`,
    `threads: ${report.threads === null ? 'not checked' : `seen ${report.threads.seen} of ${report.threads.total}, ${report.threads.unresolved} unresolved`}`,
  ];
  if (report.failedStep !== null) {
    lines.push(`FAILED at ${report.failedStep}: ${report.detail ?? ''}`);
    if (report.merged)
      lines.push(
        `merged=true mergeCommit=${report.mergeCommit?.slice(0, 12) ?? 'unknown'} treesMatch=${report.treesMatch ?? 'unchecked'}`,
      );
  } else if (dryRun) {
    lines.push('Dry run: every check passed; nothing was posted or merged.');
  } else {
    lines.push(
      `merged=true mergeCommit=${report.mergeCommit?.slice(0, 12) ?? 'unknown'} treesMatch=${report.treesMatch ?? 'unchecked'}`,
    );
  }
  return lines.join('\n');
}

export function run(
  argv: string[],
  dependencies: Partial<MergeGateDependencies> = {},
): { code: number; output: string } {
  const parsed = parseOptions(argv, {
    values: ['config', 'pr', 'worktree', 'gate-log', 'comment-file'],
    flags: ['dry-run', 'json'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const pr = requireOption(parsed, 'pr');
  if (!/^[1-9]\d*$/.test(pr)) throw new UsageError(`"${pr}" is not a pull request number.`);
  const options: MergeGateOptions = {
    configPath: parsed.values['config'] ?? DEFAULT_CONFIGURATION_PATH,
    pr: Number(pr),
    worktree: requireOption(parsed, 'worktree'),
    gateLog: requireOption(parsed, 'gate-log'),
    commentFile: requireOption(parsed, 'comment-file'),
    dryRun: parsed.flags.has('dry-run'),
  };
  const report = mergeGate(options, dependencies);
  return {
    code: report.failedStep === null ? 0 : 1,
    output: parsed.flags.has('json')
      ? JSON.stringify(report)
      : renderMergeGate(report, options.dryRun),
  };
}

if (import.meta.main) {
  try {
    const { code, output } = run(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
