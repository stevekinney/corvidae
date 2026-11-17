#!/usr/bin/env bun
// Chef workers: the coordinator's restart check. It reads the workers a run log records as live
// (a `worker-start` entry with no later `worker-end` for the same agent) and prints, per worker,
// its worktree, last commit time, unpushed commit count, uncommitted file count, and whether its
// transcript grew in the last five minutes, so a restart cannot strand finished commits silently
// (COR-2464). It only reads: it never ends a process, removes a worktree, fetches, or writes a
// file. The unpushed count compares with the last fetched `origin/<branch>`, and with
// `origin/main` when the branch was never pushed.
//
// Log entry format (a line anywhere in the run log; the entry is the part from the keyword on):
//   worker-start agent=<id> issue=<COR-n> worktree=<path> branch=<branch> [transcript=<path>]
//   worker-end agent=<id>
//
// Usage:
//   bun scripts/chef/workers.ts <run-log> [--json]
//
// Exit codes: 0 every recorded live worker is clean (nothing unpushed or uncommitted), 1 a worker
// has unpushed or uncommitted work or its worktree is missing, 2 invalid CLI usage.

import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  type Runner,
  UsageError,
} from './process-runner.ts';

export { UsageError };

export const TRANSCRIPT_WINDOW_MILLISECONDS = 5 * 60 * 1000;

export interface RecordedWorker {
  agent: string;
  issue: string;
  worktree: string;
  branch: string;
  transcript?: string;
}

export interface WorkerState extends RecordedWorker {
  /** Why the worktree could not be read; present only then, and it counts as needing attention. */
  error?: string;
  lastCommit?: string;
  unpushed?: number;
  /** The ref the unpushed count compares with. */
  against?: string;
  uncommitted?: number;
  /** Whether the transcript changed in the last five minutes; absent without a recorded transcript. */
  transcriptGrew?: boolean;
}

/** The workers a log records as started and not yet ended, in start order. */
export function parseLiveWorkers(log: string): RecordedWorker[] {
  const live = new Map<string, RecordedWorker>();
  for (const line of log.split('\n')) {
    const match = /\bworker-(start|end)\b(.*)$/.exec(line);
    if (match === null) continue;
    const fields = Object.fromEntries(
      [...(match[2] ?? '').matchAll(/(\w+)=(\S+)/g)].map((pair) => [pair[1], pair[2]]),
    ) as Record<string, string | undefined>;
    const agent = fields['agent'];
    if (agent === undefined) continue;
    if (match[1] === 'end') {
      live.delete(agent);
      continue;
    }
    const { issue, worktree, branch, transcript } = fields;
    if (issue === undefined || worktree === undefined || branch === undefined) continue;
    live.set(agent, {
      agent,
      issue,
      worktree,
      branch,
      ...(transcript === undefined ? {} : { transcript }),
    });
  }
  return [...live.values()];
}

export interface WorkerDependencies {
  runner: Runner;
  now: () => number;
  modifiedAt: (path: string) => number | undefined;
}

const readOnlyEnvironment = { GIT_OPTIONAL_LOCKS: '0' };

function modifiedTime(path: string): number | undefined {
  return existsSync(path) ? statSync(path).mtimeMs : undefined;
}

export function inspectWorker(
  worker: RecordedWorker,
  dependencies: Partial<WorkerDependencies> = {},
): WorkerState {
  const runner = dependencies.runner ?? defaultRunner;
  const now = (dependencies.now ?? Date.now)();
  const git = (...args: string[]) =>
    runner(['git', '-C', worker.worktree, ...args], { env: readOnlyEnvironment });
  const state: WorkerState = { ...worker };
  if (worker.transcript !== undefined) {
    const modified = (dependencies.modifiedAt ?? modifiedTime)(worker.transcript);
    state.transcriptGrew =
      modified !== undefined && now - modified <= TRANSCRIPT_WINDOW_MILLISECONDS;
  }
  if (!existsSync(worker.worktree)) {
    state.error = 'the worktree does not exist';
    return state;
  }
  const last = git('log', '-1', '--format=%cI');
  if (last.code !== 0) {
    state.error = `git log failed: ${last.stderr.trim()}`;
    return state;
  }
  state.lastCommit = last.stdout.trim();
  const pushed = git('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${worker.branch}`);
  state.against = pushed.code === 0 ? `origin/${worker.branch}` : 'origin/main';
  const count = git('rev-list', '--count', `${state.against}..HEAD`);
  if (count.code === 0) state.unpushed = Number(count.stdout.trim());
  else state.error = `git rev-list failed: ${count.stderr.trim()}`;
  const status = git('status', '--porcelain');
  if (status.code === 0) {
    state.uncommitted = status.stdout.split('\n').filter((line) => line !== '').length;
  } else {
    state.error = `git status failed: ${status.stderr.trim()}`;
  }
  return state;
}

export function needsAttention(state: WorkerState): boolean {
  return state.error !== undefined || (state.unpushed ?? 0) > 0 || (state.uncommitted ?? 0) > 0;
}

export function renderWorkers(states: WorkerState[]): string {
  if (states.length === 0) return 'No live workers recorded.';
  const lines: string[] = [];
  for (const state of states) {
    lines.push(`${state.issue} agent ${state.agent} on ${state.branch}`);
    lines.push(`  worktree: ${state.worktree}`);
    if (state.error !== undefined) lines.push(`  error: ${state.error}`);
    if (state.lastCommit !== undefined) lines.push(`  last commit: ${state.lastCommit}`);
    if (state.unpushed !== undefined) {
      lines.push(`  unpushed commits: ${state.unpushed} (against ${state.against})`);
    }
    if (state.uncommitted !== undefined) lines.push(`  uncommitted files: ${state.uncommitted}`);
    if (state.transcriptGrew !== undefined) {
      lines.push(
        `  transcript grew in the last five minutes: ${state.transcriptGrew ? 'yes' : 'no'}`,
      );
    }
  }
  return lines.join('\n');
}

export function run(
  argv: string[],
  dependencies: Partial<WorkerDependencies> = {},
): { code: number; output: string } {
  const parsed = parseOptions(argv, { flags: ['json'] });
  const [path, ...extra] = parsed.positionals;
  if (path === undefined) throw new UsageError('Name the run log file.');
  if (extra.length > 0) throw new UsageError(`Unexpected argument ${extra[0]}.`);
  if (!existsSync(path)) throw new UsageError(`No run log at ${path}.`);
  const states = parseLiveWorkers(readFileSync(path, 'utf8')).map((worker) =>
    inspectWorker(worker, dependencies),
  );
  return {
    code: states.some(needsAttention) ? 1 : 0,
    output: parsed.flags.has('json') ? JSON.stringify(states) : renderWorkers(states),
  };
}

if (import.meta.main) {
  try {
    const { code, output } = run(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
