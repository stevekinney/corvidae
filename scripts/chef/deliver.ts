#!/usr/bin/env bun
// Chef deliver: a change's whole post-acceptance lifecycle in one command, so a coordinator
// launches it once in the background instead of hand-running the merge, the Linear closeout and the
// worktree removal in turn. The change is a pull request (`--pr`) or, since the owner's 2026-11-11
// decision that a pull request is optional, a pushed branch merged straight into the default
// branch (`--branch`). Exactly one of the two is given.
//
// It runs no test gate and never merges the default branch into the change. The worker ran its
// focused checks before pushing, and GitHub Actions' full suite on every push to `main` is the
// backstop (AGENTS.md "Gate on local checks"), so the default branch moving is not a reason
// to repeat either.
//
// Usage:
//   bun scripts/chef/deliver.ts --pr <n> --worktree <dir> --comment-file <md> [--head <sha>]
//   bun scripts/chef/deliver.ts --branch <remote branch> --head <sha> --worktree <dir>
//                               --message-file <md>
//                               [--intended <path>]...
//                               [--issue <ID> --completion-file <md>]... [--closes <ID>]...
//                               [--keep-worktree]
//                               [--usage-log <file> --transcript <path>...]
//                               [--fixes-main] [--config <json>] [--json]
//   bun scripts/chef/deliver.ts --help
// The options after the --branch form go with either form, except that `--fixes-main` goes with
// `--pr` only: it records a pull request as a repair of a red `main`, and `--intended` goes with
// `--branch` only. `--help` prints this usage and exits 0.
//
// `--intended <path>` (repeatable) names a deletion or revert the change means to make: the `revert`
// step reports that path's finding as accepted instead of failing. Any other finding still fails the
// step, and a named path with no finding is an error, so a stale flag cannot hide a later revert.
//
// The steps run in order and stop at the first failure, which is named:
//   merge      with `--branch`, `direct-merge.ts`'s sequence under the merge lock a pull request
//              merge takes, which names its own failures: `head` (the remote branch is exactly
//              `--head`), `revert` (the revert check finds nothing), `conflict` (`git merge-tree`
//              builds the merged tree), `guards` (each guard of `lint:guards` passes on that tree, in a temporary
//              worktree, or fails only with findings `main` already has, which the report lists), `merge`
//              (one squash commit made with `git commit-tree` from `--message-file` and pushed to
//              the default branch; a rejected push changes nothing, so run it again) and `delete`
//              (the remote branch). No checkout is changed. With `--pr`,
//              `merge-gate.ts`'s own sequence with nothing reimplemented: the pull request is open
//              and its head is the worktree's HEAD and, with `--head`, the head pinned at
//              acceptance (step `head`); GitHub reports no conflict with the base (step `conflict`,
//              after waiting briefly while GitHub's mergeability is `UNKNOWN`); every review thread
//              is resolved, read with the paginated read (step `threads`); then the comment, the
//              merge pinned to the head, and the confirmation of the merged tree. A conflict is
//              reported and nothing is merged in: the worker resolves it and returns a new head. A
//              red `main` is a warning in the report, not a refusal;
//   issue      with `--issue` and `--completion-file`, each of which may repeat and which pair in
//              order (a combined pull request that carries several issues): for each issue in turn,
//              `linear.ts`'s comment, read back. The state moves to Done only for an issue the caller
//              also names with `--closes <ID>` (repeatable, and each must be one of the `--issue`
//              identifiers): a delivery that lands one part of an issue must not close it, and no
//              identifier is ever read from a pull request title, branch name or body. Without
//              `--closes` every issue's state is left alone, in `--pr` and `--branch` mode alike.
//              The first failure stops the step, leaves `merged` true, and names step `issue` and
//              the failing identifier; the report lists the issues closed before it. Every completion
//              file must be an execution report (`references/execution-report.md`), and the counts
//              must match: anything else is refused as invalid usage before the merge. Nothing here
//              stops Linear's own GitHub integration from moving an issue whose identifier a pull
//              request title or branch carries; that is outside the script;
//   worktree   unless `--keep-worktree`: `worktree.ts remove` of `--worktree` (its path, under any
//              root `remove` accepts), told that the worktree's tip is the commit just delivered
//              (the pinned `--head`, else the pull request's head), because a squash
//              or direct merge leaves that tip outside the default branch's history. Once nothing
//              else refuses the removal, it ends the processes whose working directory is inside
//              the worktree (SIGTERM, then SIGKILL), since the delivered worker is done. A worktree
//              it refuses (locked by a live session, uncommitted changes, a file held open inside
//              it by a process elsewhere, outside the roots) is kept and the line says why; that
//              never fails the delivery. A lock in the Agent tool's form
//              (`claude agent agent-<id> (pid ...)`) names the parent session, which outlives the
//              worker, so it does not keep a delivered, clean worktree with nothing running inside;
//   ledger     right after the merge, whatever the later steps do: the delivered head is appended to
//              `<main checkout>/tmp/chef/delivered-heads.log` (`delivery-ledger.ts`: time, `branch:<name>`
//              or `pr:<n>`, head, merge commit), which `worktree.ts stale` reads to know a squashed
//              worktree is delivered. Not behind a flag; a write failure is a warning line;
//   sweep      last: `worktree.ts stale --remove`, keeping every branch, which removes the finished
//              worktrees of earlier workers too and prints `swept: <n> removed, <m> kept`. A sweep
//              failure prints `swept: failed (...)` and never fails the delivery.
//
// Output: at most six lines, or with `--json` one object: pr, branch, merged, mergeCommit,
// mergeable, mainHealthWarning, guardsAlreadyFailing, failedStep, detail, worktree (`removed` and
// a `detail`), issues (each closed issue's identifier and state) and leftOpen (the commented issues whose state was not touched).
// The text output's last line before any failure says which issues were closed and which were left
// open, or that none was named. `pr` is null for a branch merge and `branch` null for a pull request merge. The
// usage-log line of a branch merge holds `branch:<name>` where a pull request's holds its number.
//
// Exit codes: 0 merged and every later step succeeded, 1 refused or a step failed (named), 2
// invalid CLI usage.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { recordDelivery, type LedgerEntry } from './delivery-ledger.ts';
import {
  directMergeExclusively,
  type DirectMergeOptions,
  type DirectMergeReport,
} from './direct-merge.ts';
import { createClient, LinearError, postComment, setState, type LinearClient } from './linear.ts';
import { mergeGateExclusively, type MergeGateOptions, type MergeGateReport } from './merge-gate.ts';
import { emitResult, parseOptions, requireOption, UsageError } from './process-runner.ts';
import { DEFAULT_CONFIGURATION_PATH, loadRepositoryConfig } from './repository-config.ts';
import { resolveMainCheckout } from './repository-locations.ts';
import {
  Refusal,
  removeWorktree,
  staleWorktrees,
  type RemoveOptions,
  type RemoveResult,
} from './worktree.ts';

export { UsageError };

export interface DeliverOptions {
  configPath: string;
  /** The pull request to merge; exactly one of `pr` and `branch` is given. */
  pr?: number | undefined;
  /** The pushed remote branch to merge straight into the default branch, with no pull request. */
  branch?: string | undefined;
  worktree: string;
  /** The comment posted on the pull request; required with `pr`, refused with `branch`. */
  commentFile?: string | undefined;
  /** The squash commit's message; required with `branch`, refused with `pr`. */
  messageFile?: string | undefined;
  /** The head pinned at acceptance; required with `branch`, which merges exactly this head. */
  expectedHead?: string | undefined;
  /** The issues to close after the merge, in order; each pairs with the completion file at its index. */
  issues?: string[] | undefined;
  /** One execution report per issue, in the same order as `issues`. */
  completionFiles?: string[] | undefined;
  /** The subset of `issues` to move to Done; every other issue gets its comment and keeps its state. */
  closes?: string[] | undefined;
  /** Paths whose `revert` finding is intended; `branch` only. */
  intended?: string[] | undefined;
  /** Keep the delivered worktree instead of removing it. */
  keepWorktree?: boolean | undefined;
  usageLog?: string | undefined;
  transcripts?: string[] | undefined;
  /** Declares this pull request a repair of a red `main`; forwarded to the merge gate. Refused with `branch`. */
  fixesMain?: boolean | undefined;
}

export interface DeliverReport {
  /** The pull request number, or `null` for a branch merge. */
  pr: number | null;
  /** The merged branch, or `null` for a pull request merge. */
  branch: string | null;
  merged: boolean;
  mergeCommit: string | null;
  /** GitHub's `mergeable` value at the last read; `null` when it was not read. */
  mergeable: string | null;
  /** Set when `main`'s latest `main.yml` run failed or could not be read: a warning, never a refusal. */
  mainHealthWarning: string | null;
  /**
   * Text guards that fail on the merged tree with only findings `main` already has (a branch merge
   * only): each guard and its finding count. Reported, not a refusal.
   */
  guardsAlreadyFailing: { guard: string; findings: number }[];
  failedStep: string | null;
  detail: string | null;
  /** The issues closed, in order, each with the Linear state it was left in. */
  issues: { identifier: string; state: string }[];
  /** The revert findings accepted because `--intended` named their path (a branch merge only). */
  acceptedReverts: string[];
  /** The issues commented on whose state was left alone, in order. */
  leftOpen: string[];
  /** What happened to the delivered worktree; `null` when the step did not run. */
  worktree: { removed: boolean; detail: string } | null;
  /** The sweep after the delivery: the counts, or the failure (never a failed delivery); `null` when it did not run. */
  swept: { removed: number; kept: number } | { failure: string } | null;
  /** Set when the delivered head could not be written to the ledger: a warning, never a failure. */
  ledgerWarning: string | null;
}

export interface DeliverDependencies {
  /** Merges through the merge gate, under the cross-session merge lock. */
  merge: (options: MergeGateOptions) => Promise<MergeGateReport>;
  /** Merges a branch straight into the default branch, under the same merge lock. */
  directMerge: (options: DirectMergeOptions) => Promise<DirectMergeReport>;
  /** The Linear client; the command line supplies `createClient()`, which reads the credentials. */
  client: LinearClient;
  remove: (options: RemoveOptions) => RemoveResult;
  /** Appends a delivered head to the delivery ledger (`delivery-ledger.ts`). */
  record: (entry: LedgerEntry) => void;
  /** The sweep of finished worktrees (`worktree.ts stale --remove`, keeping every branch). */
  sweep: (configPath: string) => { removed: number; kept: number };
}

/**
 * The level-2 headings of an execution report, in order. `references/execution-report.md` lists
 * the same headings, and `deliver.test.ts` keeps the two equal.
 */
export const executionReportHeadings = [
  'Execution status',
  'Agent and session',
  'Attempt',
  'Branch and pull request',
  'Requirements implemented',
  'Acceptance criteria',
  'Verification',
  'Changes',
  'Blockers and open questions',
  'Remaining work',
];

/**
 * What keeps `text` from being an execution report: a first line that is not the
 * `Execution report: <branch> attempt <n>` marker, or a required heading that is missing or out
 * of order. Empty when it is one.
 */
export function executionReportProblems(text: string): string[] {
  const problems: string[] = [];
  const first = text.split('\n').find((line) => line.trim() !== '') ?? '';
  if (!/^Execution report: \S+ attempt [1-9]\d*$/.test(first.trim()))
    problems.push('the first line is not "Execution report: <branch> attempt <n>"');
  const headings = [...text.matchAll(/^## (.+?)\s*$/gm)].map((match) => match[1] ?? '');
  let cursor = 0;
  for (const heading of executionReportHeadings) {
    const found = headings.indexOf(heading, cursor);
    if (found === -1) problems.push(`"## ${heading}" is missing or out of order`);
    else cursor = found + 1;
  }
  return problems;
}

/** `text` led by `identifier` unless it already is, so a failure names its issue exactly once. */
function named(identifier: string, text: string): string {
  return text.startsWith(`${identifier}:`) ? text : `${identifier}: ${text}`;
}

/** Run the lifecycle. Never throws for a failed step; the report names it. */
export async function deliver(
  options: DeliverOptions,
  partial: Partial<DeliverDependencies> = {},
): Promise<DeliverReport> {
  loadRepositoryConfig(options.configPath);
  if ((options.pr === undefined) === (options.branch === undefined))
    throw new UsageError('Give exactly one of --pr and --branch.');
  if (!existsSync(options.worktree)) throw new UsageError(`No such worktree: ${options.worktree}`);
  if (options.branch === undefined) {
    if (options.commentFile === undefined) throw new UsageError('--pr needs --comment-file.');
    if (options.messageFile !== undefined)
      throw new UsageError('--message-file applies only with --branch.');
    if (!existsSync(options.commentFile))
      throw new UsageError(`No such comment file: ${options.commentFile}`);
  } else {
    if (options.messageFile === undefined) throw new UsageError('--branch needs --message-file.');
    if (options.expectedHead === undefined) throw new UsageError('--branch needs --head.');
    if (options.commentFile !== undefined)
      throw new UsageError('--comment-file applies only with --pr.');
    if (options.fixesMain === true)
      throw new UsageError(
        '--fixes-main applies only with --pr: a branch merge compares every guard failure with origin/main on its own.',
      );
    if (!existsSync(options.messageFile))
      throw new UsageError(`No such message file: ${options.messageFile}`);
  }
  if (options.branch === undefined && (options.intended ?? []).length > 0)
    throw new UsageError('--intended applies only with --branch.');
  const issues = options.issues ?? [];
  const completionFiles = options.completionFiles ?? [];
  if (issues.length !== completionFiles.length)
    throw new UsageError(
      `--issue and --completion-file pair in order: got ${issues.length} issue(s) and ${completionFiles.length} completion file(s).`,
    );
  const duplicate = issues.find((identifier, index) => issues.indexOf(identifier) !== index);
  if (duplicate !== undefined) throw new UsageError(`--issue ${duplicate} is given twice.`);
  const closes = options.closes ?? [];
  const unlisted = closes.find((identifier) => !issues.includes(identifier));
  if (unlisted !== undefined)
    throw new UsageError(
      `--closes ${unlisted} names no --issue: a close needs its --issue and --completion-file.`,
    );
  const completions: string[] = [];
  for (const completionFile of completionFiles) {
    if (!existsSync(completionFile))
      throw new UsageError(`No such completion file: ${completionFile}`);
    const completion = readFileSync(completionFile, 'utf8');
    if (completion.trim() === '') throw new UsageError(`${completionFile} is empty.`);
    const problems = executionReportProblems(completion);
    if (problems.length > 0)
      throw new UsageError(
        `${completionFile} is not an execution report (references/execution-report.md): ${problems.join('; ')}.`,
      );
    completions.push(completion);
  }
  const report: DeliverReport = {
    pr: options.pr ?? null,
    branch: options.branch ?? null,
    merged: false,
    mergeCommit: null,
    mergeable: null,
    mainHealthWarning: null,
    guardsAlreadyFailing: [],
    failedStep: null,
    detail: null,
    issues: [],
    acceptedReverts: [],
    leftOpen: [],
    worktree: null,
    swept: null,
    ledgerWarning: null,
  };
  const fail = (step: string, detail: string): DeliverReport => {
    report.failedStep = step;
    report.detail = detail;
    return report;
  };

  // The commit this delivery lands: the pinned head, else the pull request's head, which the merge
  // gate requires to equal the worktree's HEAD. With neither, the ordinary delivered check applies.
  let deliveredTip: string | undefined = options.expectedHead;

  // ledger: whenever the merge happened, even if a later step of it failed (a branch merge whose
  // remote branch could not be deleted is merged), so a worktree holding the head is known to be
  // delivered after a squash leaves its tip outside the default branch's history.
  const writeLedger = () => {
    if (!report.merged || deliveredTip === undefined || partial.record === undefined) return;
    try {
      partial.record({
        pr: options.pr,
        branch: options.branch,
        head: deliveredTip,
        mergeCommit: report.mergeCommit,
      });
    } catch (error) {
      report.ledgerWarning = error instanceof Error ? error.message : String(error);
    }
  };

  // merge
  const usageFields =
    options.usageLog === undefined
      ? {}
      : { usageLog: options.usageLog, transcripts: options.transcripts ?? [] };
  if (options.branch !== undefined) {
    const directMerge = partial.directMerge;
    if (directMerge === undefined) return fail('merge', 'no direct merge runner was provided.');
    const direct = await directMerge({
      configPath: options.configPath,
      branch: options.branch,
      head: options.expectedHead ?? '',
      messageFile: options.messageFile ?? '',
      intended: options.intended ?? [],
      worktree: options.worktree,
      checkMainHealth: true,
      ...usageFields,
    });
    report.merged = direct.merged;
    report.mergeCommit = direct.mergeCommit;
    report.mainHealthWarning = direct.mainHealthWarning ?? null;
    report.guardsAlreadyFailing = direct.guardsAlreadyFailing ?? [];
    report.acceptedReverts = direct.acceptedReverts ?? [];
    if (direct.failedStep !== null) {
      writeLedger();
      return fail(direct.failedStep, direct.detail ?? '');
    }
  } else {
    const merge = partial.merge;
    if (merge === undefined) return fail('merge', 'no merge runner was provided.');
    const merged = await merge({
      configPath: options.configPath,
      pr: options.pr ?? 0,
      worktree: options.worktree,
      commentFile: options.commentFile ?? '',
      dryRun: false,
      checkMainHealth: true,
      expectedHead: options.expectedHead,
      fixesMain: options.fixesMain === true,
      ...usageFields,
    });
    report.merged = merged.merged;
    report.mergeCommit = merged.mergeCommit;
    report.mergeable = merged.mergeable;
    deliveredTip ??= merged.head ?? undefined;
    report.mainHealthWarning = merged.mainHealthWarning ?? null;
    if (merged.failedStep !== null) {
      writeLedger();
      return fail(merged.failedStep, merged.detail ?? '');
    }
  }
  writeLedger();

  // issue
  for (const [index, identifier] of issues.entries()) {
    try {
      const client = partial.client;
      if (client === undefined) return fail('issue', 'no Linear client was provided.');
      const comment = await postComment(client, identifier, completions[index] ?? '');
      if (!comment.ok) return fail('issue', named(identifier, comment.summary));
      if (!closes.includes(identifier)) {
        report.leftOpen.push(identifier);
        continue;
      }
      const state = await setState(client, identifier, 'Done');
      if (!state.ok) return fail('issue', named(identifier, state.summary));
      report.issues.push({ identifier, state: 'Done' });
    } catch (error) {
      if (!(error instanceof LinearError) && !(error instanceof UsageError)) throw error;
      return fail('issue', named(identifier, error.message));
    }
  }

  // worktree: removed by default; a worktree the removal refuses is kept, never a failed delivery.
  if (options.keepWorktree === true) {
    report.worktree = { removed: false, detail: 'kept by --keep-worktree' };
  } else {
    const remove = partial.remove;
    const path = resolve(options.worktree);
    if (remove === undefined) {
      report.worktree = { removed: false, detail: 'no worktree remover was provided.' };
    } else {
      try {
        const removed = remove({
          configPath: options.configPath,
          name: path,
          keepRemote: false,
          deliveredTip,
          // The delivered worker is done: what it left running inside its worktree is ended.
          endProcesses: true,
        });
        const ended = removed.ended.length;
        report.worktree = {
          removed: true,
          detail:
            ended === 0
              ? removed.path
              : `${removed.path} (ended ${ended} process(es) left running inside it)`,
        };
      } catch (error) {
        if (!(error instanceof Refusal) && !(error instanceof UsageError)) throw error;
        report.worktree = { removed: false, detail: error.message };
      }
    }
  }

  // sweep: finished worktrees of earlier workers go too; a failure here never fails the delivery.
  if (partial.sweep !== undefined) {
    try {
      report.swept = partial.sweep(options.configPath);
    } catch (error) {
      report.swept = { failure: error instanceof Error ? error.message : String(error) };
    }
  }
  return report;
}

export function renderDeliver(report: DeliverReport): string {
  const subject = report.branch === null ? `pr #${report.pr}` : `branch ${report.branch}`;
  const mergeable = report.branch === null ? ` mergeable=${report.mergeable ?? 'unread'}` : '';
  const lines = [
    `${subject} merged=${report.merged} mergeCommit=${report.mergeCommit?.slice(0, 12) ?? 'none'}${mergeable}`,
  ];
  if (report.worktree !== null)
    lines.push(
      `worktree ${report.worktree.removed ? 'removed' : 'kept'}: ${report.worktree.detail}`,
    );
  if (report.swept !== null)
    lines.push(
      'failure' in report.swept
        ? `swept: failed (${report.swept.failure})`
        : `swept: ${report.swept.removed} removed, ${report.swept.kept} kept`,
    );
  if (report.ledgerWarning !== null)
    lines.push(`WARNING delivery ledger: not written (${report.ledgerWarning})`);
  if (report.mainHealthWarning !== null)
    lines.push(`WARNING main health: ${report.mainHealthWarning}`);
  if (report.acceptedReverts.length > 0)
    lines.push(`revert accepted as intended: ${report.acceptedReverts.join('; ')}`);
  if (report.guardsAlreadyFailing.length > 0)
    lines.push(
      `WARNING guards: already failing on main, with no finding of this change's own: ${report.guardsAlreadyFailing.map((one) => `${one.guard} (${one.findings} output lines)`).join(', ')}`,
    );
  const closed = report.issues.map((one) => `${one.identifier} ${one.state}`).join(', ');
  if (report.issues.length > 0) lines.push(`issues: ${closed}`);
  if (report.leftOpen.length > 0)
    lines.push(
      `left open, state untouched: ${report.leftOpen.join(', ')} (close one with --closes <ID>)`,
    );
  if (report.issues.length === 0 && report.leftOpen.length === 0)
    lines.push('no issue closed or commented on (name one with --issue, close it with --closes)');
  if (report.failedStep !== null)
    lines.push(`FAILED at ${report.failedStep}: ${report.detail ?? ''}`);
  return lines.join('\n');
}

/** The header's usage block (from `Usage:` to the first blank comment line after the options). */
export function usageText(): string {
  const lines = readFileSync(import.meta.path, 'utf8').split('\n');
  const start = lines.findIndex((line) => line === '// Usage:');
  const end = lines.findIndex((line, index) => index > start && line === '//');
  return lines
    .slice(start, end === -1 ? undefined : end)
    .map((line) => line.replace(/^\/\/ ?/, ''))
    .join('\n');
}

export async function run(
  argv: string[],
  dependencies: Partial<DeliverDependencies> = {},
): Promise<{ code: number; output: string }> {
  const parsed = parseOptions(argv, {
    values: [
      'config',
      'pr',
      'branch',
      'worktree',
      'comment-file',
      'message-file',
      'head',
      'usage-log',
    ],
    repeated: ['transcript', 'issue', 'completion-file', 'closes', 'intended'],
    flags: ['keep-worktree', 'fixes-main', 'json', 'help'],
  });
  if (parsed.flags.has('help')) return { code: 0, output: usageText() };
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const pr = parsed.values['pr'];
  const branch = parsed.values['branch'];
  if ((pr === undefined) === (branch === undefined))
    throw new UsageError('Give exactly one of --pr and --branch.');
  if (pr !== undefined && !/^[1-9]\d*$/.test(pr))
    throw new UsageError(`"${pr}" is not a pull request number.`);
  const expectedHead = parsed.values['head'];
  if (expectedHead !== undefined && !/^[0-9a-f]{40}$/.test(expectedHead))
    throw new UsageError(`--head "${expectedHead}" is not a full commit SHA.`);
  const issues = parsed.repeated['issue'] ?? [];
  const completionFiles = parsed.repeated['completion-file'] ?? [];
  if (issues.length !== completionFiles.length)
    throw new UsageError(
      `--issue and --completion-file go together and pair in order: got ${issues.length} and ${completionFiles.length}.`,
    );
  const closes = parsed.repeated['closes'] ?? [];
  const usageLog = parsed.values['usage-log'];
  const transcripts = parsed.repeated['transcript'] ?? [];
  if ((usageLog === undefined) !== (transcripts.length === 0))
    throw new UsageError('--usage-log and --transcript go together.');
  const report = await deliver(
    {
      configPath: parsed.values['config'] ?? DEFAULT_CONFIGURATION_PATH,
      pr: pr === undefined ? undefined : Number(pr),
      branch,
      worktree: requireOption(parsed, 'worktree'),
      commentFile: parsed.values['comment-file'],
      messageFile: parsed.values['message-file'],
      expectedHead,
      issues,
      completionFiles,
      closes,
      intended: parsed.repeated['intended'] ?? [],
      usageLog,
      transcripts,
      fixesMain: parsed.flags.has('fixes-main'),
      keepWorktree: parsed.flags.has('keep-worktree'),
    },
    dependencies,
  );
  return {
    code: report.failedStep === null ? 0 : 1,
    output: parsed.flags.has('json') ? JSON.stringify(report) : renderDeliver(report),
  };
}

/** The real collaborators, built only by the command line so that tests never reach a process. */
function productionDependencies(): Partial<DeliverDependencies> {
  return {
    merge: (options) => mergeGateExclusively(options),
    directMerge: (options) =>
      directMergeExclusively(options, {}, (holder) =>
        process.stderr.write(
          `deliver: waiting for the merge lock${holder === undefined ? '' : ` held by ${holder.command} (pid ${holder.pid})`}\n`,
        ),
      ),
    remove: (options) => removeWorktree(options),
    record: (entry) => recordDelivery(resolveMainCheckout(), entry),
    sweep: (configPath) => {
      const result = staleWorktrees({ configPath, remove: true });
      return {
        removed: result.removed.length,
        kept: result.entries.length - result.removed.length,
      };
    },
    client: createClient(),
  };
}

if (import.meta.main) {
  try {
    const { code, output } = await run(Bun.argv.slice(2), productionDependencies());
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
