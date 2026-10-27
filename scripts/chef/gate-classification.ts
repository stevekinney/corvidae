// Chef gate classification: the pure part of `deliver.ts`'s answer to "the gate failed, whose
// failure is it?". The gate log names the failing tests; this module finds the test files they
// belong to, builds the command that runs one such file alone, and turns a control run (that command
// on the pull request's head and on `origin/<default>`, from `gate-run.ts control`) into a verdict:
//
//   - branch:        the file fails alone on the head the way the gate saw, and not on `main`;
//   - main:          it fails the same way on `main` too (whether or not the head failed this time);
//   - unreproduced:  it passes alone on both, so the gate failure was load or a flake;
//   - indeterminate: it fails alone, but never the way the gate saw (it cannot run alone with this
//                    command), so nothing is concluded.
//
// A failure counts as the gate's failure only when one of the originally failing test names is
// among the run's failing tests; any other nonzero exit is "another failure". `classifyFailure`
// combines the files' verdicts: any branch failure makes the whole failure the branch's; an
// indeterminate file, or no identifiable test file at all (a lint or type-check failure), leaves it
// unclassified; otherwise a `main` file makes it main's, and only all-unreproduced makes it
// unreproduced. Exit codes follow: 1 branch or unclassified, 3 main, 4 unreproduced.
//
// This module is a library; it has no command line.

import type { ControlResult } from './gate-run.ts';
import { shellQuote } from './process-runner.ts';

export type FileVerdict = 'branch' | 'main' | 'unreproduced' | 'indeterminate';
export type GateFailureClass = 'branch' | 'main' | 'unreproduced' | 'unclassified';

export interface FailingTestFile {
  /** The Turborepo package that printed the file, or `undefined` for output with no prefix. */
  package: string | undefined;
  /** The Turborepo task that printed it (`test`, `test:self`, ...), or `undefined`. */
  task: string | undefined;
  /** The path as Bun printed it, relative to the package directory. */
  file: string;
  /** The names of the tests that failed in it, in order, each once. */
  tests: string[];
}

const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const turboPrefix = /^(\S+?):([A-Za-z][\w:.-]*): (.*)$/;
const fileHeader = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):\s*$/;
const failLine = /^\s*\(fail\) (.*?)(?:\s*\[[\d.]+m?s\])?\s*$/;

/**
 * The test files with failing tests in a gate log. Bun prints a file's path as a header line
 * (`src/a.test.ts:`) and its `(fail)` lines below it; Turborepo prefixes every line with
 * `<package>:<task>: `, and packages interleave, so the current header is tracked per prefix.
 * A `(fail)` line with no header above it names no file and is left out.
 */
export function failingTestFiles(log: string): FailingTestFile[] {
  const current = new Map<string, string>();
  const found = new Map<string, FailingTestFile>();
  for (const raw of log.replace(ansiPattern, '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const prefix = turboPrefix.exec(line);
    const owner = prefix === null ? '' : `${prefix[1]}\u0000${prefix[2]}`;
    const rest = prefix === null ? line : (prefix[3] as string);
    const header = fileHeader.exec(rest);
    if (header?.[1] !== undefined) {
      current.set(owner, header[1]);
      continue;
    }
    const name = failLine.exec(rest)?.[1];
    const file = current.get(owner);
    if (name === undefined || name === '' || file === undefined) continue;
    const key = `${owner}\u0000${file}`;
    const entry = found.get(key) ?? {
      package: prefix?.[1],
      task: prefix?.[2],
      file,
      tests: [],
    };
    if (!entry.tests.includes(name)) entry.tests.push(name);
    found.set(key, entry);
  }
  return [...found.values()];
}

const valueFlags = new Set(['--conditions', '--config', '--preload', '--timeout', '--report-name']);
const droppedFlags = ['--parallel', '--path-ignore-patterns'];

/**
 * The shell command that runs `file` alone the way a package's test script runs its tests. When
 * `script` is one run of `bun-test-junit.ts`, the command keeps its environment assignments, the
 * wrapper and its flags (browser conditions, report name), drops the flags that fan the run out or
 * hide a file (`--parallel`, `--path-ignore-patterns`) and the path arguments, and ends with
 * `file`. Anything else (no script, a compound command, another runner) falls back to a bare
 * `bun test <file>`, which a package that needs flags will fail in a way `fileVerdict` calls
 * indeterminate rather than concluding anything from it.
 */
export function testFileCommand(script: string | undefined, file: string): string {
  const fallback = `bun test ${shellQuote(file)}`;
  if (script === undefined || /&&|\|\||;|\|/.test(script)) return fallback;
  const tokens = script.trim().split(/\s+/);
  const wrapper = tokens.findIndex((token) => token.endsWith('bun-test-junit.ts'));
  if (wrapper === -1) return fallback;
  const kept: string[] = [];
  for (let index = wrapper + 1; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (droppedFlags.some((flag) => token === flag || token.startsWith(`${flag}=`))) {
      if (droppedFlags.includes(token)) index += 1;
      continue;
    }
    if (valueFlags.has(token)) {
      kept.push(token, tokens[index + 1] ?? '');
      index += 1;
    } else if (token.startsWith('-')) kept.push(token);
  }
  return [...tokens.slice(0, wrapper + 1), ...kept, shellQuote(file)].join(' ');
}

/**
 * One file's verdict from its control run. `expected` is the failing test names the gate log
 * listed for the file; a failing run reproduces the gate's failure when it names one of them.
 */
export function fileVerdict(control: ControlResult, expected: string[]): FileVerdict {
  const reproduces = (tree: 'candidate' | 'base'): number =>
    control.rows.filter(
      (row) =>
        row.tree === tree &&
        row.exitCode !== 0 &&
        (expected.length === 0 || row.failingTests.some((name) => expected.includes(name))),
    ).length;
  const failsAtAll = control.rows.some((row) => row.exitCode !== 0);
  if (reproduces('base') > 0) return 'main';
  if (reproduces('candidate') > 0) return 'branch';
  return failsAtAll ? 'indeterminate' : 'unreproduced';
}

/** The whole failure's class from its files' verdicts; see the module comment for the order. */
export function classifyFailure(verdicts: FileVerdict[]): GateFailureClass {
  if (verdicts.length === 0) return 'unclassified';
  if (verdicts.includes('branch')) return 'branch';
  if (verdicts.includes('indeterminate')) return 'unclassified';
  return verdicts.includes('main') ? 'main' : 'unreproduced';
}

/** `deliver.ts`'s exit code for a gate failure of this class. */
export function classificationExitCode(failure: GateFailureClass): number {
  if (failure === 'main') return 3;
  return failure === 'unreproduced' ? 4 : 1;
}
