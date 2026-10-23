#!/usr/bin/env bun
// Chef merge gate: the whole verify, comment, merge and confirm sequence for one pull request, so
// a coordinator merges with one call instead of nine, and the merge cannot skip a check the
// hand-run sequence used to forget.
//
// Usage:
//   bun scripts/chef/merge-gate.ts [--config <json>] --pr <n> --worktree <dir> --gate-log <file>
//                                  --comment-file <md> [--dry-run] [--json]
//                                  [--usage-log <file> --transcript <path>...]
//
// The steps run in order and stop at the first failure, which is named:
//   1. fetch          `git fetch origin <default>`;
//   2. head           the worktree's HEAD equals the pull request's `headRefOid`, and it is open;
//   3. contains-base  HEAD contains `origin/<default>`, or else it merges cleanly with it
//                     (`git merge-tree --write-tree` exits 0) and no commit that landed on
//                     `origin/<default>` since the merge base lies in a workspace the pull request
//                     affects (`merge-overlap.ts`: its changed workspaces, their dependents and
//                     dependencies; `bun.lock`, the root manifest, `turbo.json` and the root
//                     `tsconfig*.json` touch everything). The refusal names which condition failed
//                     and the overlapping paths;
//   3b. main-health   `main`'s last batch validate (`main-health.ts`) at a head on `origin/<default>`'s
//                     first-parent history did not fail, unless the pull request is declared the fix
//                     with `--fixes-main`, which is recorded in the report and the health file;
//   4. gate           the gate log's exit code is 0, its HEAD equals the pull request's head, and the
//                     worktree was clean (`git status --porcelain` empty) at the start and at the end
//                     of the run with HEAD unmoved (start head = end head = the pull request's head);
//   5. threads        every review thread is resolved, and SEEN equals TOTAL;
//   6. refetch        fetch again; the step 3 base check still holds (the dependency graph is read
//                     from the gated commit and from `origin/<default>`, never from the worktree);
//   7. comment        post the comment file plus a `Base:` line from this final check (skipped with
//                     --dry-run);
//   8. merge          `gh pr merge --<method> --match-head-commit <head>` (skipped with --dry-run);
//   9. confirm        the pull request is MERGED, and `git diff --quiet <mergeCommit> <head>` holds,
//                     which is `treesMatch`. For a head that did not contain the base, the merge
//                     commit's tree must instead equal the `merge-tree` result tree (skipped with
//                     --dry-run).
//
// The report and the posted comment say which base path was used: "contains origin/<default>" or
// "merges cleanly with origin/<default> <sha>; intervening commits touch no affected workspace".
//
// Cross-session merge lock: unless --dry-run, the command line holds one exclusive lock in the Git
// common directory (`corvidae-merge-lock`, the lock of `scripts/run-exclusively.ts`) from before
// step 1 to after step 9, so two sessions never gate and merge at once. A waiting merge prints
// who holds it; a lock whose holder died is reclaimed.
//
// It prints { pr, head, base, gateRc, threads, merged, mergeCommit, treesMatch, failedStep }, plus
// basePath ("contains" or "merge-tree") and, for the latter, mergeTree.
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
// merged tree differs from the gated tree, 2 invalid CLI usage.

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
import { readGateLog } from './gate-run.ts';
import { mainHealth, recordFix, renderMainHealth, resolveHealthFile } from './main-health.ts';
import {
  overlappingFiles,
  readWorkspaceGraph,
  unionGraphs,
  type GraphSource,
} from './merge-overlap.ts';
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

export interface MergeGateOptions {
  configPath: string;
  pr: number;
  worktree: string;
  gateLog: string;
  commentFile: string;
  dryRun: boolean;
  /** The batch-validate record to check; defaults to the main checkout's when `checkMainHealth`. */
  healthFile?: string | undefined;
  /** Check main's health at the default location. Library callers opt in; the command line does. */
  checkMainHealth?: boolean | undefined;
  /** Declares this pull request the fix for a red `main`, so the main-health step lets it through. */
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
  /** How the head relates to the base: it contains it, or it merges cleanly with it. */
  basePath?: 'contains' | 'merge-tree';
  /** The tree `git merge-tree` computed for a head that does not contain the base. */
  mergeTree?: string;
  /** Whether the pull request was declared the fix for a red `main` (`--fixes-main`). */
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
}

interface PullRequestView {
  headRefOid?: unknown;
  mergeStateStatus?: unknown;
  state?: unknown;
  mergeCommit?: { oid?: unknown } | null;
}

/** One line saying which base path a report relied on. */
function describeBasePath(report: MergeGateReport, defaultBranch: string): string {
  return report.basePath === 'merge-tree'
    ? `merges cleanly with origin/${defaultBranch} ${report.base?.slice(0, 12) ?? 'unknown'}; intervening commits touch no affected workspace`
    : `contains origin/${defaultBranch}`;
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
  const changedFiles = (from: string, to: string): string[] | string => {
    const diff = git('diff', '--name-only', '--no-renames', from, to);
    return diff.code === 0
      ? diff.stdout.split('\n').filter((line) => line !== '')
      : `git diff ${from.slice(0, 12)}..${to.slice(0, 12)} failed (exit ${diff.code}): ${firstLine(diff.stderr)}`;
  };
  /**
   * Whether the head may be merged against the current base: it contains it, or it merges cleanly
   * and nothing that landed since touches a workspace the pull request affects. A string is the
   * reason it may not.
   */
  const checkBase = (): { path: 'contains' | 'merge-tree'; tree?: string } | string => {
    if (containsBase()) return { path: 'contains' };
    const remote = `origin/${defaultBranch}`;
    const refusal = `HEAD does not contain ${remote}`;
    const mergeTree = git('merge-tree', '--write-tree', remote, 'HEAD');
    if (mergeTree.code !== 0)
      return `${refusal} and does not merge cleanly with it (git merge-tree exit ${mergeTree.code}); merge it in and re-gate.`;
    const tree = mergeTree.stdout.split('\n')[0]?.trim() ?? '';
    if (!/^[0-9a-f]{40,64}$/.test(tree))
      return `${refusal}, and git merge-tree printed no tree to confirm the merge against.`;
    const mergeBase = git('merge-base', remote, 'HEAD');
    const baseSha = mergeBase.stdout.trim();
    if (mergeBase.code !== 0 || baseSha === '')
      return `${refusal}, and it has no merge base with it: ${firstLine(mergeBase.stderr)}`;
    const pullRequestFiles = changedFiles(baseSha, 'HEAD');
    if (typeof pullRequestFiles === 'string') return pullRequestFiles;
    const baseFiles = changedFiles(baseSha, remote);
    if (typeof baseFiles === 'string') return baseFiles;
    // Both sides come from commits, not from the worktree: the gated head, which a dirty worktree
    // may disagree with, and the default branch, where a dependency edge may have been added.
    const gitSource = (ref: string): GraphSource => ({
      read: (path) => {
        const shown = git('show', `${ref}:${path}`);
        return shown.code === 0 ? shown.stdout : undefined;
      },
      list: (directory) => {
        const listed = git('ls-tree', '--name-only', ref, `${directory}/`);
        return listed.code === 0
          ? listed.stdout
              .split('\n')
              .filter((line) => line !== '')
              .map((line) => line.slice(directory.length + 1))
          : [];
      },
    });
    const graph = unionGraphs(
      readWorkspaceGraph(gitSource('HEAD')),
      readWorkspaceGraph(gitSource(remote)),
    );
    const overlap = overlappingFiles(pullRequestFiles, baseFiles, graph);
    if (overlap.length > 0)
      return `${refusal}, and ${overlap.length} file(s) that landed on it since the merge base lie in workspaces this pull request affects, so the gate may not describe the merge: ${overlap.slice(0, 5).join(', ')}${overlap.length > 5 ? ', ...' : ''}. Merge it in and re-gate.`;
    return { path: 'merge-tree', tree };
  };

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
  const baseCheck = checkBase();
  if (typeof baseCheck === 'string') return fail('contains-base', baseCheck);
  report.basePath = baseCheck.path;
  if (baseCheck.tree !== undefined) report.mergeTree = baseCheck.tree;
  else delete report.mergeTree;

  // 3b. main-health
  const healthFile =
    options.healthFile ??
    (options.checkMainHealth === true ? resolveHealthFile(runner, options.worktree) : undefined);
  if (healthFile !== undefined) {
    const health = mainHealth(runner, options.worktree, defaultBranch, healthFile);
    if (health.red && health.run !== undefined) {
      if (options.fixesMain !== true)
        return fail(
          'main-health',
          `${renderMainHealth(health, defaultBranch)} Merge only the fix, declared with --fixes-main.`,
        );
      report.fixesMain = true;
      if (!options.dryRun)
        recordFix(healthFile, {
          pr: options.pr,
          time: (partial.now ?? (() => new Date()))().toISOString(),
          blockedHead: health.run.head,
        });
    }
  }

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

  // 6. refetch
  const refetchProblem = fetchBase('refetch');
  if (refetchProblem !== undefined) return fail('refetch', refetchProblem);
  const refetchCheck = checkBase();
  if (typeof refetchCheck === 'string')
    return fail('refetch', `${defaultBranch} moved: ${refetchCheck}`);
  report.basePath = refetchCheck.path;
  if (refetchCheck.tree !== undefined) report.mergeTree = refetchCheck.tree;
  else delete report.mergeTree;
  report.base = git('rev-parse', `origin/${defaultBranch}`).stdout.trim() || report.base;
  if (options.dryRun) return report;

  // 7. comment (after the refetch, so the note names the base that will actually be merged against)
  {
    // The comment says which base path the gate relied on, so a reader sees it was not a clean fast-forward.
    const commentDirectory = mkdtempSync(join(tmpdir(), 'merge-gate-comment-'));
    const commentBody = join(commentDirectory, 'comment.md');
    writeFileSync(
      commentBody,
      `${readFileSync(options.commentFile, 'utf8').trimEnd()}\n\nBase: ${describeBasePath(report, defaultBranch)}\n`,
    );
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
  if (report.basePath === 'merge-tree') {
    // The head never contained the base, so the squash commit's tree is compared with the clean
    // merge `git merge-tree` computed instead of with the head.
    const tree = git('rev-parse', `${mergeCommit}^{tree}`);
    if (tree.code !== 0)
      return fail('confirm', `could not read the merge commit's tree: ${firstLine(tree.stderr)}`);
    report.treesMatch = tree.stdout.trim() === report.mergeTree;
    if (!report.treesMatch)
      return fail(
        'confirm',
        `merged but the merge commit's tree differs from the clean merge of ${head.slice(0, 12)} with origin/${defaultBranch} that git merge-tree computed.`,
      );
  } else {
    const diff = git('diff', '--quiet', mergeCommit, head);
    if (diff.code > 1)
      return fail('confirm', `git diff failed (exit ${diff.code}): ${firstLine(diff.stderr)}`);
    report.treesMatch = diff.code === 0;
    if (!report.treesMatch)
      return fail(
        'confirm',
        `merged but the merge commit's tree differs from the gated head ${head.slice(0, 12)}.`,
      );
  }

  // 10. usage (optional): the spend record for this merge
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
 * `mergeGate` under the cross-session merge lock, so two sessions never gate and merge at once.
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
    `pr #${report.pr} head=${report.head?.slice(0, 12) ?? 'unknown'} base=${report.base?.slice(0, 12) ?? 'unknown'} gate rc=${report.gateRc ?? 'none'}`,
    `base path: ${report.basePath ?? 'not checked'}`,
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
    if (report.usage !== undefined)
      lines.push(
        `usage recorded: input=${report.usage.input} cachedInput=${report.usage.cachedInput} output=${report.usage.output}`,
      );
  }
  return lines.join('\n');
}

function parseArguments(argv: string[]): { options: MergeGateOptions; json: boolean } {
  const parsed = parseOptions(argv, {
    values: ['config', 'pr', 'worktree', 'gate-log', 'comment-file', 'usage-log', 'health-file'],
    repeated: ['transcript'],
    flags: ['dry-run', 'json', 'fixes-main'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const pr = requireOption(parsed, 'pr');
  if (!/^[1-9]\d*$/.test(pr)) throw new UsageError(`"${pr}" is not a pull request number.`);
  return {
    json: parsed.flags.has('json'),
    options: {
      configPath: parsed.values['config'] ?? DEFAULT_CONFIGURATION_PATH,
      pr: Number(pr),
      worktree: requireOption(parsed, 'worktree'),
      gateLog: requireOption(parsed, 'gate-log'),
      commentFile: requireOption(parsed, 'comment-file'),
      dryRun: parsed.flags.has('dry-run'),
      healthFile: parsed.values['health-file'],
      checkMainHealth: true,
      fixesMain: parsed.flags.has('fixes-main'),
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
