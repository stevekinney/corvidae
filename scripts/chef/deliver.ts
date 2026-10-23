#!/usr/bin/env bun
// Chef deliver: a pull request's whole post-review lifecycle in one command, so a coordinator
// launches it once in the background instead of hand-running fetch, merge, install, push, gate,
// merge-gate, the Linear closeout and the worktree removal in turn.
//
// Usage:
//   bun scripts/chef/deliver.ts --pr <n> --worktree <dir> --comment-file <md> [--gate-log <log>]
//                               [--log-dir <dir>] [--issue <ID> --completion-file <md>]
//                               [--remove-worktree --provider claude|codex --name <name>]
//                               [--usage-log <file> --transcript <path>...]
//                               [--max-attempts <n>] [--fixes-main] [--config <json>] [--json]
//
// The steps run in order and stop at the first failure, which is named:
//   fetch      `git fetch origin <default>`, retried up to three times when Git cannot lock the ref;
//   base       `merge-gate.ts`'s base check on the worktree's head. When the head may not be merged
//              as it is, `origin/<default>` is merged into the branch (`git merge --no-edit`). A
//              conflict runs `git merge --abort` and refuses with step `conflict`, leaving the tree
//              as it was. A clean merge runs the install command from `repository.json`, pushes the
//              branch, and discards `--gate-log`, which described the old head;
//   gate       with no usable passing gate log at the current head (it exists, exits 0, names this
//              head and a clean tree at the start and end), runs the gate exactly as
//              `gate-run.ts run` does into `<log-dir>/gate-<shortsha>.log`. `--log-dir` defaults to
//              the directory of `--gate-log`, else `<worktree>/tmp/chef`;
//   merge      `merge-gate.ts`'s own sequence (comment file, threads, merge lock, tree check, and the
//              spend record when `--usage-log` and `--transcript` are given, together) with
//              nothing reimplemented; its failed step is reported as is;
//   issue      with `--issue` and `--completion-file`: `linear.ts`'s comment, then the state Done,
//              each read back. A failure leaves `merged` true and names step `issue`;
//   worktree   with `--remove-worktree`: `worktree.ts remove`, whose refusal is reported as step
//              `worktree` with `merged` still true.
//
// `--fixes-main` declares the pull request the fix for a red `main` and is forwarded to the
// merge gate on every attempt; without it the merge gate refuses at main-health while `main` is red.
//
// Retry: fetch, base, gate and merge are one attempt. When the merge gate refuses at `contains-base`
// (another session merged into the default branch during the gate), the whole attempt repeats: merge
// the new base in, install, push, gate again, merge. `--max-attempts` (default 3, minimum 1) caps the
// total attempts; every other refusal stops at once. Each attempt writes one line to standard error
// (attempt number, base sha, gate exit code), and the result carries `attempts`.
//
// Output: at most six lines, or with `--json` one object: pr, merged, mergeCommit, basePath,
// gateLog, failedStep, detail, issue and attempts (the Linear state it was left in, or null).
//
// Exit codes: 0 merged and every later step succeeded, 1 refused or a step failed (named), 2 invalid
// CLI usage.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fetchWithRetry } from './fetch-retry.ts';
import { readGateLog, runGate, type GateRunOptions, type GateRunResult } from './gate-run.ts';
import { createClient, LinearError, postComment, setState, type LinearClient } from './linear.ts';
import {
  checkMergeBase,
  mergeGateExclusively,
  type MergeGateOptions,
  type MergeGateReport,
} from './merge-gate.ts';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  requireOption,
  UsageError,
  type Runner,
} from './process-runner.ts';
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

/** Total attempts at base, gate and merge when the base keeps moving during the gate. */
const DEFAULT_MAX_ATTEMPTS = 3;

export interface DeliverOptions {
  configPath: string;
  pr: number;
  worktree: string;
  commentFile: string;
  gateLog?: string | undefined;
  logDirectory?: string | undefined;
  issue?: string | undefined;
  completionFile?: string | undefined;
  removeWorktree?: { provider: string; name: string } | undefined;
  usageLog?: string | undefined;
  transcripts?: string[] | undefined;
  /** Total attempts when the base moves during the gate; defaults to 3, minimum 1. */
  maxAttempts?: number | undefined;
  /** Declares this pull request the fix for a red `main`; forwarded to the merge gate. */
  fixesMain?: boolean | undefined;
}

export interface DeliverReport {
  pr: number;
  merged: boolean;
  mergeCommit: string | null;
  basePath: string | null;
  gateLog: string | null;
  failedStep: string | null;
  detail: string | null;
  /** The Linear state the issue was left in, or `null` when no issue was named or it failed. */
  issue: string | null;
  /** How many times base, gate and merge ran: more than 1 only when the base moved mid-gate. */
  attempts: number;
}

export interface DeliverDependencies {
  /** Runs git and the install command; defaults to the real process runner. */
  runner: Runner;
  /** Runs the gate into a log, as `gate-run.ts run` does. */
  gate: (options: GateRunOptions) => Promise<GateRunResult>;
  /** Merges through the merge gate, under the cross-session merge lock. */
  merge: (options: MergeGateOptions) => Promise<MergeGateReport>;
  /** The Linear client; the command line supplies `createClient()`, which reads the credentials. */
  client: LinearClient;
  remove: (options: RemoveOptions) => RemoveResult;
  /** Receives one progress line per attempt; the command line writes it to standard error. */
  log: (line: string) => void;
  /** Blocks between fetch retries; defaults to `Bun.sleepSync`. */
  sleep: (milliseconds: number) => void;
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, 200);
}

/** Why `path` is not a usable passing gate log for `head`, or `undefined` when it is one. */
function unusableGateLog(path: string | undefined, head: string): string | undefined {
  if (path === undefined) return 'no gate log was given';
  if (!existsSync(path)) return `${path} does not exist`;
  const summary = readGateLog(readFileSync(path, 'utf8'));
  if (summary.exitCode !== 0) return `${path} does not hold exit code 0`;
  if (summary.head !== head) return `${path} was run at another commit`;
  for (const tree of [summary.treeStart, summary.treeEnd]) {
    if (tree === undefined || tree.clean !== true || tree.head !== head)
      return `${path} does not show a clean tree at ${head.slice(0, 12)}`;
  }
  return undefined;
}

/** Run the lifecycle. Never throws for a failed step; the report names it. */
export async function deliver(
  options: DeliverOptions,
  partial: Partial<DeliverDependencies> = {},
): Promise<DeliverReport> {
  const runner = partial.runner ?? defaultRunner;
  const log = partial.log ?? (() => undefined);
  const config = loadRepositoryConfig(options.configPath);
  if (!existsSync(options.worktree)) throw new UsageError(`No such worktree: ${options.worktree}`);
  if (!existsSync(options.commentFile))
    throw new UsageError(`No such comment file: ${options.commentFile}`);
  if (options.issue !== undefined) {
    if (options.completionFile === undefined || !existsSync(options.completionFile))
      throw new UsageError(`No such completion file: ${options.completionFile ?? '(none)'}`);
    if (readFileSync(options.completionFile, 'utf8').trim() === '')
      throw new UsageError(`${options.completionFile} is empty.`);
  }
  const { defaultBranch } = config;
  const remote = `origin/${defaultBranch}`;
  const git = (...args: string[]) => runner(['git', ...args], { cwd: options.worktree });
  const report: DeliverReport = {
    pr: options.pr,
    merged: false,
    mergeCommit: null,
    basePath: null,
    gateLog: options.gateLog ?? null,
    failedStep: null,
    detail: null,
    issue: null,
    attempts: 0,
  };
  const fail = (step: string, detail: string): DeliverReport => {
    report.failedStep = step;
    report.detail = detail;
    return report;
  };
  const headOf = (): string => git('rev-parse', 'HEAD').stdout.trim();

  let gateLog = options.gateLog;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    report.attempts = attempt;
    // fetch
    const fetched = fetchWithRetry(() => git('fetch', 'origin', defaultBranch), {
      sleep: partial.sleep,
    });
    if (fetched.code !== 0)
      return fail(
        'fetch',
        `git fetch origin ${defaultBranch} failed (exit ${fetched.code}): ${firstLine(fetched.stderr)}`,
      );

    // base
    const baseCheck = checkMergeBase(runner, options.worktree, defaultBranch);
    if (typeof baseCheck === 'string') {
      const status = git('status', '--porcelain');
      if (status.code !== 0 || status.stdout.trim() !== '')
        return fail(
          'base',
          `${baseCheck} The worktree is not clean, so ${remote} was not merged in.`,
        );
      const previousHead = headOf();
      const merged = git('merge', '--no-edit', remote);
      if (merged.code !== 0) {
        const aborted = git('merge', '--abort');
        return fail(
          'conflict',
          `merging ${remote} conflicts${aborted.code === 0 ? '; the merge was aborted and the tree is unchanged' : `; git merge --abort failed (exit ${aborted.code}): ${firstLine(aborted.stderr)}`}.`,
        );
      }
      const installed = runner(['sh', '-c', config.installCommand], { cwd: options.worktree });
      // A failure after the merge-in puts the branch back, so a rerun sees the same pending update
      // instead of a local merge commit that was never pushed.
      const restore = (): string => {
        const reset = git('reset', '--hard', previousHead);
        return reset.code === 0
          ? 'the branch was restored to its previous head'
          : `git reset --hard ${previousHead.slice(0, 12)} failed (exit ${reset.code}): ${firstLine(reset.stderr)}`;
      };
      if (installed.code !== 0)
        return fail(
          'install',
          `${config.installCommand} failed (exit ${installed.code}): ${firstLine(installed.stderr || installed.stdout)}; ${restore()}.`,
        );
      const pushed = git('push', 'origin', 'HEAD');
      if (pushed.code !== 0)
        return fail(
          'push',
          `git push failed (exit ${pushed.code}): ${firstLine(pushed.stderr)}; ${restore()}.`,
        );
      // The old log describes the previous head, so it must never be offered to the merge gate.
      if (gateLog !== undefined) rmSync(gateLog, { force: true });
      gateLog = undefined;
      report.gateLog = null;
    }

    // gate
    const head = headOf();
    const baseSha = git('rev-parse', remote).stdout.trim().slice(0, 12);
    if (head === '') return fail('gate', `${options.worktree} has no readable HEAD.`);
    if (unusableGateLog(gateLog, head) !== undefined || gateLog === undefined) {
      const directory = resolve(
        options.logDirectory ??
          (options.gateLog === undefined
            ? join(options.worktree, 'tmp', 'chef')
            : dirname(options.gateLog)),
      );
      gateLog = join(directory, `gate-${head.slice(0, 12)}.log`);
      report.gateLog = gateLog;
      const gate = partial.gate;
      if (gate === undefined) return fail('gate', 'no gate runner was provided.');
      const result = await gate({
        configPath: options.configPath,
        worktree: options.worktree,
        log: gateLog,
      });
      log(`attempt ${attempt}: base ${baseSha} gate exit ${result.code}`);
      if (result.code !== 0) return fail('gate', `the gate exited ${result.code}; see ${gateLog}.`);
    } else log(`attempt ${attempt}: base ${baseSha} gate exit 0 (log reused)`);

    // merge
    const merge = partial.merge;
    if (merge === undefined) return fail('merge', 'no merge runner was provided.');
    const merged = await merge({
      configPath: options.configPath,
      pr: options.pr,
      worktree: options.worktree,
      gateLog,
      commentFile: options.commentFile,
      dryRun: false,
      checkMainHealth: true,
      fixesMain: options.fixesMain === true,
      ...(options.usageLog === undefined
        ? {}
        : { usageLog: options.usageLog, transcripts: options.transcripts ?? [] }),
    });
    // The base moved while the gate ran: merge it in, install, push and gate again.
    if (merged.failedStep === 'contains-base' && attempt < maxAttempts) continue;
    report.merged = merged.merged;
    report.mergeCommit = merged.mergeCommit;
    report.basePath = merged.basePath ?? null;
    if (merged.failedStep !== null) return fail(merged.failedStep, merged.detail ?? '');

    break;
  }

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
    `pr #${report.pr} merged=${report.merged} mergeCommit=${report.mergeCommit?.slice(0, 12) ?? 'none'} basePath=${report.basePath ?? 'none'}`,
    `gate log: ${report.gateLog ?? 'none'}`,
  ];
  if (report.attempts > 1) lines.push(`attempts: ${report.attempts}`);
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
      'gate-log',
      'log-dir',
      'issue',
      'completion-file',
      'usage-log',
      'provider',
      'name',
      'max-attempts',
    ],
    repeated: ['transcript'],
    flags: ['remove-worktree', 'fixes-main', 'json'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const pr = requireOption(parsed, 'pr');
  if (!/^[1-9]\d*$/.test(pr)) throw new UsageError(`"${pr}" is not a pull request number.`);
  const issue = parsed.values['issue'];
  const completionFile = parsed.values['completion-file'];
  if ((issue === undefined) !== (completionFile === undefined))
    throw new UsageError('--issue and --completion-file go together.');
  const usageLog = parsed.values['usage-log'];
  const transcripts = parsed.repeated['transcript'] ?? [];
  if ((usageLog === undefined) !== (transcripts.length === 0))
    throw new UsageError('--usage-log and --transcript go together.');
  const maxAttemptsText = parsed.values['max-attempts'];
  if (maxAttemptsText !== undefined && !/^[1-9]\d*$/.test(maxAttemptsText))
    throw new UsageError(`"${maxAttemptsText}" is not an attempt count of at least 1.`);
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
      gateLog: parsed.values['gate-log'],
      logDirectory: parsed.values['log-dir'],
      issue,
      completionFile,
      usageLog,
      transcripts,
      maxAttempts: maxAttemptsText === undefined ? undefined : Number(maxAttemptsText),
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
    runner: defaultRunner,
    gate: (options) => runGate(options),
    merge: (options) => mergeGateExclusively(options),
    remove: (options) => removeWorktree(options),
    client: createClient(),
    log: (line) => process.stderr.write(`${line}\n`),
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
