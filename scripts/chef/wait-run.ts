#!/usr/bin/env bun
// Chef run waiter: waits for a GitHub Actions run to finish with one `gh run view <id> --json
// status` call per interval, and prints its conclusion and each job's name and conclusion once.
// Never use `gh run watch`: it polls every few seconds, and loops of it from many sessions
// drained the account's 5000-call API limit to zero on 2026-11-17. Before each poll this reads
// `gh api rate_limit`, which costs nothing, and when fewer than 500 calls remain it sleeps until
// the limit resets.
//
// Usage:
//   bun scripts/chef/wait-run.ts <run id> [--interval-seconds 180] [--json]
//
// `--interval-seconds` defaults to 180 and is at least 60.
//
// Exit codes: 0 the run succeeded, 1 it finished without success, 2 invalid CLI usage or GitHub
// could not be read.

import {
  defaultRunner,
  emitResult,
  parseOptions,
  type Runner,
  UsageError,
} from './process-runner.ts';

export { UsageError };

export const DEFAULT_INTERVAL_SECONDS = 180;
export const MINIMUM_INTERVAL_SECONDS = 60;
/** Below this many remaining core calls, wait for the reset before polling. */
export const RATE_LIMIT_FLOOR = 500;
/** Seconds past the reset before the next poll, so the new window has begun. */
const RESET_MARGIN_SECONDS = 5;

export interface WaitDependencies {
  runner: Runner;
  /** Resolves after `seconds`; tests substitute one that returns at once. */
  sleep: (seconds: number) => Promise<void>;
  /** The current time in seconds since the epoch. */
  now: () => number;
}

export interface JobConclusion {
  name: string;
  conclusion: string;
}

export interface WaitResult {
  run: string;
  conclusion: string;
  jobs: JobConclusion[];
  polls: number;
  rateLimitWaits: number;
}

function gh(runner: Runner, args: string[]): string {
  const result = runner(['gh', ...args]);
  if (result.code !== 0)
    throw new UsageError(
      `gh ${args.slice(0, 2).join(' ')} failed (exit ${result.code}): ${result.stderr.trim().split('\n')[0] ?? ''}`,
    );
  return result.stdout;
}

/** The seconds to wait for the rate limit to reset, or 0 when enough calls remain or it is unreadable. */
export function rateLimitWait(runner: Runner, now: number): number {
  const result = runner([
    'gh',
    'api',
    'rate_limit',
    '--jq',
    '.resources.core | "\\(.remaining) \\(.reset)"',
  ]);
  if (result.code !== 0) return 0;
  const [remaining, reset] = result.stdout.trim().split(' ').map(Number);
  if (remaining === undefined || reset === undefined) return 0;
  if (!Number.isFinite(remaining) || !Number.isFinite(reset) || remaining >= RATE_LIMIT_FLOOR)
    return 0;
  return Math.max(0, reset - now) + RESET_MARGIN_SECONDS;
}

function readStatus(runner: Runner, id: string): string {
  const parsed: unknown = JSON.parse(gh(runner, ['run', 'view', id, '--json', 'status']));
  const status = (parsed as { status?: unknown }).status;
  if (typeof status !== 'string') throw new UsageError(`Run ${id} has no readable status.`);
  return status;
}

function readOutcome(runner: Runner, id: string): { conclusion: string; jobs: JobConclusion[] } {
  const parsed = JSON.parse(gh(runner, ['run', 'view', id, '--json', 'conclusion,jobs'])) as {
    conclusion?: string;
    jobs?: { name?: string; conclusion?: string }[];
  };
  return {
    conclusion: parsed.conclusion || 'unknown',
    jobs: (parsed.jobs ?? []).map((job) => ({
      name: job.name ?? '',
      conclusion: job.conclusion || 'unknown',
    })),
  };
}

/** Poll until the run is `completed`, then read its conclusion and jobs once. */
export async function waitForRun(
  id: string,
  intervalSeconds: number,
  dependencies: WaitDependencies,
): Promise<WaitResult> {
  const { runner, sleep, now } = dependencies;
  let polls = 0;
  let rateLimitWaits = 0;
  for (;;) {
    const wait = rateLimitWait(runner, now());
    if (wait > 0) {
      rateLimitWaits += 1;
      await sleep(wait);
    }
    polls += 1;
    if (readStatus(runner, id) === 'completed') break;
    await sleep(intervalSeconds);
  }
  return { run: id, ...readOutcome(runner, id), polls, rateLimitWaits };
}

export function render(result: WaitResult): string {
  return [
    `run ${result.run}: ${result.conclusion}`,
    ...result.jobs.map((job) => `  ${job.name}: ${job.conclusion}`),
  ].join('\n');
}

export async function run(
  argv: string[],
  dependencies: WaitDependencies = {
    runner: defaultRunner,
    sleep: (seconds) => Bun.sleep(seconds * 1000),
    now: () => Math.floor(Date.now() / 1000),
  },
): Promise<{ code: number; output: string }> {
  const parsed = parseOptions(argv, { values: ['interval-seconds'], flags: ['json'] });
  const [id] = parsed.positionals;
  if (id === undefined || !/^\d+$/.test(id) || parsed.positionals.length > 1)
    throw new UsageError('Usage: wait-run.ts <run id> [--interval-seconds 180] [--json]');
  const interval = Number(parsed.values['interval-seconds'] ?? DEFAULT_INTERVAL_SECONDS);
  if (!Number.isInteger(interval) || interval < MINIMUM_INTERVAL_SECONDS)
    throw new UsageError(
      `--interval-seconds needs an integer of at least ${MINIMUM_INTERVAL_SECONDS}.`,
    );
  const result = await waitForRun(id, interval, dependencies);
  return {
    code: result.conclusion === 'success' ? 0 : 1,
    output: parsed.flags.has('json') ? JSON.stringify(result) : render(result),
  };
}

if (import.meta.main) {
  try {
    const { code, output } = await run(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
