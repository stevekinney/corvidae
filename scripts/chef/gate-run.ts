#!/usr/bin/env bun
// Chef gate run: runs, reads and controls a repository's quality gate, so a coordinator launches
// the gate once in the background and reads a few compact lines back instead of paging through
// its log.
//
// Usage:
//   bun scripts/chef/gate-run.ts run [--config <json>] --worktree <dir> --log <file> [--command <shell>]
//                                   [--health-file <path>]
//   bun scripts/chef/gate-run.ts read <log> [--json]
//   bun scripts/chef/gate-run.ts triage <log> --base <sha> [--repository <dir>] [--json]
//   bun scripts/chef/gate-run.ts control --candidate <dir> --base <dir> --command <shell>
//                                   --iterations <n> --log <tsv> [--json]
//
// `run` waits while any process matches the configuration's `lockPattern` (checked every 15
// seconds, each wait written to the log), unless the command is the `affectedCheckCommand`, which
// runs shared beside the lock, records `HEAD <sha> LOAD <load>` as the log's first line
// and `TREE_START clean=<true|false|unknown> head=<sha>` before the gate, runs the wrapped gate
// command in the worktree with all output going to the log, appends `TREE_END clean=... head=...`
// and `GATE_RC=<n>`, and exits with the gate's code. `clean` is whether `git status --porcelain`
// printed nothing, so ignored files (logs under `tmp/`, `test-output/`) are not dirt.
//
// When the command is the configuration's `batchCommand` (the batch validate), `run` also records its
// head, exit code and time in `<main checkout>/tmp/chef/main-health.json` (`main-health.ts`), which
// `merge-gate.ts` reads to refuse a merge into a red `main`.
//
// `read` summarizes a log: its head, the tree state at the start and end, the exit code, failed
// tasks, the first failing tests and the over-budget count. It also reads older logs that end in
// `VALIDATE_RC=<n>` or `validate exit=<n>`. A log fails closed: it has no exit code unless the
// recognized exit-code line is the last non-empty line, and it has no head or exit code at all when
// it holds more than one `HEAD` line (two runs appended to one file), so a failing head is never
// paired with another run's passing code. A log with no exit code is reported as such and never
// inferred to have passed.
//
// `triage` takes the failed turbo tasks (`<package>#<task>`) that `read` finds in a log and says
// which pull requests could have broken each. It resolves the package's workspace directory from
// the workspace `package.json` names under the repository, lists the first-parent commits in
// `<base>..HEAD` that touched that directory, and takes the pull request number from a `(#123)`
// suffix on each subject. It prints `<task>: PR #a, #b` or `<task>: no change since base
// (pre-existing or flaky)`; a task whose package is not a workspace is reported and not mapped,
// and a commit with no `(#123)` suffix is named by its short hash.
//
// The gate runs as an asynchronous child in its own process group, so a signal to `run` (or to
// `deliver.ts` and `batch-validate.ts`, which call it) is handled instead of orphaning the gate's
// turbo and test workers. On SIGTERM, SIGINT or SIGHUP it collects the descendant tree by parent pid
// (`run-exclusively.ts` starts turbo in a session of its own, outside the group), sends SIGTERM to the
// group, then SIGKILL to the group and every collected process after a short grace (or at once on a
// second signal), waits until every collected process is gone, writes `GATE_INTERRUPTED <signal>`,
// and records `GATE_RC=128+signal`, never 0. An interrupted batch validate is not recorded as main's
// health, because a run someone stopped says nothing about `main`.
//
// `control` runs a command alternately in a candidate and a base tree and compares how often each
// fails, which tells a shared or pre-existing failure from one the candidate introduced.
//
// Exit codes: `run` the gate's own code, or 128 plus the signal number when it was interrupted; `read` 0 only when the log holds exit code 0; `triage` 1
// when any failed task maps to a commit since the base (so to a pull request), else 0; `control`
// 0 when the base fails at least as often as the candidate, else 1; 2 invalid CLI usage.

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { loadavg, constants as signalConstants } from 'node:os';
import { dirname, join } from 'node:path';
import { workspaceParentDirectories } from '../workspace-directories.ts';
import { findLockProcesses } from './leftovers.ts';
import { recordBatchRun, resolveHealthFile } from './main-health.ts';
import {
  defaultRunner,
  emitResult,
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

/** `clean` is `undefined` when the status could not be read: unknown is never clean. */
export interface TreeState {
  clean: boolean | undefined;
  head: string;
}

export interface GateLogSummary {
  /** The commit the gate ran at, from the log's `HEAD <sha> LOAD <load>` line. */
  head: string | undefined;
  /** The one-minute load average when the gate started. */
  load: number | undefined;
  /** The gate's exit code, or `undefined` when the log holds none (still running or cut off). */
  exitCode: number | undefined;
  /** The worktree before the gate ran, from the log's one `TREE_START` line; `undefined` otherwise. */
  treeStart: TreeState | undefined;
  /** The worktree after the gate ran, from the log's one `TREE_END` line; `undefined` otherwise. */
  treeEnd: TreeState | undefined;
  /** Why the head and exit code were withheld, when the log could not be trusted. */
  problem: string | undefined;
  failedTasks: string[];
  /** The first failing test names, package prefix stripped. */
  failedTests: string[];
  /** Every distinct failing test, not only the first few. */
  failedTestCount: number;
  overBudget: number;
}

const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

const exitCodePatterns = [/^(?:GATE_RC|VALIDATE_RC)=(\d+)\s*$/, /^validate exit=(\d+)\s*$/];
const treePattern = /^TREE_(START|END) clean=(true|false|unknown) head=(\S+)\s*$/;

/** Parse a gate log. Pure: the whole of `read`, exported for `merge-gate.ts`. */
export function readGateLog(text: string): GateLogSummary {
  const lines = text
    .replace(ansiPattern, '')
    .split('\n')
    .map((raw) => raw.replace(/\r$/, ''));
  const headLines: { head: string; load: number | undefined }[] = [];
  const treeLines: { which: string; state: TreeState }[] = [];
  const failedTasks: string[] = [];
  const failedTests: string[] = [];
  let overBudget = 0;
  for (const line of lines) {
    const headMatch = /^HEAD (\S+) LOAD (\S+)/.exec(line);
    if (headMatch) {
      const parsed = Number(headMatch[2]);
      headLines.push({
        head: headMatch[1] as string,
        load: Number.isFinite(parsed) ? parsed : undefined,
      });
    }
    const treeMatch = treePattern.exec(line);
    if (treeMatch)
      treeLines.push({
        which: treeMatch[1] as string,
        state: {
          clean: treeMatch[2] === 'unknown' ? undefined : treeMatch[2] === 'true',
          head: treeMatch[3] as string,
        },
      });
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
  // The exit code counts only as the log's last non-empty line, where `run` writes it; a lookalike
  // inside the gate's own output, or a line followed by more output, is not the gate's result.
  const last = lines.findLast((line) => line.trim() !== '');
  const codeMatch =
    last === undefined
      ? null
      : (exitCodePatterns.map((pattern) => pattern.exec(last)).find((match) => match !== null) ??
        null);
  // More than one `HEAD` line means two runs share the file, and which head goes with which exit
  // code cannot be told; withhold both rather than pair a failing head with a passing code.
  const problem =
    headLines.length > 1
      ? `the log holds ${headLines.length} HEAD lines (more than one run), so no head or exit code can be trusted`
      : undefined;
  const single = <T>(which: string): T | undefined => {
    const matching = treeLines.filter((entry) => entry.which === which);
    return matching.length === 1 ? (matching[0]?.state as T) : undefined;
  };
  const distinctTests = [...new Set(failedTests)];
  return {
    head: problem === undefined ? headLines[0]?.head : undefined,
    load: problem === undefined ? headLines[0]?.load : undefined,
    exitCode: problem === undefined && codeMatch ? Number(codeMatch[1]) : undefined,
    treeStart: problem === undefined ? single<TreeState>('START') : undefined,
    treeEnd: problem === undefined ? single<TreeState>('END') : undefined,
    problem,
    failedTasks: [...new Set(failedTasks)],
    failedTests: distinctTests.slice(0, failedTestLimit),
    failedTestCount: distinctTests.length,
    overBudget,
  };
}

function renderTree(state: TreeState | undefined): string {
  if (state === undefined) return 'unknown';
  const clean = state.clean === undefined ? 'unknown' : state.clean ? 'clean' : 'dirty';
  return `${clean} at ${state.head.slice(0, 12)}`;
}

export function renderGateSummary(summary: GateLogSummary): string {
  const lines = [
    `head: ${summary.head ?? 'unknown'}  load: ${summary.load?.toFixed(2) ?? 'unknown'}`,
    summary.exitCode === undefined
      ? `exit code: none (${summary.problem ?? 'the gate is still running, or the log was cut off'}; not a pass)`
      : `exit code: ${summary.exitCode}`,
    `tree: start ${renderTree(summary.treeStart)}, end ${renderTree(summary.treeEnd)}`,
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

/** The signals that stop a gate: the group is killed and the run records an interrupted exit. */
export const gateSignals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
export type GateSignal = (typeof gateSignals)[number];

/** How long the gate's group has to exit after SIGTERM before it is sent SIGKILL. */
export const gateGraceMilliseconds = 10_000;

/** A started gate: its process id (the process group's id) and its eventual exit code. */
export interface GateChild {
  /** `undefined` when the process could not start; there is then no group to signal. */
  pid: number | undefined;
  /** The exit code, which is `128 + signal` for a child a signal killed. */
  exited: Promise<number>;
}

/** Where signals come from: `process` in production, a fake in tests. */
export interface SignalSource {
  on: (signal: GateSignal, handler: () => void) => unknown;
  off: (signal: GateSignal, handler: () => void) => unknown;
}

export interface GateDependencies {
  runner: Runner;
  /** Wait for `milliseconds` between lock checks. */
  sleep: (milliseconds: number) => void | Promise<void>;
  /** The one-minute load average. */
  load: () => number;
  now: () => Date;
  pollMilliseconds: number;
  /** Starts the gate's shell script in `cwd` as the leader of its own process group. */
  spawnGate: (script: string, cwd: string) => GateChild;
  /** Sends `signal` to the whole process group led by `pid`. */
  killGroup: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  signals: SignalSource;
  /**
   * Every live descendant of `roots` (and the roots themselves), found by parent pid, so a process
   * that started its own session or group, as `run-exclusively.ts` does for turbo, is included.
   */
  descendantsOf: (roots: number[]) => number[];
  /** Sends `signal` to one process. */
  signalProcess: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  /** Whether a process still exists. */
  isAlive: (pid: number) => boolean;
  /** Waits `milliseconds` while the interrupted tree drains. */
  pause: (milliseconds: number) => Promise<void>;
  /** Runs `callback` after `milliseconds` and returns a function that cancels it. */
  schedule: (callback: () => void, milliseconds: number) => () => void;
  graceMilliseconds: number;
}

/** `ps -A -o pid=,ppid=`'s table, walked down from `roots`; the roots are included. */
export const processTreeOf: GateDependencies['descendantsOf'] = (roots) => {
  const result = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid='], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const children = new Map<number, number[]>();
  for (const line of result.stdout.toString().split('\n')) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || parent === undefined || !Number.isInteger(pid)) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const seen = new Set<number>(roots);
  const queue = [...roots];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return [...seen];
};

/** Send a signal to one process; one that has already gone is not an error. */
export const signalOneProcess: GateDependencies['signalProcess'] = (pid, signal) => {
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH: already gone.
  }
};

/** `ps -o stat=` for one process: its state letters, or `''` when no such process exists. */
export function readProcessState(pid: number): string {
  const result = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  return result.stdout.toString().trim();
}

/**
 * Whether `pid` is a running process. A zombie (state `Z`) has exited and only waits to be reaped,
 * so it counts as gone; so does a pid `ps` does not list. `readState` is injectable for tests.
 */
export function isProcessLive(
  pid: number,
  readState: (pid: number) => string = readProcessState,
): boolean {
  const state = readState(pid);
  return state !== '' && !state.startsWith('Z');
}

/** Whether `pid` is a live, non-zombie process. */
export const processExists: GateDependencies['isAlive'] = (pid) => isProcessLive(pid);

function signalExitCode(signal: string | number | null | undefined): number {
  if (typeof signal === 'number') return 128 + signal;
  const number = (signalConstants.signals as Record<string, number | undefined>)[signal ?? ''];
  return 128 + (number ?? 0);
}

/** Start `script` with `sh -c` in its own process group, with its output left to the script. */
export const spawnGateProcess: GateDependencies['spawnGate'] = (script, cwd) => {
  try {
    const child = Bun.spawn(['sh', '-c', script], {
      cwd,
      detached: true,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    return {
      pid: child.pid,
      exited: child.exited.then(() => child.exitCode ?? signalExitCode(child.signalCode)),
    };
  } catch {
    return { pid: undefined, exited: Promise.resolve(127) };
  }
};

/** Signal a whole process group; a group that has already gone is not an error. */
export const killProcessGroup: GateDependencies['killGroup'] = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: every process in the group has already exited.
  }
};

function resolveDependencies(partial: Partial<GateDependencies>): GateDependencies {
  return {
    runner: partial.runner ?? defaultRunner,
    sleep: partial.sleep ?? ((milliseconds) => Bun.sleep(milliseconds)),
    load: partial.load ?? (() => loadavg()[0] ?? 0),
    now: partial.now ?? (() => new Date()),
    pollMilliseconds: partial.pollMilliseconds ?? lockPollMilliseconds,
    spawnGate: partial.spawnGate ?? spawnGateProcess,
    killGroup: partial.killGroup ?? killProcessGroup,
    signals: partial.signals ?? process,
    descendantsOf: partial.descendantsOf ?? processTreeOf,
    signalProcess: partial.signalProcess ?? signalOneProcess,
    isAlive: partial.isAlive ?? processExists,
    pause: partial.pause ?? ((milliseconds) => Bun.sleep(milliseconds)),
    schedule:
      partial.schedule ??
      ((callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds);
        return () => clearTimeout(timer);
      }),
    graceMilliseconds: partial.graceMilliseconds ?? gateGraceMilliseconds,
  };
}

/** How often the interrupted tree is checked, and how many checks follow the final SIGKILL. */
const drainPollMilliseconds = 50;
const drainPollsAfterKill = 100;

/**
 * Run the gate child and wait for it, stopping its whole process tree on SIGTERM, SIGINT or SIGHUP.
 * The gate's wrapper (`run-exclusively.ts`) starts turbo in a session of its own, so the process
 * group alone does not reach it; the tree is collected by parent pid, before the first signal and
 * again before the SIGKILL, and every member is waited for. The first signal sends SIGTERM to the
 * group and arms a SIGKILL of the group and of every collected process after the grace period; a
 * second signal sends that SIGKILL at once. The run does not end while any collected process
 * lives, and an interrupted gate never reports 0.
 */
async function runGateChild(
  script: string,
  cwd: string,
  dependencies: GateDependencies,
): Promise<{ code: number; interrupted: GateSignal | undefined }> {
  const child = dependencies.spawnGate(script, cwd);
  let interrupted: GateSignal | undefined;
  let cancelKill: (() => void) | undefined;
  let killed = false;
  const tracked = new Set<number>();
  /** Add every live descendant of the child and of anything already collected. */
  const collect = (): void => {
    if (child.pid === undefined) return;
    for (const pid of dependencies.descendantsOf([child.pid, ...tracked])) tracked.add(pid);
  };
  const escalate = (): void => {
    if (child.pid === undefined) return;
    killed = true;
    collect();
    dependencies.killGroup(child.pid, 'SIGKILL');
    for (const pid of tracked) dependencies.signalProcess(pid, 'SIGKILL');
  };
  const handlers = gateSignals.map((signal) => {
    const handler = () => {
      if (child.pid === undefined) return;
      if (interrupted === undefined) {
        interrupted = signal;
        collect();
        dependencies.killGroup(child.pid, 'SIGTERM');
        cancelKill = dependencies.schedule(escalate, dependencies.graceMilliseconds);
      } else {
        escalate();
      }
    };
    dependencies.signals.on(signal, handler);
    return { signal, handler };
  });
  try {
    const code = await child.exited;
    if (interrupted !== undefined) {
      // The wrapper can exit while its turbo and workers are still draining; wait for all of them.
      let pollsAfterKill = 0;
      for (;;) {
        collect();
        if (![...tracked].some((pid) => dependencies.isAlive(pid))) break;
        if (killed) {
          pollsAfterKill += 1;
          if (pollsAfterKill > drainPollsAfterKill) break;
          escalate();
        }
        await dependencies.pause(drainPollMilliseconds);
      }
    }
    return {
      code: interrupted === undefined ? code : signalExitCode(interrupted),
      interrupted,
    };
  } finally {
    cancelKill?.();
    for (const { signal, handler } of handlers) dependencies.signals.off(signal, handler);
  }
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
  command?: string | undefined;
  /** Where to record a batch validate's result; defaults to the main checkout's `tmp/chef/`. */
  healthFile?: string | undefined;
}

export interface GateRunResult {
  code: number;
  head: string;
  waits: number;
  /** Whether the worktree had no uncommitted or untracked (non-ignored) path before the gate. */
  startClean: boolean | undefined;
  /** The same after the gate. */
  endClean: boolean | undefined;
  /** HEAD after the gate; it differs from `head` when the gate moved it. */
  endHead: string;
  /** The signal that stopped the gate, when one did; `code` is then never 0. */
  interrupted?: GateSignal | undefined;
}

/** `git status --porcelain` emptiness and HEAD; an unreadable status is `undefined`, never clean. */
function snapshotTree(
  runner: Runner,
  worktree: string,
): { clean: boolean | undefined; head: string } {
  const status = runner(['git', 'status', '--porcelain'], { cwd: worktree });
  const head = runner(['git', 'rev-parse', 'HEAD'], { cwd: worktree });
  return {
    clean: status.code === 0 ? status.stdout.trim() === '' : undefined,
    head: head.code === 0 && head.stdout.trim() !== '' ? head.stdout.trim() : 'unknown',
  };
}

function treeLine(which: 'START' | 'END', tree: { clean: boolean | undefined; head: string }) {
  return `TREE_${which} clean=${tree.clean === undefined ? 'unknown' : tree.clean} head=${tree.head}\n`;
}

/** Wait out the lock, record the head and load, run the gate into the log, append its exit code. */
export async function runGate(
  options: GateRunOptions,
  partial: Partial<GateDependencies> = {},
): Promise<GateRunResult> {
  const dependencies = resolveDependencies(partial);
  const { runner } = dependencies;
  const config = loadRepositoryConfig(options.configPath);
  if (!existsSync(options.worktree)) throw new UsageError(`No such worktree: ${options.worktree}`);
  mkdirSync(dirname(options.log), { recursive: true });
  writeFileSync(options.log, '');
  let waits = 0;
  const command = options.command ?? config.gateCommand;
  // The affected-only check runs shared, beside any lock holder, so waiting for one would only
  // queue it behind a full validate it does not compete with.
  if (config.lockPattern !== undefined && command !== config.affectedCheckCommand) {
    for (;;) {
      const holders = findLockProcesses(config.lockPattern, runner);
      if (holders.length === 0) break;
      waits += 1;
      appendFileSync(
        options.log,
        `WAIT ${dependencies.now().toISOString()} lock held by ${holders.map((item) => item.pid).join(',')}\n`,
      );
      await dependencies.sleep(dependencies.pollMilliseconds);
    }
  }
  const headResult = runner(['git', 'rev-parse', 'HEAD'], { cwd: options.worktree });
  if (headResult.code !== 0)
    throw new UsageError(`${options.worktree} is not a Git worktree: ${headResult.stderr.trim()}`);
  const head = headResult.stdout.trim();
  // The head line goes first, after the wait, so it names the commit the gate actually ran at.
  const waitLines = readFileSync(options.log, 'utf8');
  const start = snapshotTree(runner, options.worktree);
  writeFileSync(
    options.log,
    `HEAD ${head} LOAD ${dependencies.load().toFixed(2)}\n${waitLines}${treeLine('START', start)}`,
  );
  const gate = `sh -c ${shellQuote(command)}`;
  const wrapped = config.gateWrapper === undefined ? gate : `${config.gateWrapper} ${gate}`;
  const result = await runGateChild(
    `${wrapped} >> ${shellQuote(options.log)} 2>&1`,
    options.worktree,
    dependencies,
  );
  if (!endsWithNewline(options.log)) appendFileSync(options.log, '\n');
  if (result.interrupted !== undefined)
    appendFileSync(options.log, `GATE_INTERRUPTED ${result.interrupted}\n`);
  const end = snapshotTree(runner, options.worktree);
  appendFileSync(options.log, `${treeLine('END', end)}GATE_RC=${result.code}\n`);
  // The batch validate's result is main's health; a branch's own run of it is not, so it is
  // recorded under its head and `merge-gate.ts` counts it only when that head is on main.
  if (
    config.batchCommand !== undefined &&
    command === config.batchCommand &&
    result.interrupted === undefined
  ) {
    const healthFile = options.healthFile ?? resolveHealthFile(runner, options.worktree);
    if (healthFile !== undefined)
      recordBatchRun(healthFile, {
        head,
        exitCode: result.code,
        time: dependencies.now().toISOString(),
        command,
      });
  }
  return {
    code: result.code,
    head,
    waits,
    startClean: start.clean,
    endClean: end.clean,
    endHead: end.head,
    ...(result.interrupted === undefined ? {} : { interrupted: result.interrupted }),
  };
}

export interface TriageCommit {
  sha: string;
  subject: string;
  /** The `(#123)` number at the end of the subject, or `null` when it has none. */
  pr: number | null;
}

export interface TriageTask {
  /** The failed turbo task, `<package>#<task>`. */
  task: string;
  package: string;
  /** The package's workspace directory relative to the repository, or `null` when it is no workspace. */
  directory: string | null;
  /** First-parent commits in `base..HEAD` that touched the directory, oldest first. */
  commits: TriageCommit[];
  /** The distinct pull requests those commits came from, oldest first. */
  prs: number[];
}

export interface TriageResult {
  base: string;
  tasks: TriageTask[];
}

/** The failed tasks in `<package>#<task>` form; the other shapes `read` collects name no package. */
export function turboTasks(failedTasks: string[]): { task: string; package: string }[] {
  return failedTasks.flatMap((task) => {
    const separator = task.lastIndexOf('#');
    return /^\S+#\S+$/.test(task) ? [{ task, package: task.slice(0, separator) }] : [];
  });
}

/** Each workspace's package name and its directory relative to `repository`. */
export function workspaceDirectories(repository: string): Map<string, string> {
  const directories = [
    ...workspaceParentDirectories.flatMap((parent) => {
      const root = join(repository, parent);
      if (!existsSync(root)) return [];
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${parent}/${entry.name}`);
    }),
    'scripts/browser-fixtures',
  ];
  const byName = new Map<string, string>();
  for (const directory of directories.toSorted()) {
    const manifest = join(repository, directory, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name;
      if (typeof name === 'string' && !byName.has(name)) byName.set(name, directory);
    } catch {
      // A manifest that is not JSON names no workspace; `bun install` is what rejects it.
    }
  }
  return byName;
}

/**
 * For each failed turbo task in a gate log, the pull requests that changed its package since
 * `base`. A task with no commits since `base` failed on code this branch did not touch, so it is
 * pre-existing or flaky rather than something a merged pull request introduced.
 */
export function triageGateLog(
  log: string,
  base: string,
  repository: string,
  runner: Runner = defaultRunner,
): TriageResult {
  const workspaces = workspaceDirectories(repository);
  const tasks = turboTasks(readGateLog(log).failedTasks).map(
    ({ task, package: name }): TriageTask => {
      const directory = workspaces.get(name) ?? null;
      if (directory === null) return { task, package: name, directory, commits: [], prs: [] };
      const result = runner(
        ['git', 'log', '--first-parent', '--format=%H%x09%s', `${base}..HEAD`, '--', directory],
        { cwd: repository },
      );
      if (result.code !== 0)
        throw new UsageError(
          `git log ${base}..HEAD failed in ${repository} (exit ${result.code}): ${result.stderr.trim().split('\n').at(-1) ?? ''}`,
        );
      const commits = result.stdout
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line): TriageCommit => {
          const tab = line.indexOf('\t');
          const subject = tab === -1 ? '' : line.slice(tab + 1);
          const number = /\(#(\d+)\)\s*$/.exec(subject)?.[1];
          return {
            sha: tab === -1 ? line : line.slice(0, tab),
            subject,
            pr: number === undefined ? null : Number(number),
          };
        })
        .toReversed();
      const prs = [
        ...new Set(commits.flatMap((commit) => (commit.pr === null ? [] : [commit.pr]))),
      ];
      return { task, package: name, directory, commits, prs };
    },
  );
  return { base, tasks };
}

export function renderTriage(result: TriageResult): string {
  if (result.tasks.length === 0) return 'No failed turbo tasks (<package>#<task>) in the log.';
  return result.tasks
    .map((entry) => {
      if (entry.directory === null)
        return `${entry.task}: ${entry.package} is not a workspace here, so it cannot be mapped`;
      if (entry.commits.length === 0)
        return `${entry.task}: no change since base (pre-existing or flaky)`;
      const named = [
        ...entry.prs.map((pr) => `#${pr}`),
        ...entry.commits
          .filter((commit) => commit.pr === null)
          .map((commit) => commit.sha.slice(0, 9)),
      ];
      return `${entry.task}: PR ${named.join(', ')}`;
    })
    .join('\n');
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

/** The commands that only read files and finish at once: `read`, `triage` and `control`. */
export function run(
  argv: string[],
  dependencies: Partial<GateDependencies> = {},
): { code: number; output: string } {
  const [command, ...rest] = argv;
  if (command === 'run') throw new UsageError('`run` is asynchronous; call runCommand.');
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
  if (command === 'triage') {
    const parsed = parseOptions(rest, { values: ['base', 'repository'], flags: ['json'] });
    const [path, ...extra] = parsed.positionals;
    if (path === undefined || extra.length > 0)
      throw new UsageError(
        'Usage: gate-run.ts triage <log> --base <sha> [--repository <dir>] [--json]',
      );
    const base = requireOption(parsed, 'base');
    const repository = parsed.values['repository'] ?? process.cwd();
    if (!existsSync(path)) throw new UsageError(`No such log: ${path}`);
    if (!existsSync(repository)) throw new UsageError(`No such repository: ${repository}`);
    const result = triageGateLog(readFileSync(path, 'utf8'), base, repository, dependencies.runner);
    return {
      code: result.tasks.some((entry) => entry.commits.length > 0) ? 1 : 0,
      output: parsed.flags.has('json') ? JSON.stringify(result) : renderTriage(result),
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
  throw new UsageError('Usage: gate-run.ts run|read|triage|control ...');
}

/** Every command; `run` waits for the gate, so this one is asynchronous. */
export async function runCommand(
  argv: string[],
  dependencies: Partial<GateDependencies> = {},
): Promise<{ code: number; output: string }> {
  const [command, ...rest] = argv;
  if (command !== 'run') return run(argv, dependencies);
  const parsed = parseOptions(rest, {
    values: ['config', 'worktree', 'log', 'command', 'health-file'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const options: GateRunOptions = {
    configPath: parsed.values['config'] ?? DEFAULT_CONFIGURATION_PATH,
    worktree: requireOption(parsed, 'worktree'),
    log: requireOption(parsed, 'log'),
    command: parsed.values['command'],
    healthFile: parsed.values['health-file'],
  };
  const result = await runGate(options, dependencies);
  const outcome =
    result.interrupted === undefined
      ? `${result.code === 0 ? 'passed' : 'failed'} (exit ${result.code})`
      : `was interrupted by ${result.interrupted} (exit ${result.code})`;
  return {
    code: result.code,
    output: `Gate ${outcome} at ${result.head}; log ${options.log}.`,
  };
}

if (import.meta.main) {
  try {
    const { code, output } = await runCommand(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
