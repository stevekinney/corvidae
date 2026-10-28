#!/usr/bin/env bun
// Chef deliver: a pull request's whole post-acceptance lifecycle in one command, so a coordinator
// launches it once in the background instead of hand-running the merge gate, the Linear closeout
// and the worktree removal in turn.
//
// It runs no test gate and never merges the default branch into the pull request. The worker ran
// its focused checks before opening the pull request, and the per-batch `validate` on `main` is the
// backstop (AGENTS.md "Gate on local checks"), so the default branch moving is not a reason to
// repeat either.
//
// Usage:
//   bun scripts/chef/deliver.ts --pr <n> --worktree <dir> --comment-file <md> [--head <sha>]
//                               [--issue <ID> --completion-file <md>]
//                               [--remove-worktree --provider claude|codex --name <name>]
//                               [--usage-log <file> --transcript <path>...]
//                               [--fixes-main] [--config <json>] [--json]
//
// The steps run in order and stop at the first failure, which is named:
//   merge      `merge-gate.ts`'s own sequence with nothing reimplemented: the pull request is open
//              and its head is the worktree's HEAD and, with `--head`, the head pinned at
//              acceptance (step `head`); GitHub reports no conflict with the base (step `conflict`,
//              after waiting briefly while GitHub's mergeability is `UNKNOWN`); every review thread
//              is resolved, read with the paginated read (step `threads`); then the comment, the
//              merge pinned to the head, and the confirmation of the merged tree. A conflict is
//              reported and nothing is merged in: the worker resolves it and returns a new head. A
//              red `main` is a warning in the report, not a refusal;
//   issue      with `--issue` and `--completion-file`: `linear.ts`'s comment, then the state Done,
//              each read back. A failure leaves `merged` true and names step `issue`;
//   worktree   with `--remove-worktree`: `worktree.ts remove`, whose refusal is reported as step
//              `worktree` with `merged` still true.
//
// Output: at most five lines, or with `--json` one object: pr, merged, mergeCommit, mergeable,
// mainHealthWarning, failedStep, detail and issue.
//
// Exit codes: 0 merged and every later step succeeded, 1 refused or a step failed (named), 2
// invalid CLI usage.

import { existsSync, readFileSync } from 'node:fs';
import { createClient, LinearError, postComment, setState, type LinearClient } from './linear.ts';
import { mergeGateExclusively, type MergeGateOptions, type MergeGateReport } from './merge-gate.ts';
import { emitResult, parseOptions, requireOption, UsageError } from './process-runner.ts';
import { DEFAULT_CONFIGURATION_PATH, loadRepositoryConfig } from './repository-config.ts';
import {
  Refusal,
  removeWorktree,
  validateName,
  validateProvider,
  type RemoveOptions,
  type RemoveResult,
} from './worktree.ts';

export { UsageError };

export interface DeliverOptions {
  configPath: string;
  pr: number;
  worktree: string;
  commentFile: string;
  /** The head pinned at acceptance; the merge refuses when the pull request head differs. */
  expectedHead?: string | undefined;
  issue?: string | undefined;
  completionFile?: string | undefined;
  removeWorktree?: { provider: string; name: string } | undefined;
  usageLog?: string | undefined;
  transcripts?: string[] | undefined;
  /** Declares this pull request a repair of a red `main`; forwarded to the merge gate. */
  fixesMain?: boolean | undefined;
}

export interface DeliverReport {
  pr: number;
  merged: boolean;
  mergeCommit: string | null;
  /** GitHub's `mergeable` value at the last read; `null` when it was not read. */
  mergeable: string | null;
  /** Set when `main`'s last batch validate failed: a warning, never a refusal. */
  mainHealthWarning: string | null;
  failedStep: string | null;
  detail: string | null;
  /** The Linear state the issue was left in, or `null` when no issue was named or it failed. */
  issue: string | null;
}

export interface DeliverDependencies {
  /** Merges through the merge gate, under the cross-session merge lock. */
  merge: (options: MergeGateOptions) => Promise<MergeGateReport>;
  /** The Linear client; the command line supplies `createClient()`, which reads the credentials. */
  client: LinearClient;
  remove: (options: RemoveOptions) => RemoveResult;
}

/** Run the lifecycle. Never throws for a failed step; the report names it. */
export async function deliver(
  options: DeliverOptions,
  partial: Partial<DeliverDependencies> = {},
): Promise<DeliverReport> {
  loadRepositoryConfig(options.configPath);
  if (!existsSync(options.worktree)) throw new UsageError(`No such worktree: ${options.worktree}`);
  if (!existsSync(options.commentFile))
    throw new UsageError(`No such comment file: ${options.commentFile}`);
  if (options.issue !== undefined) {
    if (options.completionFile === undefined || !existsSync(options.completionFile))
      throw new UsageError(`No such completion file: ${options.completionFile ?? '(none)'}`);
    if (readFileSync(options.completionFile, 'utf8').trim() === '')
      throw new UsageError(`${options.completionFile} is empty.`);
  }
  const report: DeliverReport = {
    pr: options.pr,
    merged: false,
    mergeCommit: null,
    mergeable: null,
    mainHealthWarning: null,
    failedStep: null,
    detail: null,
    issue: null,
  };
  const fail = (step: string, detail: string): DeliverReport => {
    report.failedStep = step;
    report.detail = detail;
    return report;
  };

  // merge
  const merge = partial.merge;
  if (merge === undefined) return fail('merge', 'no merge runner was provided.');
  const merged = await merge({
    configPath: options.configPath,
    pr: options.pr,
    worktree: options.worktree,
    commentFile: options.commentFile,
    dryRun: false,
    checkMainHealth: true,
    expectedHead: options.expectedHead,
    fixesMain: options.fixesMain === true,
    ...(options.usageLog === undefined
      ? {}
      : { usageLog: options.usageLog, transcripts: options.transcripts ?? [] }),
  });
  report.merged = merged.merged;
  report.mergeCommit = merged.mergeCommit;
  report.mergeable = merged.mergeable;
  report.mainHealthWarning = merged.mainHealthWarning ?? null;
  if (merged.failedStep !== null) return fail(merged.failedStep, merged.detail ?? '');

  // issue
  if (options.issue !== undefined && options.completionFile !== undefined) {
    try {
      const client = partial.client;
      if (client === undefined) return fail('issue', 'no Linear client was provided.');
      const comment = await postComment(
        client,
        options.issue,
        readFileSync(options.completionFile, 'utf8'),
      );
      if (!comment.ok) return fail('issue', comment.summary);
      const state = await setState(client, options.issue, 'Done');
      if (!state.ok) return fail('issue', state.summary);
      report.issue = 'Done';
    } catch (error) {
      if (!(error instanceof LinearError) && !(error instanceof UsageError)) throw error;
      return fail('issue', error.message);
    }
  }

  // worktree
  if (options.removeWorktree !== undefined) {
    const remove = partial.remove;
    if (remove === undefined) return fail('worktree', 'no worktree remover was provided.');
    try {
      remove({
        configPath: options.configPath,
        provider: options.removeWorktree.provider,
        name: options.removeWorktree.name,
        keepRemote: false,
      });
    } catch (error) {
      if (!(error instanceof Refusal) && !(error instanceof UsageError)) throw error;
      return fail('worktree', error.message);
    }
  }
  return report;
}

export function renderDeliver(report: DeliverReport): string {
  const lines = [
    `pr #${report.pr} merged=${report.merged} mergeCommit=${report.mergeCommit?.slice(0, 12) ?? 'none'} mergeable=${report.mergeable ?? 'unread'}`,
  ];
  if (report.mainHealthWarning !== null)
    lines.push(`WARNING main health: ${report.mainHealthWarning}`);
  if (report.issue !== null) lines.push(`issue: ${report.issue}`);
  if (report.failedStep !== null)
    lines.push(`FAILED at ${report.failedStep}: ${report.detail ?? ''}`);
  return lines.join('\n');
}

export async function run(
  argv: string[],
  dependencies: Partial<DeliverDependencies> = {},
): Promise<{ code: number; output: string }> {
  const parsed = parseOptions(argv, {
    values: [
      'config',
      'pr',
      'worktree',
      'comment-file',
      'head',
      'issue',
      'completion-file',
      'usage-log',
      'provider',
      'name',
    ],
    repeated: ['transcript'],
    flags: ['remove-worktree', 'fixes-main', 'json'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const pr = requireOption(parsed, 'pr');
  if (!/^[1-9]\d*$/.test(pr)) throw new UsageError(`"${pr}" is not a pull request number.`);
  const expectedHead = parsed.values['head'];
  if (expectedHead !== undefined && !/^[0-9a-f]{40}$/.test(expectedHead))
    throw new UsageError(`--head "${expectedHead}" is not a full commit SHA.`);
  const issue = parsed.values['issue'];
  const completionFile = parsed.values['completion-file'];
  if ((issue === undefined) !== (completionFile === undefined))
    throw new UsageError('--issue and --completion-file go together.');
  const usageLog = parsed.values['usage-log'];
  const transcripts = parsed.repeated['transcript'] ?? [];
  if ((usageLog === undefined) !== (transcripts.length === 0))
    throw new UsageError('--usage-log and --transcript go together.');
  const remove = parsed.flags.has('remove-worktree');
  const provider = parsed.values['provider'];
  const name = parsed.values['name'];
  if (provider !== undefined) validateProvider(provider);
  if (name !== undefined) validateName(name, 'name', /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  if (remove && (provider === undefined || name === undefined))
    throw new UsageError('--remove-worktree needs --provider and --name.');
  if (!remove && (provider !== undefined || name !== undefined))
    throw new UsageError('--provider and --name apply only with --remove-worktree.');
  const report = await deliver(
    {
      configPath: parsed.values['config'] ?? DEFAULT_CONFIGURATION_PATH,
      pr: Number(pr),
      worktree: requireOption(parsed, 'worktree'),
      commentFile: requireOption(parsed, 'comment-file'),
      expectedHead,
      issue,
      completionFile,
      usageLog,
      transcripts,
      fixesMain: parsed.flags.has('fixes-main'),
      removeWorktree:
        remove && provider !== undefined && name !== undefined ? { provider, name } : undefined,
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
    remove: (options) => removeWorktree(options),
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
