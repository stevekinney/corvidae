#!/usr/bin/env bun
// Chef leftovers: reports what is still running or holding a resource after a batch, so a
// coordinator can see it in one call instead of stitching together `pgrep`, `lsof` and `kill -0`.
// It reports three things: processes matching the repository's gate-lock pattern, processes
// whose working directory or open files are inside a worktree, and which listed PIDs are alive.
// It only reports; it never signals, stops or removes anything.
//
// Usage:
//   bun scripts/chef/leftovers.ts [--config <json>] [--worktree <dir> ...] [--pids <n,n>] [--json]
//
// `--config` (default `scripts/chef/repository.json`) supplies `lockPattern`. Worktree lookups use
// `lsof +D`, which walks the whole directory tree, so a worktree with a large `node_modules`
// takes a while.
//
// Exit codes: 0 nothing found, 1 something found, 2 invalid CLI usage.

import { existsSync, realpathSync } from 'node:fs';
import { defaultRunner, parseOptions, type Runner, UsageError } from './process-runner.ts';
import { DEFAULT_CONFIGURATION_PATH, loadRepositoryConfig } from './repository-config.ts';

export { UsageError };

export interface FoundProcess {
  pid: number;
  command: string;
}

export interface WorktreeLeftovers {
  path: string;
  processes: FoundProcess[];
}

export interface PidStatus {
  pid: number;
  alive: boolean;
}

export interface LeftoversReport {
  lockProcesses: FoundProcess[];
  worktrees: WorktreeLeftovers[];
  pids: PidStatus[];
  found: boolean;
}

export interface LeftoversDependencies {
  runner: Runner;
  isAlive: (pid: number) => boolean;
  /** This process, which is never reported as its own leftover. */
  ownPid: number;
}

/** `kill -0`: a process that exists but belongs to another user is alive (EPERM). */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Parse `pgrep -fl` output: one `<pid> <command line>` per line. */
export function parsePgrep(stdout: string): FoundProcess[] {
  const found: FoundProcess[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) found.push({ pid: Number(match[1]), command: (match[2] ?? '').trim() });
  }
  return found;
}

/** Parse `lsof -F pc` output: a `p<pid>` line followed by that process's `c<command>` line. */
export function parseLsofFields(stdout: string): FoundProcess[] {
  const found = new Map<number, FoundProcess>();
  let current: FoundProcess | undefined;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1));
      if (!Number.isInteger(pid)) continue;
      current = found.get(pid) ?? { pid, command: '' };
      found.set(pid, current);
    } else if (line.startsWith('c') && current !== undefined) {
      current.command = line.slice(1);
    }
  }
  return [...found.values()];
}

/** Processes whose command line matches the extended regular expression `pattern`. */
export function findLockProcesses(
  pattern: string,
  runner: Runner = defaultRunner,
  ownPid = process.pid,
): FoundProcess[] {
  const result = runner(['pgrep', '-fl', pattern]);
  // pgrep exits 1 when nothing matches; any other failure leaves stdout empty too.
  return parsePgrep(result.stdout).filter((item) => item.pid !== ownPid);
}

/** Processes whose working directory or open files lie inside `directory`. */
export function findWorktreeProcesses(
  directory: string,
  runner: Runner = defaultRunner,
  ownPid = process.pid,
): FoundProcess[] {
  // lsof compares against resolved paths, so a symlinked directory (macOS /tmp) must be resolved.
  const resolved = existsSync(directory) ? realpathSync(directory) : directory;
  const result = runner(['lsof', '-F', 'pc', '+D', resolved]);
  return parseLsofFields(result.stdout).filter((item) => item.pid !== ownPid);
}

export interface LeftoversRequest {
  lockPattern?: string;
  worktrees?: string[];
  pids?: number[];
}

export function findLeftovers(
  request: LeftoversRequest,
  dependencies: Partial<LeftoversDependencies> = {},
): LeftoversReport {
  const runner = dependencies.runner ?? defaultRunner;
  const isAlive = dependencies.isAlive ?? processIsAlive;
  const ownPid = dependencies.ownPid ?? process.pid;
  const lockProcesses =
    request.lockPattern === undefined ? [] : findLockProcesses(request.lockPattern, runner, ownPid);
  const worktrees = (request.worktrees ?? []).map((path) => ({
    path,
    processes: findWorktreeProcesses(path, runner, ownPid),
  }));
  const pids = (request.pids ?? []).map((pid) => ({ pid, alive: isAlive(pid) }));
  const found =
    lockProcesses.length > 0 ||
    worktrees.some((item) => item.processes.length > 0) ||
    pids.some((item) => item.alive);
  return { lockProcesses, worktrees, pids, found };
}

function renderProcess(item: FoundProcess): string {
  const command = item.command.length > 100 ? `${item.command.slice(0, 97)}...` : item.command;
  return `  ${item.pid} ${command}`;
}

export function renderLeftovers(report: LeftoversReport): string {
  if (!report.found && report.pids.length === 0 && report.worktrees.length === 0)
    return 'Nothing found.';
  const lines: string[] = [];
  lines.push(`lock processes: ${report.lockProcesses.length}`);
  for (const item of report.lockProcesses) lines.push(renderProcess(item));
  for (const worktree of report.worktrees) {
    lines.push(`worktree ${worktree.path}: ${worktree.processes.length} process(es)`);
    for (const item of worktree.processes) lines.push(renderProcess(item));
  }
  if (report.pids.length > 0) {
    const alive = report.pids.filter((item) => item.alive).map((item) => item.pid);
    const dead = report.pids.filter((item) => !item.alive).map((item) => item.pid);
    lines.push(`pids alive: ${alive.length === 0 ? 'none' : alive.join(',')}`);
    if (dead.length > 0) lines.push(`pids gone: ${dead.join(',')}`);
  }
  lines.push(report.found ? 'Leftovers found.' : 'Nothing found.');
  return lines.join('\n');
}

export function run(
  argv: string[],
  dependencies: Partial<LeftoversDependencies> = {},
): { code: number; output: string } {
  const parsed = parseOptions(argv, {
    values: ['config', 'pids'],
    repeated: ['worktree'],
    flags: ['json'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const config = loadRepositoryConfig(parsed.values.config ?? DEFAULT_CONFIGURATION_PATH);
  let pids: number[] = [];
  if (parsed.values.pids !== undefined) {
    pids = parsed.values.pids.split(',').map((item) => Number(item.trim()));
    if (pids.some((pid) => !Number.isInteger(pid) || pid <= 0))
      throw new UsageError('--pids takes a comma-separated list of process ids.');
  }
  const report = findLeftovers(
    { lockPattern: config.lockPattern, worktrees: parsed.repeated.worktree, pids },
    dependencies,
  );
  return {
    code: report.found ? 1 : 0,
    output: parsed.flags.has('json') ? JSON.stringify(report) : renderLeftovers(report),
  };
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
