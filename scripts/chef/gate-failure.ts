// Chef gate failure: answers "the gate failed on this pull request; whose failure is it?" without a
// person re-running the whole gate to find out. `deliver.ts` calls it when the gate exits nonzero.
//
// It reads the gate log (`gate-classification.ts` finds the failing test files), maps the failed
// turbo tasks to the pull requests that changed their packages since the merge base
// (`gate-run.ts triage`), then runs each failing test file alone, twice, on the pull request's head
// and on a detached worktree of `origin/<default>` (`gate-run.ts control`), and classifies the
// failure as branch, main, unreproduced or unclassified (see `gate-classification.ts`). The main
// tree is `<worktree root>/delivery-control-pr<n>`, made for this call with `git worktree add
// --detach`, installed with the configuration's `installCommand`, and removed with a plain `git
// worktree remove` (which refuses a dirty tree, so nothing is forced); a tree left by an earlier run
// is moved to the new commit and left in place. The pull request's own worktree is never touched.
//
// The command for one file is the package's own `test` script reduced to that file
// (`testFileCommand`); a package whose script it cannot reduce falls back to a bare `bun test`,
// which fails in a way that is reported as indeterminate. A failure with no failing test file (a
// lint or type-check failure) runs nothing and is unclassified.
//
// This module is a library; it has no command line.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyFailure,
  failingTestFiles,
  fileVerdict,
  testFileCommand,
  type FileVerdict,
  type GateFailureClass,
} from './gate-classification.ts';
import {
  renderTriage,
  triageGateLog,
  workspaceDirectories,
  type ControlOptions,
  type ControlResult,
} from './gate-run.ts';
import { type Runner } from './process-runner.ts';

/** How many times each tree runs a failing file; two separates a failure from a flake cheaply. */
export const controlIterations = 2;

export interface GateFailureInputs {
  runner: Runner;
  /** The pull request's worktree: the candidate tree, and where Git commands run. */
  worktree: string;
  defaultBranch: string;
  installCommand: string;
  /** The directory the main tree is made in (the claude worktree root). */
  controlRoot: string;
  pr: number;
  gateLog: string;
  /** Where the control runs' TSV logs go. */
  logDirectory: string;
  /** Runs a command in both trees; `gate-run.ts`'s `runControl` in production. */
  control: (options: ControlOptions) => ControlResult;
}

export interface FileOutcome {
  file: string;
  package: string | undefined;
  /** The workspace directory the file was run in, or `undefined` when it could not be placed. */
  directory: string | undefined;
  verdict: FileVerdict;
  candidateFailures: number;
  baseFailures: number;
}

export interface GateFailureReport {
  classification: GateFailureClass;
  files: FileOutcome[];
  /** `gate-run.ts triage`'s lines for the failed turbo tasks, or empty. */
  triage: string;
  /** Anything that kept a part of the classification from running. */
  notes: string[];
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim().slice(0, 200);
}

function readManifest(directory: string): { name?: string; scripts?: Record<string, string> } {
  try {
    return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** The main tree, made or moved to `sha`; a string is why it could not be. */
function prepareMainTree(
  inputs: GateFailureInputs,
  sha: string,
): { path: string; created: boolean } | string {
  const path = join(inputs.controlRoot, `delivery-control-pr${inputs.pr}`);
  const created = !existsSync(path);
  const moved = created
    ? inputs.runner(['git', 'worktree', 'add', '--detach', path, sha], { cwd: inputs.worktree })
    : inputs.runner(['git', 'checkout', '--detach', sha], { cwd: path });
  if (moved.code !== 0)
    return `${created ? `git worktree add ${path}` : `moving ${path} to ${sha.slice(0, 12)}`} failed: ${firstLine(moved.stderr)}`;
  const installed = inputs.runner(['sh', '-c', inputs.installCommand], { cwd: path });
  if (installed.code !== 0) {
    if (created) inputs.runner(['git', 'worktree', 'remove', path], { cwd: inputs.worktree });
    return `${inputs.installCommand} failed in ${path}: ${firstLine(installed.stderr || installed.stdout)}`;
  }
  return { path, created };
}

/** Classify a failed gate. Never throws for a failed step; the report's notes say what did not run. */
export function classifyGateFailure(inputs: GateFailureInputs): GateFailureReport {
  const report: GateFailureReport = {
    classification: 'unclassified',
    files: [],
    triage: '',
    notes: [],
  };
  let text: string;
  try {
    text = readFileSync(inputs.gateLog, 'utf8');
  } catch {
    report.notes.push(`${inputs.gateLog} could not be read.`);
    return report;
  }
  const git = (...args: string[]) => inputs.runner(['git', ...args], { cwd: inputs.worktree });
  const remote = `origin/${inputs.defaultBranch}`;

  const mergeBase = git('merge-base', remote, 'HEAD');
  if (mergeBase.code === 0 && mergeBase.stdout.trim() !== '') {
    try {
      report.triage = renderTriage(
        triageGateLog(text, mergeBase.stdout.trim(), inputs.worktree, inputs.runner),
      );
    } catch (error) {
      report.notes.push(`triage: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else report.notes.push(`triage: no merge base with ${remote}.`);

  const failing = failingTestFiles(text);
  if (failing.length === 0) {
    report.notes.push('no failing test file in the gate log, so nothing was rerun.');
    return report;
  }
  const directories = workspaceDirectories(inputs.worktree);
  const rootName = readManifest(inputs.worktree).name;
  const placed = failing.map((entry) => {
    const directory =
      entry.package === undefined || entry.package === rootName
        ? '.'
        : directories.get(entry.package);
    const present =
      directory !== undefined && existsSync(join(inputs.worktree, directory, entry.file));
    return { entry, directory: present ? directory : undefined };
  });

  const sha = git('rev-parse', remote).stdout.trim();
  const head = git('rev-parse', 'HEAD').stdout.trim();
  const runnable = placed.some((item) => item.directory !== undefined);
  let tree: { path: string; created: boolean } | undefined;
  if (runnable) {
    const prepared = sha === '' ? `${remote} is unreadable.` : prepareMainTree(inputs, sha);
    if (typeof prepared === 'string') {
      report.notes.push(prepared);
      report.files = placed.map(({ entry }) => ({
        file: entry.file,
        package: entry.package,
        directory: undefined,
        verdict: 'indeterminate',
        candidateFailures: 0,
        baseFailures: 0,
      }));
      return report;
    }
    tree = prepared;
  }
  try {
    placed.forEach(({ entry, directory }, index) => {
      if (directory === undefined || tree === undefined) {
        report.notes.push(
          `${entry.file} (${entry.package ?? 'no package'}) is not a test file this worktree has, so it was not rerun.`,
        );
        report.files.push({
          file: entry.file,
          package: entry.package,
          directory: undefined,
          verdict: 'indeterminate',
          candidateFailures: 0,
          baseFailures: 0,
        });
        return;
      }
      const script = readManifest(join(inputs.worktree, directory)).scripts?.[entry.task ?? 'test'];
      const result = inputs.control({
        candidate: join(inputs.worktree, directory),
        base: join(tree.path, directory),
        command: testFileCommand(script, entry.file),
        iterations: controlIterations,
        log: join(inputs.logDirectory, `control-${head.slice(0, 12)}-${index + 1}.tsv`),
      });
      report.files.push({
        file: entry.file,
        package: entry.package,
        directory,
        verdict: fileVerdict(result, entry.tests),
        candidateFailures: result.candidateFailures,
        baseFailures: result.baseFailures,
      });
    });
  } finally {
    if (tree?.created === true) {
      const removed = inputs.runner(['git', 'worktree', 'remove', tree.path], {
        cwd: inputs.worktree,
      });
      if (removed.code !== 0)
        report.notes.push(`${tree.path} was left in place: ${firstLine(removed.stderr)}`);
    }
  }
  report.classification = classifyFailure(report.files.map((file) => file.verdict));
  return report;
}
