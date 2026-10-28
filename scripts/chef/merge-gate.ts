#!/usr/bin/env bun
// Chef merge gate: the whole verify, comment, merge and confirm sequence for one pull request, so
// a coordinator merges with one call instead of several, and the merge cannot skip a check the
// hand-run sequence used to forget.
//
// It runs no test gate. A worker runs its focused checks before opening the pull request, and the
// per-batch `validate` on `main` is the backstop (AGENTS.md "Gate on local checks"); `main` moving
// is not a reason to repeat either. It refuses only for the reasons below, each a fast check.
//
// Usage:
//   bun scripts/chef/merge-gate.ts [--config <json>] --pr <n> --worktree <dir> --comment-file <md>
//                                  [--head <sha>] [--dry-run] [--json] [--fixes-main]
//                                  [--usage-log <file> --transcript <path>...]
//
// The steps run in order and stop at the first failure, which is named:
//   1. fetch          `git fetch origin <default>`, retried up to three times when Git cannot lock the ref;
//   2. head           the pull request is open, and its `headRefOid` equals the worktree's HEAD and,
//                     with `--head`, the head the coordinator pinned at acceptance;
//   3. conflict       GitHub reports the pull request mergeable. `mergeable` `CONFLICTING` or
//                     `mergeStateStatus` `DIRTY` refuses at `conflict`; `UNKNOWN` is read again, up to
//                     five times two seconds apart, and still `UNKNOWN` refuses at `mergeable`. A base
//                     that merely moved (`BEHIND`) is not a refusal;
//   3b. main-health   `main`'s last batch validate (`main-health.ts`) at a head on `origin/<default>`'s
//                     first-parent history failed: the report carries a `mainHealthWarning` and the
//                     merge goes ahead. `--fixes-main` also records the pull request as a repair;
//   4. threads        every review thread is resolved, and SEEN equals TOTAL;
//   5. comment        post the comment file (skipped with --dry-run);
//   6. merge          `gh pr merge --<method> --match-head-commit <head>` (skipped with --dry-run);
//   7. confirm        the pull request is MERGED, and the merge commit's tree equals the tree
//                     `git merge-tree --write-tree <mergeCommit>^1 <head>` computes: the head itself
//                     when the merge commit's parent is contained in it, else the clean merge of the
//                     two, which is `treesMatch` (skipped with --dry-run).
//
// Cross-session merge lock: unless --dry-run, the command line holds one exclusive lock in the Git
// common directory (`corvidae-merge-lock`, the lock of `scripts/run-exclusively.ts`) from before
// step 1 to after step 7, so two sessions never merge at once. A waiting merge prints who holds it;
// a lock whose holder died is reclaimed.
//
// It prints { pr, head, base, mergeable, threads, merged, mergeCommit, treesMatch, failedStep },
// plus `mainHealthWarning` when `main` is red.
//
// Spend record (optional): `--usage-log <file>` with one or more `--transcript <path>` (a
// transcript file, or a directory searched recursively) totals those transcripts' tokens with
// `transcript-usage.ts` after a successful merge and appends one tab-separated line to the file:
// ISO time, pull request number, merge SHA, input, cached input and output tokens (input is what
// was not read from cache). The two flags go together, and a missing transcript is refused before
// anything is posted. Without them nothing changes. If the record cannot be written, the report
// names a `usage` step as failed, with the pull request already merged.
//
// Exit codes: 0 every step passed (under --dry-run: every check passed), 1 a step failed or the
// merged tree differs from the expected tree, 2 invalid CLI usage.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  acquireHostLock,
  processStartTime,
  type AcquireHostLockOptions,
  type HostLockHolder,
} from '../run-exclusively.ts';
import { fetchWithRetry } from './fetch-retry.ts';
import { mainHealth, recordFix, renderMainHealth, resolveHealthFile } from './main-health.ts';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  requireOption,
  UsageError,
  type Runner,
} from './process-runner.ts';
import { DEFAULT_CONFIGURATION_PATH, loadRepositoryConfig } from './repository-config.ts';
import { listThreads, ReviewThreadsError } from './review-threads.ts';
import { totalUsage, type UsageTotals } from './transcript-usage.ts';

export { UsageError };

/** How many times GitHub's `UNKNOWN` mergeability is read before delivery gives up. */
const MERGEABLE_READS = 5;
/** How long to wait between those reads. */
const MERGEABLE_INTERVAL_MS = 2000;

export interface MergeGateOptions {
  configPath: string;
  pr: number;
  worktree: string;
  commentFile: string;
  dryRun: boolean;
  /** The head pinned at acceptance; when given, the pull request's head must equal it. */
  expectedHead?: string | undefined;
  /** The batch-validate record to check; defaults to the main checkout's when `checkMainHealth`. */
  healthFile?: string | undefined;
  /** Check main's health at the default location. Library callers opt in; the command line does. */
  checkMainHealth?: boolean | undefined;
  /** Declares this pull request a repair of a red `main`; recorded in the health file. */
  fixesMain?: boolean | undefined;
  /** Where the cross-session merge lock lives; defaults to the Git common directory. */
  lockDirectory?: string | undefined;
  /** How often a waiter rechecks the merge lock, in milliseconds. */
  lockPollIntervalMs?: number | undefined;
  /** Where to append the spend record after a successful merge; needs `transcripts`. */
  usageLog?: string | undefined;
  /** Transcript files or directories whose token usage the spend record totals. */
  transcripts?: string[] | undefined;
}

export interface MergeGateReport {
  pr: number;
  /** The worktree's HEAD, which is the commit that was merged. */
  head: string | null;
  /** `origin/<default>` as fetched before the merge. */
  base: string | null;
  /** GitHub's `mergeable` value at the last read, or `null` when it was not read. */
  mergeable: string | null;
  threads: { seen: number; total: number; unresolved: number } | null;
  merged: boolean;
  mergeCommit: string | null;
  /** Whether the merge commit's tree equals the expected tree; `null` when it was not checked. */
  treesMatch: boolean | null;
  /** Set when `main`'s last batch validate failed; a warning, never a refusal. */
  mainHealthWarning?: string;
  /** Whether the pull request was declared a repair of a red `main` (`--fixes-main`). */
  fixesMain?: boolean;
  /** The step that failed, or `null` when every step passed. */
  failedStep: string | null;
  /** Why it failed, in one line. */
  detail: string | null;
  /** The tokens appended to the usage log; present only when a spend record was written. */
  usage?: UsageTotals;
}

export interface MergeGateDependencies {
  runner: Runner;
  /** Totals the tokens of the transcripts at these paths; defaults to `transcript-usage.ts`. */
  usage: (paths: string[]) => UsageTotals;
  now: () => Date;
  /** Blocks between fetch retries and mergeability reads; defaults to `Bun.sleepSync`. */
  sleep: (milliseconds: number) => void;
}

interface PullRequestView {
  headRefOid?: unknown;
  mergeable?: unknown;
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

/** Run the steps. Never throws for a failed step; the report names it. */
export function mergeGate(
  options: MergeGateOptions,
  partial: Partial<MergeGateDependencies> = {},
): MergeGateReport {
  const runner = partial.runner ?? defaultRunner;
  const sleep = partial.sleep ?? ((milliseconds: number) => Bun.sleepSync(milliseconds));
  const config = loadRepositoryConfig(options.configPath);
  if (!existsSync(options.worktree)) throw new UsageError(`No such worktree: ${options.worktree}`);
  if (!existsSync(options.commentFile))
    throw new UsageError(`No such comment file: ${options.commentFile}`);
  if (readFileSync(options.commentFile, 'utf8').trim() === '')
    throw new UsageError(`${options.commentFile} is empty.`);
  const transcripts = options.transcripts ?? [];
  if ((options.usageLog === undefined) !== (transcripts.length === 0))
    throw new UsageError('--usage-log and --transcript go together.');
  for (const transcript of transcripts) {
    if (!existsSync(transcript)) throw new UsageError(`No such transcript: ${transcript}`);
  }

  const { repository, defaultBranch } = config;
  const report: MergeGateReport = {
    pr: options.pr,
    head: null,
    base: null,
    mergeable: null,
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

  // 1. fetch
  const fetched = fetchWithRetry(() => git('fetch', 'origin', defaultBranch), {
    sleep: partial.sleep,
  });
  if (fetched.code !== 0)
    return fail(
      'fetch',
      `git fetch origin ${defaultBranch} failed (exit ${fetched.code}): ${firstLine(fetched.stderr)}`,
    );
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

  // 2 and 3. head and conflict: one view per read, so a push during the wait is seen
  const fields = 'headRefOid,mergeable,mergeStateStatus,state';
  for (let read = 1; ; read++) {
    const view = viewPullRequest(runner, repository, options.pr, fields);
    if (typeof view === 'string') return fail('head', view);
    if (view.state !== 'OPEN')
      return fail('head', `the pull request is ${String(view.state)}, not OPEN.`);
    const pullRequestHead = typeof view.headRefOid === 'string' ? view.headRefOid : '';
    if (pullRequestHead !== head)
      return fail(
        'head',
        `the worktree is at ${head.slice(0, 12)} but the pull request head is ${pullRequestHead.slice(0, 12) || 'unknown'}.`,
      );
    if (options.expectedHead !== undefined && pullRequestHead !== options.expectedHead)
      return fail(
        'head',
        `the pull request head ${pullRequestHead.slice(0, 12)} is not the head pinned at acceptance, ${options.expectedHead.slice(0, 12)}.`,
      );
    report.mergeable = typeof view.mergeable === 'string' ? view.mergeable : null;
    if (view.mergeable === 'CONFLICTING' || view.mergeStateStatus === 'DIRTY')
      return fail(
        'conflict',
        `GitHub reports the pull request conflicts with origin/${defaultBranch} (mergeable ${String(view.mergeable)}, merge state ${String(view.mergeStateStatus)}); merge it in, resolve the conflict, and return the new head for acceptance.`,
      );
    if (view.mergeable !== 'UNKNOWN') break;
    if (read >= MERGEABLE_READS)
      return fail(
        'mergeable',
        `GitHub still reports the mergeability as UNKNOWN after ${MERGEABLE_READS} reads; run delivery again shortly.`,
      );
    sleep(MERGEABLE_INTERVAL_MS);
  }

  // 3b. main-health: a warning in the report, never a refusal
  const healthFile =
    options.healthFile ??
    (options.checkMainHealth === true ? resolveHealthFile(runner, options.worktree) : undefined);
  if (healthFile !== undefined) {
    const health = mainHealth(runner, options.worktree, defaultBranch, healthFile);
    if (health.red && health.run !== undefined) {
      report.mainHealthWarning = renderMainHealth(health, defaultBranch).split('\n')[0] ?? '';
      if (options.fixesMain === true) {
        report.fixesMain = true;
        if (!options.dryRun)
          recordFix(healthFile, {
            pr: options.pr,
            time: (partial.now ?? (() => new Date()))().toISOString(),
            blockedHead: health.run.head,
          });
      }
    }
  }

  // 4. threads
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
  if (options.dryRun) return report;

  // 5. comment
  {
    const commentDirectory = mkdtempSync(join(tmpdir(), 'merge-gate-comment-'));
    const commentBody = join(commentDirectory, 'comment.md');
    writeFileSync(commentBody, `${readFileSync(options.commentFile, 'utf8').trimEnd()}\n`);
    const commented = runner([
      'gh',
      'pr',
      'comment',
      String(options.pr),
      '--repo',
      repository,
      '--body-file',
      commentBody,
    ]);
    rmSync(dirname(commentBody), { recursive: true, force: true });
    if (commented.code !== 0)
      return fail(
        'comment',
        `gh pr comment failed (exit ${commented.code}): ${firstLine(commented.stderr)}`,
      );
  }

  // 6. merge, pinned to the head
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

  // 7. confirm
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
  // The squash commit's tree is the head merged into the parent it landed on: the head's own tree
  // when that parent is contained in the head, the clean merge of the two when the base had moved.
  const expected = git('merge-tree', '--write-tree', `${mergeCommit}^1`, head);
  const expectedTree = expected.stdout.split('\n')[0]?.trim() ?? '';
  if (expected.code !== 0 || !/^[0-9a-f]{40,64}$/.test(expectedTree))
    return fail(
      'confirm',
      `could not compute the tree of ${head.slice(0, 12)} merged into ${mergeCommit.slice(0, 12)}^1 (git merge-tree exit ${expected.code}): ${firstLine(expected.stderr)}`,
    );
  const tree = git('rev-parse', `${mergeCommit}^{tree}`);
  if (tree.code !== 0)
    return fail('confirm', `could not read the merge commit's tree: ${firstLine(tree.stderr)}`);
  report.treesMatch = tree.stdout.trim() === expectedTree;
  if (!report.treesMatch)
    return fail(
      'confirm',
      `merged but the merge commit's tree differs from ${head.slice(0, 12)} merged into the commit it landed on.`,
    );

  // 8. usage (optional): the spend record for this merge
  if (options.usageLog !== undefined) {
    try {
      const totals = (partial.usage ?? totalUsage)(transcripts);
      mkdirSync(dirname(options.usageLog), { recursive: true });
      appendFileSync(
        options.usageLog,
        `${[
          (partial.now ?? (() => new Date()))().toISOString(),
          options.pr,
          mergeCommit,
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

/**
 * `mergeGate` under the cross-session merge lock, so two sessions never merge at once.
 * A dry run takes no lock. The lock is released whatever the outcome, and a dead holder's lock is
 * reclaimed by `run-exclusively.ts`'s helpers.
 */
export async function mergeGateExclusively(
  options: MergeGateOptions,
  partial: Partial<MergeGateDependencies> = {},
  onWait?: AcquireHostLockOptions['onWait'],
): Promise<MergeGateReport> {
  if (options.dryRun) return mergeGate(options, partial);
  let lockDirectory = options.lockDirectory;
  if (lockDirectory === undefined) {
    const common = (partial.runner ?? defaultRunner)(
      ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: options.worktree },
    );
    if (common.code !== 0 || common.stdout.trim() === '')
      throw new UsageError(
        `${options.worktree} is not a Git worktree: ${firstLine(common.stderr)}`,
      );
    lockDirectory = join(common.stdout.trim(), 'corvidae-merge-lock');
  }
  const holder: HostLockHolder = {
    pid: process.pid,
    ...(processStartTime(process.pid) === undefined
      ? {}
      : { pidStartedAt: processStartTime(process.pid) as string }),
    command: `merge-gate pr #${options.pr}`,
    cwd: options.worktree,
    acquiredAt: new Date().toISOString(),
  };
  const held = await acquireHostLock({
    lockDirectory,
    holder,
    ...(options.lockPollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.lockPollIntervalMs }),
    ...(onWait === undefined ? {} : { onWait }),
  });
  try {
    return mergeGate(options, partial);
  } finally {
    await held.release();
  }
}

export function renderMergeGate(report: MergeGateReport, dryRun: boolean): string {
  const lines = [
    `pr #${report.pr} head=${report.head?.slice(0, 12) ?? 'unknown'} base=${report.base?.slice(0, 12) ?? 'unknown'} mergeable=${report.mergeable ?? 'not checked'}`,
    `threads: ${report.threads === null ? 'not checked' : `seen ${report.threads.seen} of ${report.threads.total}, ${report.threads.unresolved} unresolved`}`,
  ];
  if (report.mainHealthWarning !== undefined)
    lines.push(
      `WARNING main health: ${report.mainHealthWarning}${report.fixesMain === true ? ' Merged as the declared fix.' : ''}`,
    );
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
    if (report.usage !== undefined)
      lines.push(
        `usage recorded: input=${report.usage.input} cachedInput=${report.usage.cachedInput} output=${report.usage.output}`,
      );
  }
  return lines.join('\n');
}

function parseArguments(argv: string[]): { options: MergeGateOptions; json: boolean } {
  const parsed = parseOptions(argv, {
    values: ['config', 'pr', 'worktree', 'comment-file', 'usage-log', 'health-file', 'head'],
    repeated: ['transcript'],
    flags: ['dry-run', 'json', 'fixes-main'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const pr = requireOption(parsed, 'pr');
  if (!/^[1-9]\d*$/.test(pr)) throw new UsageError(`"${pr}" is not a pull request number.`);
  const expectedHead = parsed.values['head'];
  if (expectedHead !== undefined && !/^[0-9a-f]{40}$/.test(expectedHead))
    throw new UsageError(`--head "${expectedHead}" is not a full commit SHA.`);
  return {
    json: parsed.flags.has('json'),
    options: {
      configPath: parsed.values['config'] ?? DEFAULT_CONFIGURATION_PATH,
      pr: Number(pr),
      worktree: requireOption(parsed, 'worktree'),
      commentFile: requireOption(parsed, 'comment-file'),
      dryRun: parsed.flags.has('dry-run'),
      healthFile: parsed.values['health-file'],
      checkMainHealth: true,
      fixesMain: parsed.flags.has('fixes-main'),
      expectedHead,
      usageLog: parsed.values['usage-log'],
      transcripts: parsed.repeated['transcript'] ?? [],
    },
  };
}

function finish(
  report: MergeGateReport,
  options: MergeGateOptions,
  json: boolean,
): { code: number; output: string } {
  return {
    code: report.failedStep === null ? 0 : 1,
    output: json ? JSON.stringify(report) : renderMergeGate(report, options.dryRun),
  };
}

/** Runs the gate without the merge lock; the command line uses `runExclusively`. */
export function run(
  argv: string[],
  dependencies: Partial<MergeGateDependencies> = {},
): { code: number; output: string } {
  const { options, json } = parseArguments(argv);
  return finish(mergeGate(options, dependencies), options, json);
}

/** Runs the gate under the cross-session merge lock (a dry run takes none). */
export async function runExclusively(
  argv: string[],
  dependencies: Partial<MergeGateDependencies> = {},
): Promise<{ code: number; output: string }> {
  const { options, json } = parseArguments(argv);
  const report = await mergeGateExclusively(options, dependencies, (holder) =>
    process.stderr.write(
      `merge-gate: waiting for the merge lock${holder === undefined ? '' : ` held by ${holder.command} (pid ${holder.pid})`}\n`,
    ),
  );
  return finish(report, options, json);
}

if (import.meta.main) {
  try {
    const { code, output } = await runExclusively(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
