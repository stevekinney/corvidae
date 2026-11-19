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
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { defaultRunner } from './process-runner.ts';
import {
  briefVersionIn,
  ledgerOf,
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
}): WorkerReport {
  const { issue, input, mainCheckout, worktree, branch } = options;
  const fields = typeof input === 'object' && input !== null ? input : {};
  let briefVersion: string | undefined;
  try {
    briefVersion = briefVersionIn(readFileSync(briefPathOf(mainCheckout, issue), 'utf8'));
  } catch {
    briefVersion = undefined;
  }
  const checked = validateReport({ ...fields, issue, briefVersion });
  if (!checked.ok)
    throw new ReportRefusal(
      `The report is not valid:\n${checked.errors.map((error) => `- ${error}`).join('\n')}${briefVersion === undefined ? `\n- the brief tmp/chef/briefs/${issue}.md has no "Brief version:" line` : ''}`,
    );
  const state = stateDirectoryOf(mainCheckout);
  writeWhole(reportPathOf(state, issue), `${JSON.stringify(checked.report)}\n`);
  writeWhole(ledgerPathOf(worktree, issue), ledgerText(ledgerOf(checked.report, branch)));
  return checked.report;
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
      });
      const unread = readCorrections(state, issue).filter(
        (entry) => !report.correctionsRead.includes(entry.id),
      );
      process.stdout.write(
        `report ${reportPathOf(state, issue)} written; ledger ${ledgerPathOf(worktree, issue)} written, commit it.${unread.length === 0 ? '' : ` Unread corrections: ${unread.map((entry) => entry.id).join(', ')} (${correctionsPathOf(state, issue)}).`}\n`,
      );
      return 0;
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
