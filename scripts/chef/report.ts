#!/usr/bin/env bun
// Chef worker reports as files: the writer a `chef-worker` runs before it stops, and the owner
// feedback intake a coordinator runs while a worker is working.
//
//   bun scripts/chef/report.ts write <issue> --file <json> [--worktree <dir>] [--branch <name>]
//   bun scripts/chef/report.ts amend <issue> --branch <name> --text <text>
//   bun scripts/chef/report.ts attach <issue> <image file>
//
// `<issue>` is the brief's file stem (`COR-1`, or `COR-1_COR-2` for a batch).
//
// - `write` takes `{head, checks, status, reason?, criteria[], correctionsRead[]}`, adds the issue and
//   the brief version it reads from `tmp/chef/briefs/<issue>.md`, validates the whole against
//   `report-schema.ts`, writes `reports/<issue>.json` under the coordinator's execution state
//   (`<main checkout>/tmp/chef/execution-state`, never the worktree), and writes the durable
//   per-criterion ledger `documentation/criteria-ledger/<issue>.json` into the worktree for the
//   worker to commit. The ledger is committed, not gitignored `tmp/`: it travels with the branch
//   (met on the branch) and lands with it (met on `main`), and a re-inventory is a read of it.
// - `amend` records a post-dispatch amendment as a correction entry for the branch
//   (`corrections/<issue>.jsonl`); the stop hook refuses a worker's report until it lists the entry.
// - `attach` copies an owner screenshot into `attachments/<issue>/` under the same state and prints
//   its path, so a brief points at a path a reboot does not clear.
//
// Exit codes: 0 done, 1 refused (invalid report or text), 2 invalid usage.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { defaultRunner } from './process-runner.ts';
import {
  briefVersionIn,
  ledgerOf,
  unreadCorrections,
  validateReport,
  volatileImagePaths,
  type CorrectionEntry,
  type CriteriaLedger,
  type WorkerReport,
} from './report-schema.ts';
import { resolveMainCheckout } from './repository-locations.ts';

/** The coordinator's execution state, in the main checkout. */
export function stateDirectoryOf(mainCheckout: string): string {
  return join(mainCheckout, 'tmp', 'chef', 'execution-state');
}

export function briefPathOf(mainCheckout: string, issue: string): string {
  return join(mainCheckout, 'tmp', 'chef', 'briefs', `${issue}.md`);
}

export function reportPathOf(stateDirectory: string, issue: string): string {
  return join(stateDirectory, 'reports', `${issue}.json`);
}

function correctionsPathOf(stateDirectory: string, issue: string): string {
  return join(stateDirectory, 'corrections', `${issue}.jsonl`);
}

export function ledgerPathOf(worktree: string, issue: string): string {
  return join(worktree, 'documentation', 'criteria-ledger', `${issue}.json`);
}

/** Writes whole in one rename, so a hook never reads half a file. */
function writeWhole(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const staged = `${path}.${crypto.randomUUID()}`;
  writeFileSync(staged, content);
  renameSync(staged, path);
}

/** The report on disk, parsed, or `undefined` when there is none or it is not JSON. */
export function readReportFile(stateDirectory: string, issue: string): unknown {
  try {
    return JSON.parse(readFileSync(reportPathOf(stateDirectory, issue), 'utf8'));
  } catch {
    return undefined;
  }
}

export function readCorrections(stateDirectory: string, issue: string): CorrectionEntry[] {
  let text: string;
  try {
    text = readFileSync(correctionsPathOf(stateDirectory, issue), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CorrectionEntry);
}

export class ReportRefusal extends Error {}

/** Appends a correction entry for a branch; text that points at a volatile image path is refused. */
export function appendCorrection(
  stateDirectory: string,
  issue: string,
  input: { branch: string; text: string; at: Date },
): CorrectionEntry {
  const volatile = volatileImagePaths(input.text);
  if (volatile.length > 0)
    throw new ReportRefusal(
      `The amendment points at ${volatile.join(', ')}, which a reboot clears: store it with \`bun scripts/chef/report.ts attach ${issue} <file>\` and use the path that prints.`,
    );
  if (input.text.trim() === '') throw new ReportRefusal('An amendment has text.');
  const existing = readCorrections(stateDirectory, issue);
  const entry: CorrectionEntry = {
    id: `c${existing.length + 1}`,
    at: input.at.toISOString(),
    branch: input.branch,
    text: input.text,
  };
  writeWhole(
    correctionsPathOf(stateDirectory, issue),
    `${[...existing, entry].map((each) => JSON.stringify(each)).join('\n')}\n`,
  );
  return entry;
}

/** Copies an owner screenshot into the run's attachments; returns where it is now. */
export function attachScreenshot(stateDirectory: string, issue: string, source: string): string {
  if (!existsSync(source)) throw new ReportRefusal(`No such file: ${source}`);
  const directory = join(stateDirectory, 'attachments', issue);
  mkdirSync(directory, { recursive: true });
  const taken = readdirSync(directory).length;
  const target = join(directory, `${String(taken + 1).padStart(3, '0')}-${basename(source)}`);
  copyFileSync(source, target);
  return target;
}

export function ledgerText(ledger: CriteriaLedger): string {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

/**
 * Validates a worker's report input, writes the report under the execution state and the ledger
 * under the worktree. Returns the report; throws `ReportRefusal` naming every schema problem.
 */
export function writeReport(options: {
  issue: string;
  input: unknown;
  mainCheckout: string;
  worktree: string;
  branch: string;
  /** The `Brief version:` the worker read; the report is refused when the brief on disk differs. */
  briefVersion: string | undefined;
  at?: Date;
}): WorkerReport {
  const { issue, input, mainCheckout, worktree, branch } = options;
  const state = stateDirectoryOf(mainCheckout);
  const fields = typeof input === 'object' && input !== null ? input : {};
  let onDisk: string | undefined;
  try {
    onDisk = briefVersionIn(readFileSync(briefPathOf(mainCheckout, issue), 'utf8'));
  } catch {
    onDisk = undefined;
  }
  if (options.briefVersion === undefined)
    throw new ReportRefusal(
      `Pass --brief-version <the "Brief version:" line of tmp/chef/briefs/${issue}.md as you read it>; the report records the version you worked from, never the one on disk.`,
    );
  if (onDisk === undefined)
    throw new ReportRefusal(`The brief tmp/chef/briefs/${issue}.md has no "Brief version:" line.`);
  if (options.briefVersion !== onDisk) {
    const unread = readCorrections(state, issue).filter(
      (entry) =>
        !Array.isArray((fields as { correctionsRead?: unknown }).correctionsRead) ||
        !(fields as { correctionsRead: unknown[] }).correctionsRead.includes(entry.id),
    );
    throw new ReportRefusal(
      `The brief was amended after you read it: you read version ${options.briefVersion}, it is now ${onDisk}. Re-read tmp/chef/briefs/${issue}.md, act on the amendments${unread.length === 0 ? '' : ` (corrections ${unread.map((entry) => `${entry.id}: ${entry.text}`).join(' | ')})`}, and write the report with --brief-version ${onDisk}.`,
    );
  }
  const checked = validateReport({ ...fields, issue, briefVersion: options.briefVersion });
  if (!checked.ok)
    throw new ReportRefusal(
      `The report is not valid:\n${checked.errors.map((error) => `- ${error}`).join('\n')}`,
    );
  const written: WorkerReport = {
    ...checked.report,
    worktree,
    writtenAt: (options.at ?? new Date()).toISOString(),
  };
  writeWhole(reportPathOf(state, issue), `${JSON.stringify(written)}\n`);
  rmSync(escapePathOf(state, issue), { force: true });
  writeWhole(ledgerPathOf(worktree, issue), ledgerText(ledgerOf(written, branch)));
  return written;
}

/** Reads a git command's output in a directory; `undefined` when it fails. */
export type GitReader = (args: string[], cwd: string) => string | undefined;

export const defaultGit: GitReader = (args, cwd) => {
  const result = defaultRunner(['git', ...args], { cwd });
  return result.code === 0 ? result.stdout.trim() : undefined;
};

/** The marker the stop hook leaves when a worker went through after the block limit. */
export function escapePathOf(stateDirectory: string, issue: string): string {
  return join(stateDirectory, 'reports', `${issue}.escaped.json`);
}

const ledgerDirectory = 'documentation/criteria-ledger/';

/**
 * Whether the report's head is the target head, or the target only adds the ledger commit after it
 * (committing the ledger moves HEAD past the commit the criteria were checked at).
 */
function headProblem(
  report: WorkerReport,
  target: string | undefined,
  git: GitReader | undefined,
  strict: boolean,
): string | undefined {
  const worktree = report.worktree;
  if (worktree === undefined || git === undefined)
    return strict ? 'the report names no worktree to compare its head in' : undefined;
  const pushed = target ?? git(['rev-parse', 'HEAD'], worktree);
  if (pushed === undefined || pushed === '')
    return strict ? 'the worker head could not be read' : undefined;
  if (pushed.startsWith(report.head) || report.head.startsWith(pushed)) return undefined;
  const changed = git(['diff', '--name-only', `${report.head}..${pushed}`], worktree);
  if (changed === undefined)
    return strict
      ? `the report head ${report.head} could not be compared with ${pushed}`
      : undefined;
  const files = changed.split('\n').filter((line) => line !== '');
  if (files.length > 0 && files.every((file) => file.startsWith(ledgerDirectory))) return undefined;
  return `the report is for head ${report.head}, not the pushed head ${pushed}: it was left by an earlier worker or before your last commit, so write it again`;
}

/** Why a worker's report does not yet stand for its work, or `undefined` when it does. */
export function reportProblems(options: {
  stem: string;
  stateDirectory: string;
  briefsDirectory: string;
  git?: GitReader | undefined;
  /** The pushed head to compare with; else the head of the report's worktree. */
  head?: string | undefined;
  /** When this worker started, in milliseconds; a report written before it is another worker's. */
  workerStartedAt?: number | undefined;
  /** The workflow's check: a stop let through after the block limit, or a head it cannot read, fails. */
  strict?: boolean;
}): string[] | undefined {
  const { stem, stateDirectory, briefsDirectory } = options;
  const strict = options.strict === true;
  const escaped =
    strict && existsSync(escapePathOf(stateDirectory, stem))
      ? [
          `the worker's stop was let through after the block limit without a valid report (${escapePathOf(stateDirectory, stem)})`,
        ]
      : [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(reportPathOf(stateDirectory, stem), 'utf8'));
  } catch {
    return [`there is no readable report at ${reportPathOf(stateDirectory, stem)}`, ...escaped];
  }
  const checked = validateReport(raw);
  if (!checked.ok) return [...checked.errors, ...escaped];
  const report: WorkerReport = checked.report;
  const problems: string[] = [...escaped];
  if (report.issue !== stem) problems.push(`issue is ${stem}, not ${report.issue}`);
  let current: string | undefined;
  try {
    current = briefVersionIn(readFileSync(join(briefsDirectory, `${stem}.md`), 'utf8'));
  } catch {
    current = undefined;
  }
  if (current !== undefined && current !== report.briefVersion)
    problems.push(
      `the brief was amended after you read it (version ${current}, you read ${report.briefVersion}): re-read tmp/chef/briefs/${stem}.md and the corrections, and report again`,
    );
  const unread = unreadCorrections(readCorrections(stateDirectory, stem), report);
  if (unread.length > 0)
    problems.push(
      `corrections ${unread.map((entry) => entry.id).join(', ')} are unread (${unread.map((entry) => entry.text).join(' | ')}): act on them and list their ids in correctionsRead`,
    );
  const stale = headProblem(report, options.head, options.git, strict);
  if (stale !== undefined) problems.push(stale);
  if (options.workerStartedAt !== undefined) {
    const writtenAt = Date.parse(report.writtenAt ?? '');
    if (Number.isNaN(writtenAt) || writtenAt < options.workerStartedAt)
      problems.push(
        'the report was written before this worker started, so it is an earlier worker’s: write it again',
      );
  }
  return problems.length === 0 ? undefined : problems;
}

function option(argumentsList: readonly string[], name: string): string | undefined {
  const index = argumentsList.indexOf(name);
  return index === -1 ? undefined : argumentsList[index + 1];
}

function currentBranch(worktree: string): string {
  const result = defaultRunner(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktree });
  return result.code === 0 ? result.stdout.trim() : 'unknown';
}

function main(argumentsList: readonly string[]): number {
  const [command, issue, positional] = argumentsList;
  if (issue === undefined || !/^[A-Za-z0-9_-]+$/.test(issue)) {
    process.stderr.write('Usage: report.ts write|amend|attach <issue> ...\n');
    return 2;
  }
  const mainCheckout = resolveMainCheckout();
  const state = stateDirectoryOf(mainCheckout);
  try {
    if (command === 'write') {
      const file = option(argumentsList, '--file');
      if (file === undefined) {
        process.stderr.write('write needs --file <json>\n');
        return 2;
      }
      const worktree = option(argumentsList, '--worktree') ?? process.cwd();
      const report = writeReport({
        issue,
        input: JSON.parse(readFileSync(file, 'utf8')),
        mainCheckout,
        worktree,
        branch: option(argumentsList, '--branch') ?? currentBranch(worktree),
        briefVersion: option(argumentsList, '--brief-version'),
      });
      const unread = readCorrections(state, issue).filter(
        (entry) => !report.correctionsRead.includes(entry.id),
      );
      process.stdout.write(
        `report ${reportPathOf(state, issue)} written; ledger ${ledgerPathOf(worktree, issue)} written, commit it.${unread.length === 0 ? '' : ` Unread corrections: ${unread.map((entry) => entry.id).join(', ')} (${correctionsPathOf(state, issue)}).`}\n`,
      );
      return 0;
    }
    if (command === 'check') {
      // The workflow's gate on landing: the report must stand for the pushed head.
      const head = option(argumentsList, '--head');
      const problems = reportProblems({
        stem: issue,
        stateDirectory: state,
        briefsDirectory: join(mainCheckout, 'tmp', 'chef', 'briefs'),
        git: defaultGit,
        head,
        strict: true,
      });
      process.stdout.write(
        `${JSON.stringify({ ok: problems === undefined, problems: problems ?? [] })}\n`,
      );
      return problems === undefined ? 0 : 1;
    }
    if (command === 'amend') {
      const branch = option(argumentsList, '--branch');
      const text = option(argumentsList, '--text');
      if (branch === undefined || text === undefined) {
        process.stderr.write('amend needs --branch <name> and --text <text>\n');
        return 2;
      }
      const entry = appendCorrection(state, issue, { branch, text, at: new Date() });
      process.stdout.write(`correction ${entry.id} recorded for ${branch}\n`);
      return 0;
    }
    if (command === 'attach' && positional !== undefined) {
      process.stdout.write(`${attachScreenshot(state, issue, positional)}\n`);
      return 0;
    }
  } catch (error) {
    if (error instanceof ReportRefusal) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
  process.stderr.write('Usage: report.ts write|amend|attach <issue> ...\n');
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
