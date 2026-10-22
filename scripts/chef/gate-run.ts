#!/usr/bin/env bun
// Chef gate run: runs, reads and controls a repository's quality gate, so a coordinator launches
// the gate once in the background and reads a few compact lines back instead of paging through
// its log.
//
// Usage:
//   bun scripts/chef/gate-run.ts run [--config <json>] --worktree <dir> --log <file> [--command <shell>]
//   bun scripts/chef/gate-run.ts read <log> [--json]
//   bun scripts/chef/gate-run.ts control --candidate <dir> --base <dir> --command <shell>
//                                   --iterations <n> --log <tsv> [--json]
//
// `run` waits while any process matches the configuration's `lockPattern` (checked every 15
// seconds, each wait written to the log), records `HEAD <sha> LOAD <load>` as the log's first line,
// runs the wrapped gate command in the worktree with all output going to the log, appends
// `GATE_RC=<n>`, and exits with the gate's code.
//
// `read` summarizes a log: its head, exit code, failed tasks, the first failing tests and the
// over-budget count. It also reads older logs that end in `VALIDATE_RC=<n>` or `validate exit=<n>`.
// A log with no exit code is reported as such and never inferred to have passed.
//
// `control` runs a command alternately in a candidate and a base tree and compares how often each
// fails, which tells a shared or pre-existing failure from one the candidate introduced.
//
// Exit codes: `run` the gate's own code; `read` 0 only when the log holds exit code 0; `control`
// 0 when the base fails at least as often as the candidate, else 1; 2 invalid CLI usage.

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { loadavg } from 'node:os';
import { dirname } from 'node:path';
import { findLockProcesses } from './leftovers.ts';
import {
  defaultRunner,
  parseOptions,
  requireOption,
  type Runner,
  shellQuote,
  UsageError,
} from './process-runner.ts';
import { DEFAULT_CONFIGURATION_PATH, loadRepositoryConfig } from './repository-config.ts';

export { UsageError };

export const lockPollMilliseconds = 15_000;
const failedTestLimit = 10;

export interface GateLogSummary {
  /** The commit the gate ran at, from the log's `HEAD <sha> LOAD <load>` line. */
  head: string | undefined;
  /** The one-minute load average when the gate started. */
  load: number | undefined;
  /** The gate's exit code, or `undefined` when the log holds none (still running or cut off). */
  exitCode: number | undefined;
  failedTasks: string[];
  /** The first failing test names, package prefix stripped. */
  failedTests: string[];
  /** Every distinct failing test, not only the first few. */
  failedTestCount: number;
  overBudget: number;
}

const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

/** Parse a gate log. Pure: the whole of `read`, exported for `merge-gate.ts`. */
export function readGateLog(text: string): GateLogSummary {
  const lines = text.replace(ansiPattern, '').split('\n');
  let head: string | undefined;
  let load: number | undefined;
  let exitCode: number | undefined;
  const failedTasks: string[] = [];
  const failedTests: string[] = [];
  let overBudget = 0;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const headMatch = /^HEAD (\S+) LOAD (\S+)/.exec(line);
    if (headMatch && head === undefined) {
      head = headMatch[1];
      const parsed = Number(headMatch[2]);
      load = Number.isFinite(parsed) ? parsed : undefined;
    }
    // The last exit-code line wins, so an old log that was appended to reads its final run.
    const codeMatch =
      /^(?:GATE_RC|VALIDATE_RC)=(\d+)\s*$/.exec(line) ?? /^validate exit=(\d+)\s*$/.exec(line);
    if (codeMatch) exitCode = Number(codeMatch[1]);
    const failedMatch = /^\s*Failed:\s+(\S+)/.exec(line);
    if (failedMatch?.[1] !== undefined) failedTasks.push(failedMatch[1]);
    const errorMatch = /\bERROR\b.*\bcommand \(([^)]*)\).*\bexited \((\d+)\)/.exec(line);
    if (errorMatch) {
      // Turbo prefixes a task's lines with `<package>:<task>: `; without one, name the directory.
      const prefix = /^(\S+?):\s/.exec(line)?.[1];
      const owner = prefix ?? (errorMatch[1] ?? '').split('/').slice(-2).join('/');
      failedTasks.push(`${owner} exited (${errorMatch[2]})`);
    }
    const failAt = line.indexOf('(fail) ');
    if (failAt >= 0 && (failAt === 0 || /[\s:]/.test(line[failAt - 1] ?? ''))) {
      const name = line
        .slice(failAt + '(fail) '.length)
        .replace(/\s*\[[\d.]+m?s\]\s*$/, '')
        .trim();
      if (name !== '') failedTests.push(name);
    }
    if (line.includes('over budget')) overBudget += 1;
  }
  const distinctTests = [...new Set(failedTests)];
  return {
    head,
    load,
    exitCode,
    failedTasks: [...new Set(failedTasks)],
    failedTests: distinctTests.slice(0, failedTestLimit),
    failedTestCount: distinctTests.length,
    overBudget,
  };
}

export function renderGateSummary(summary: GateLogSummary): string {
  const lines = [
    `head: ${summary.head ?? 'unknown'}  load: ${summary.load?.toFixed(2) ?? 'unknown'}`,
    summary.exitCode === undefined
      ? 'exit code: none (the gate is still running, or the log was cut off; not a pass)'
      : `exit code: ${summary.exitCode}`,
  ];
  if (summary.failedTasks.length > 0) lines.push(`failed tasks: ${summary.failedTasks.join(', ')}`);
  if (summary.failedTestCount > 0) {
    const shown = summary.failedTests.length;
    lines.push(
      `failing tests (${shown < summary.failedTestCount ? `first ${shown} of ${summary.failedTestCount}` : shown}):`,
      ...summary.failedTests.map((name) => `  ${name}`),
    );
  }
  lines.push(`over budget: ${summary.overBudget}`);
  return lines.join('\n');
}

export interface GateDependencies {
  runner: Runner;
  /** Block for `milliseconds`. */
  sleep: (milliseconds: number) => void;
  /** The one-minute load average. */
  load: () => number;
  now: () => Date;
  pollMilliseconds: number;
}

function resolveDependencies(partial: Partial<GateDependencies>): GateDependencies {
  return {
    runner: partial.runner ?? defaultRunner,
    sleep: partial.sleep ?? ((milliseconds) => Bun.sleepSync(milliseconds)),
    load: partial.load ?? (() => loadavg()[0] ?? 0),
    now: partial.now ?? (() => new Date()),
    pollMilliseconds: partial.pollMilliseconds ?? lockPollMilliseconds,
  };
}

function endsWithNewline(path: string): boolean {
  const size = statSync(path).size;
  if (size === 0) return true;
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(1);
    readSync(descriptor, buffer, 0, 1, size - 1);
    return buffer[0] === 0x0a;
  } finally {
    closeSync(descriptor);
  }
}

export interface GateRunOptions {
  configPath: string;
  worktree: string;
  log: string;
  command?: string;
}

export interface GateRunResult {
  code: number;
  head: string;
  waits: number;
}

/** Wait out the lock, record the head and load, run the gate into the log, append its exit code. */
export function runGate(
  options: GateRunOptions,
  partial: Partial<GateDependencies> = {},
): GateRunResult {
  const dependencies = resolveDependencies(partial);
  const { runner } = dependencies;
  const config = loadRepositoryConfig(options.configPath);
  if (!existsSync(options.worktree)) throw new UsageError(`No such worktree: ${options.worktree}`);
  mkdirSync(dirname(options.log), { recursive: true });
  writeFileSync(options.log, '');
  let waits = 0;
  if (config.lockPattern !== undefined) {
    for (;;) {
      const holders = findLockProcesses(config.lockPattern, runner);
      if (holders.length === 0) break;
      waits += 1;
      appendFileSync(
        options.log,
        `WAIT ${dependencies.now().toISOString()} lock held by ${holders.map((item) => item.pid).join(',')}\n`,
      );
      dependencies.sleep(dependencies.pollMilliseconds);
    }
  }
  const headResult = runner(['git', 'rev-parse', 'HEAD'], { cwd: options.worktree });
  if (headResult.code !== 0)
    throw new UsageError(`${options.worktree} is not a Git worktree: ${headResult.stderr.trim()}`);
  const head = headResult.stdout.trim();
  // The head line goes first, after the wait, so it names the commit the gate actually ran at.
  const waitLines = readFileSync(options.log, 'utf8');
  writeFileSync(options.log, `HEAD ${head} LOAD ${dependencies.load().toFixed(2)}\n${waitLines}`);
  const gate = `sh -c ${shellQuote(options.command ?? config.gateCommand)}`;
  const wrapped = config.gateWrapper === undefined ? gate : `${config.gateWrapper} ${gate}`;
  const result = runner(['sh', '-c', `${wrapped} >> ${shellQuote(options.log)} 2>&1`], {
    cwd: options.worktree,
  });
  if (!endsWithNewline(options.log)) appendFileSync(options.log, '\n');
  appendFileSync(options.log, `GATE_RC=${result.code}\n`);
  return { code: result.code, head, waits };
}

export interface ControlOptions {
  candidate: string;
  base: string;
  command: string;
  iterations: number;
  log: string;
}

export interface ControlRow {
  iteration: number;
  tree: 'candidate' | 'base';
  load: number;
  exitCode: number;
  failingTests: string[];
}

export interface ControlResult {
  rows: ControlRow[];
  candidateFailures: number;
  baseFailures: number;
  iterations: number;
  /** True when the base fails at least as often as the candidate: the failure is shared. */
  shared: boolean;
}

/** Run `command` alternately in the candidate and the base, `iterations` times each. */
export function runControl(
  options: ControlOptions,
  partial: Partial<GateDependencies> = {},
): ControlResult {
  const dependencies = resolveDependencies(partial);
  const rows: ControlRow[] = [];
  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    for (const tree of ['candidate', 'base'] as const) {
      const directory = tree === 'candidate' ? options.candidate : options.base;
      const load = dependencies.load();
      const result = dependencies.runner(['sh', '-c', options.command], { cwd: directory });
      const summary = readGateLog(`${result.stdout}\n${result.stderr}`);
      rows.push({
        iteration,
        tree,
        load,
        exitCode: result.code,
        failingTests: result.code === 0 ? [] : [...summary.failedTests],
      });
    }
  }
  const failures = (tree: string) =>
    rows.filter((row) => row.tree === tree && row.exitCode !== 0).length;
  const candidateFailures = failures('candidate');
  const baseFailures = failures('base');
  mkdirSync(dirname(options.log), { recursive: true });
  const tsv = [
    'iteration\ttree\tload\texit\tfailing_tests',
    ...rows.map(
      (row) =>
        `${row.iteration}\t${row.tree}\t${row.load.toFixed(2)}\t${row.exitCode}\t${row.failingTests.join('; ').replace(/[\t\n]/g, ' ')}`,
    ),
  ];
  writeFileSync(options.log, `${tsv.join('\n')}\n`);
  return {
    rows,
    candidateFailures,
    baseFailures,
    iterations: options.iterations,
    shared: baseFailures >= candidateFailures,
  };
}

export function renderControl(result: ControlResult): string {
  return [
    `candidate failed ${result.candidateFailures} of ${result.iterations}`,
    `base failed ${result.baseFailures} of ${result.iterations}`,
    result.shared
      ? 'The base fails at least as often as the candidate: the failure is shared or pre-existing.'
      : "The candidate fails and the base fails less: the failure is the candidate's.",
  ].join('\n');
}

export function run(
  argv: string[],
  dependencies: Partial<GateDependencies> = {},
): { code: number; output: string } {
  const [command, ...rest] = argv;
  if (command === 'run') {
    const parsed = parseOptions(rest, { values: ['config', 'worktree', 'log', 'command'] });
    if (parsed.positionals.length > 0)
      throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
    const options: GateRunOptions = {
      configPath: parsed.values.config ?? DEFAULT_CONFIGURATION_PATH,
      worktree: requireOption(parsed, 'worktree'),
      log: requireOption(parsed, 'log'),
      command: parsed.values.command,
    };
    const result = runGate(options, dependencies);
    return {
      code: result.code,
      output: `Gate ${result.code === 0 ? 'passed' : 'failed'} (exit ${result.code}) at ${result.head}; log ${options.log}.`,
    };
  }
  if (command === 'read') {
    const parsed = parseOptions(rest, { flags: ['json'] });
    const [path, ...extra] = parsed.positionals;
    if (path === undefined || extra.length > 0)
      throw new UsageError('Usage: gate-run.ts read <log> [--json]');
    if (!existsSync(path)) throw new UsageError(`No such log: ${path}`);
    const summary = readGateLog(readFileSync(path, 'utf8'));
    return {
      code: summary.exitCode === 0 ? 0 : 1,
      output: parsed.flags.has('json') ? JSON.stringify(summary) : renderGateSummary(summary),
    };
  }
  if (command === 'control') {
    const parsed = parseOptions(rest, {
      values: ['candidate', 'base', 'command', 'iterations', 'log'],
      flags: ['json'],
    });
    if (parsed.positionals.length > 0)
      throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
    const iterations = Number(requireOption(parsed, 'iterations'));
    if (!Number.isInteger(iterations) || iterations < 1)
      throw new UsageError('--iterations takes a whole number of at least 1.');
    const options: ControlOptions = {
      candidate: requireOption(parsed, 'candidate'),
      base: requireOption(parsed, 'base'),
      command: requireOption(parsed, 'command'),
      iterations,
      log: requireOption(parsed, 'log'),
    };
    for (const directory of [options.candidate, options.base]) {
      if (!existsSync(directory)) throw new UsageError(`No such directory: ${directory}`);
    }
    const result = runControl(options, dependencies);
    return {
      code: result.shared ? 0 : 1,
      output: parsed.flags.has('json') ? JSON.stringify(result) : renderControl(result),
    };
  }
  throw new UsageError('Usage: gate-run.ts run|read|control ...');
}

if (import.meta.main) {
  try {
    const { code, output } = run(Bun.argv.slice(2));
    (code === 0 ? process.stdout : process.stderr).write(`${output}\n`);
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
