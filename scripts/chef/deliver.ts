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
//                               [--max-attempts <n>] [--removed-names <file>]
//                               [--fixes-main | --waive-load-flake <reason> --control-head <sha>
//                                | --waive-main-health --reason <text>]
//                               [--config <json>] [--json]
//
// The steps run in order and stop at the first failure, which is named:
//   threads    every review thread is resolved, read with the same paginated read the merge gate
//              uses (SEEN must equal TOTAL). An unresolved thread stops delivery here, before
//              anything is fetched, merged, pushed or gated; the merge gate checks again at merge
//              time, because a bot can open a thread while the gate runs;
//   fetch      `git fetch origin <default>`, retried up to three times when Git cannot lock the ref;
//   base       `merge-gate.ts`'s base check on the worktree's head. When the head may not be merged
//              as it is, `origin/<default>` is merged into the branch (`git merge --no-edit`). A
//              conflict runs `git merge --abort` and refuses with step `conflict`, leaving the tree
//              as it was. A clean merge runs the install command from `repository.json`, then the
//              integration check (below), pushes the branch, and discards `--gate-log`, which
//              described the old head;
//   integration after a merge-in and before the push: the fast check that finds, in minutes, what
//              the full gate would find in an hour. It runs only when `origin/<default>` was merged
//              in. (1) With a `fastCheckCommand` in `repository.json`, it runs that command for the
//              workspaces both sides touched, as `integration-check.ts` defines them (the files this
//              branch changed since its previous base, against the files that landed on
//              `origin/<default>` since then: a workspace both changed, or one side's workspace that
//              consumes the other's). (2) With `--removed-names <file>` (one identifier per line,
//              `#` comments allowed), it searches the source files that landed on `origin/<default>`
//              since the previous base for those identifiers as member accesses, quoted keys or
//              object keys, which catches fixtures `tsc` cannot see (`Object.create`, spreads,
//              `as never`). A failure of either is step `integration`: the detail lists the failing
//              files or the `path:line (name)` hits and the log of the command's output, and the
//              branch is put back to its previous head (nothing was pushed), so a rerun sees the same
//              pending update;
//   gate       with no usable passing gate log at the current head (it exists, exits 0, names this
//              head and a clean tree at the start and end), runs the gate exactly as
//              `gate-run.ts run` does into `<log-dir>/gate-<shortsha>.log`. `--log-dir` defaults to
//              the directory of `--gate-log`, else `<worktree>/tmp/chef`. The gate is never retried:
//              when it fails, the failure is classified (below) and delivery stops;
//   merge      `merge-gate.ts`'s own sequence (comment file, threads, merge lock, tree check, and the
//              spend record when `--usage-log` and `--transcript` are given, together) with
//              nothing reimplemented; its failed step is reported as is;
//   issue      with `--issue` and `--completion-file`: `linear.ts`'s comment, then the state Done,
//              each read back. A failure leaves `merged` true and names step `issue`;
//   worktree   with `--remove-worktree`: `worktree.ts remove`, whose refusal is reported as step
//              `worktree` with `merged` still true.
//
// Gate failure classification: when the gate exits nonzero, `gate-failure.ts` runs
// `gate-run.ts triage` on the log against the merge base (which pull requests changed each failed
// package), then runs every failing test file alone, twice, on the pull request's head and on a
// detached worktree of `origin/<default>` (`gate-run.ts control`), and classifies the failure:
//   branch         a file fails alone on the head the way the gate saw it, and not on `main`;
//   main           a file fails the same way on `main` too (the failure is not this change's);
//   unreproduced   every file passes alone on both trees (load or a flake);
//   unclassified   no failing test file in the log (a lint or type-check failure), a file that could
//                  not be rerun, or one that fails alone in a different way.
// The step is `gate` and the report carries `classification` and `controlFiles`. Nothing is
// retried: the coordinator decides what each class means.
//
// `--fixes-main` declares the pull request the fix for a red `main`; `--waive-load-flake <reason>
// --control-head <sha>` waives a red `main` whose failure is a load flake; `--waive-main-health
// --reason <text>` merges past a red `main` for a stated reason (see `merge-gate.ts`). The three are
// exclusive and forwarded to the merge gate on every attempt; without one the merge gate refuses at
// main-health while `main` is red.
//
// Retry: threads, fetch, base, gate and merge are one attempt. When the merge gate refuses at
// `contains-base` (another session merged into the default branch during the gate), the whole
// attempt repeats: merge the new base in, install, check, push, gate again, merge. `--max-attempts`
// (default 3, minimum 1) caps the total attempts; every other refusal stops at once. Each attempt
// writes one line to standard error (attempt number, base sha, gate exit code), and the result
// carries `attempts`.
//
// Output: at most six lines, or with `--json` one object: pr, merged, mergeCommit, basePath,
// gateLog, failedStep, detail, issue, attempts, classification (the gate failure class, else null)
// and controlFiles. A gate failure adds a `classification:` line, one line per rerun file and the
// triage lines.
//
// Exit codes: 0 merged and every later step succeeded, 1 refused or a step failed (named; also a
// `branch` or `unclassified` gate failure), 2 invalid CLI usage, 3 the gate failed and the failure
// is `main`'s, 4 the gate failed and could not be reproduced (`unreproduced`).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fetchWithRetry } from './fetch-retry.ts';
import { classificationExitCode, type GateFailureClass } from './gate-classification.ts';
import { classifyGateFailure, type FileOutcome } from './gate-failure.ts';
import {
  readGateLog,
  runControl,
  runGate,
  workspaceDirectories,
  type ControlOptions,
  type ControlResult,
  type GateRunOptions,
  type GateRunResult,
} from './gate-run.ts';
import {
  expandFastCheck,
  failingFilesFromOutput,
  integrationWorkspaces,
  parseRemovedNames,
  removedNameHits,
} from './integration-check.ts';
import { createClient, LinearError, postComment, setState, type LinearClient } from './linear.ts';
import {
  checkMergeBase,
  mergeGateExclusively,
  parseLoadFlakeWaiver,
  parseMainHealthWaiver,
  type LoadFlakeWaiver,
  type MainHealthWaiver,
  type MergeGateOptions,
  type MergeGateReport,
} from './merge-gate.ts';
import { filesystemSource, readWorkspaceGraph } from './merge-overlap.ts';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  requireOption,
  UsageError,
  type Runner,
} from './process-runner.ts';
import { DEFAULT_CONFIGURATION_PATH, loadRepositoryConfig } from './repository-config.ts';
import { listThreads, ReviewThreadsError, type ThreadListing } from './review-threads.ts';
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
  /** Waives a red `main` whose failure is a load flake; forwarded to the merge gate. */
  loadFlakeWaiver?: LoadFlakeWaiver | undefined;
  /** Merges past a red `main` for a stated reason; forwarded to the merge gate. */
  mainHealthWaiver?: MainHealthWaiver | undefined;
  /** Identifiers this branch removed; the integration check searches the files that landed on main. */
  removedNames?: string[] | undefined;
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
  /** Whose failure a failed gate is; `null` when the gate did not fail. */
  classification: GateFailureClass | null;
  /** The failing test files that were rerun alone, with their verdicts. */
  controlFiles: { file: string; package: string | undefined; verdict: string }[];
  /** The triage lines for a failed gate: which pull requests changed each failed package. */
  triage: string | null;
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
  /** Reads every review thread of a pull request, paginated; `listThreads` in production. */
  threads: (repository: string, pr: number) => ThreadListing;
  /** Runs one command in two trees, as `gate-run.ts control` does; `runControl` in production. */
  control: (options: ControlOptions) => ControlResult;
  /** Receives one progress line per attempt; the command line writes it to standard error. */
  log: (line: string) => void;
  /** Blocks between fetch retries; defaults to `Bun.sleepSync`. */
  sleep: (milliseconds: number) => void;
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, 200);
}

function describeOutcome(outcome: FileOutcome): DeliverReport['controlFiles'][number] {
  return { file: outcome.file, package: outcome.package, verdict: outcome.verdict };
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
    classification: null,
    controlFiles: [],
    triage: null,
  };
  const fail = (step: string, detail: string): DeliverReport => {
    report.failedStep = step;
    report.detail = detail;
    return report;
  };
  const headOf = (): string => git('rev-parse', 'HEAD').stdout.trim();
  const logDirectory = (): string =>
    resolve(
      options.logDirectory ??
        (options.gateLog === undefined
          ? join(options.worktree, 'tmp', 'chef')
          : dirname(options.gateLog)),
    );
  const removedNames = options.removedNames ?? [];

  let gateLog = options.gateLog;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    report.attempts = attempt;
    // threads: an unresolved thread is known before any work is done, so stop before doing it
    const readThreads = partial.threads;
    if (readThreads === undefined) return fail('threads', 'no review-thread reader was provided.');
    let listing: ThreadListing;
    try {
      listing = readThreads(config.repository, options.pr);
    } catch (error) {
      if (!(error instanceof ReviewThreadsError)) throw error;
      return fail('threads', error.message);
    }
    if (listing.seen !== listing.total)
      return fail('threads', `read ${listing.seen} of ${listing.total} review threads.`);
    if (listing.unresolved > 0)
      return fail(
        'threads',
        `${listing.unresolved} review thread(s) are unresolved; answer and resolve them before the gate runs.`,
      );

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
      // What each side changed since the branch's previous base, read before the merge moves HEAD.
      const checksIntegration = config.fastCheckCommand !== undefined || removedNames.length > 0;
      const previousBase = checksIntegration ? git('merge-base', remote, 'HEAD').stdout.trim() : '';
      const changedSince = (to: string): string[] =>
        git('diff', '--name-only', '--no-renames', previousBase, to)
          .stdout.split('\n')
          .filter((line) => line !== '');
      const branchFiles = previousBase === '' ? [] : changedSince('HEAD');
      const incomingFiles = previousBase === '' ? [] : changedSince(remote);
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
      // integration: collisions between this branch and what landed on the default branch
      const collisions: string[] = [];
      if (removedNames.length > 0) {
        const hits = removedNameHits(options.worktree, incomingFiles, removedNames);
        if (hits.length > 0)
          collisions.push(
            `removed name(s) still used in files that landed on ${remote}: ${hits
              .slice(0, 20)
              .map((hit) => `${hit.path}:${hit.line} (${hit.name})`)
              .join(', ')}${hits.length > 20 ? `, and ${hits.length - 20} more` : ''}`,
          );
      }
      if (config.fastCheckCommand !== undefined) {
        const workspaces = integrationWorkspaces(
          branchFiles,
          incomingFiles,
          readWorkspaceGraph(filesystemSource(options.worktree)),
        );
        if (workspaces.length > 0) {
          const command = expandFastCheck(config.fastCheckCommand, workspaces);
          const checked = runner(['sh', '-c', command], { cwd: options.worktree });
          if (checked.code !== 0) {
            const output = `${checked.stdout}\n${checked.stderr}`;
            const logPath = join(logDirectory(), `integration-${headOf().slice(0, 12)}.log`);
            mkdirSync(dirname(logPath), { recursive: true });
            writeFileSync(logPath, `$ ${command}\n${output}\n`);
            const names = new Map(
              [...workspaceDirectories(options.worktree)].map(([name, directory]) => [
                name,
                directory,
              ]),
            );
            const files = failingFilesFromOutput(output, names);
            collisions.push(
              `${command} failed (exit ${checked.code}) in ${workspaces.join(', ')}${files.length > 0 ? `: ${files.join(', ')}` : `: ${firstLine(output)}`}; output in ${logPath}`,
            );
          }
        }
      }
      if (collisions.length > 0)
        return fail('integration', `${collisions.join('; ')}; ${restore()}.`);
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
      gateLog = join(logDirectory(), `gate-${head.slice(0, 12)}.log`);
      report.gateLog = gateLog;
      const gate = partial.gate;
      if (gate === undefined) return fail('gate', 'no gate runner was provided.');
      const result = await gate({
        configPath: options.configPath,
        worktree: options.worktree,
        log: gateLog,
      });
      log(`attempt ${attempt}: base ${baseSha} gate exit ${result.code}`);
      if (result.code !== 0) {
        // Classify the failure and stop: the gate is never run again on its own account.
        const control = partial.control;
        const failure = classifyGateFailure({
          runner,
          worktree: options.worktree,
          defaultBranch,
          installCommand: config.installCommand,
          controlRoot: config.worktreeRoots.claude,
          pr: options.pr,
          gateLog,
          logDirectory: logDirectory(),
          control:
            control ??
            (() => {
              throw new Error('no control runner was provided.');
            }),
        });
        report.classification = failure.classification;
        report.controlFiles = failure.files.map(describeOutcome);
        report.triage = failure.triage === '' ? null : failure.triage;
        return fail(
          'gate',
          `the gate exited ${result.code}; see ${gateLog}. The failure is ${failure.classification}${failure.notes.length > 0 ? ` (${failure.notes.join(' ')})` : ''}.`,
        );
      }
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
      loadFlakeWaiver: options.loadFlakeWaiver,
      mainHealthWaiver: options.mainHealthWaiver,
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
  if (report.classification !== null) {
    lines.push(`classification: ${report.classification}`);
    for (const file of report.controlFiles)
      lines.push(
        `  ${file.file}${file.package === undefined ? '' : ` (${file.package})`}: ${file.verdict}`,
      );
    if (report.triage !== null) lines.push(report.triage);
  }
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
      'waive-load-flake',
      'control-head',
      'reason',
      'removed-names',
    ],
    repeated: ['transcript'],
    flags: ['remove-worktree', 'fixes-main', 'waive-main-health', 'json'],
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
  const loadFlakeWaiver = parseLoadFlakeWaiver(
    parsed.values['waive-load-flake'],
    parsed.values['control-head'],
    parsed.flags.has('fixes-main'),
  );
  const mainHealthWaiver = parseMainHealthWaiver(
    parsed.flags.has('waive-main-health'),
    parsed.values['reason'],
    parsed.flags.has('fixes-main'),
    loadFlakeWaiver,
  );
  const removedNamesFile = parsed.values['removed-names'];
  if (removedNamesFile !== undefined && !existsSync(removedNamesFile))
    throw new UsageError(`No such removed-names file: ${removedNamesFile}`);
  const removedNames =
    removedNamesFile === undefined
      ? undefined
      : parseRemovedNames(readFileSync(removedNamesFile, 'utf8'));
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
      loadFlakeWaiver,
      mainHealthWaiver,
      removedNames,
      removeWorktree:
        remove && provider !== undefined && name !== undefined ? { provider, name } : undefined,
    },
    dependencies,
  );
  const code =
    report.failedStep === null
      ? 0
      : report.failedStep === 'gate' && report.classification !== null
        ? classificationExitCode(report.classification)
        : 1;
  return {
    code,
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
    threads: (repository, pr) => listThreads(repository, pr),
    control: (options) => runControl(options),
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
