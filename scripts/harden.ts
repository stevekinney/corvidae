#!/usr/bin/env bun
/**
 * Hardening: run the tests that can depend on host load, repeatedly, on a host kept deliberately
 * busy, so a flake shows up here on purpose instead of at random in someone's gate.
 *
 * `bun run check` (the quick tier) never runs the isolated lanes: `*.slow.test.ts` and
 * `*.integration.test.ts` files, the tests that start a process or an out-of-process service.
 * `bun run validate` runs them once, on a host that is usually quiet. This runs them `--rounds`
 * times (default 3) with `--load` busy processes (default half the processors) spinning beside
 * them, then runs the fast lanes once under the same load. Every Turborepo task runs with
 * `--force`, because a replayed cache entry proves nothing about this run.
 *
 * Usage (from the repository root; `bun run harden` takes the host lock first):
 *   bun scripts/harden.ts [--rounds <n>] [--load <n>] [--isolated-only] [--json]
 *
 * It records each round's command and exit code in `tmp/harden/<timestamp>.json` under the main
 * checkout and prints a short summary. A failure is a flake candidate, never a reason to retry
 * until green: compare it against the base with `bun scripts/chef/gate-run.ts control`, and file
 * the fix as a COR issue (AGENTS.md "Test tiers").
 *
 * Exit codes: 0 every round passed, 1 a round failed, 2 invalid usage.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { parseOptions, UsageError } from './chef/process-runner.ts';

export interface HardenOptions {
  rounds: number;
  load: number;
  isolatedOnly: boolean;
  json: boolean;
}

export interface Step {
  /** `isolated-<round>` or `fast`. */
  label: string;
  command: string[];
}

export interface StepResult {
  label: string;
  command: string;
  exitCode: number;
}

const DEFAULT_ROUNDS = 3;

/** The isolated lanes, serial, as `bun run test:slow` runs them, but never from the cache. */
const ISOLATED_COMMAND = [
  'bunx',
  'turbo',
  'run',
  'test:slow',
  'test:self:slow',
  '--concurrency=1',
  '--force',
];

/** The fast lanes, as `bun run test` runs them, but never from the cache. */
const FAST_COMMAND = [
  'bunx',
  'turbo',
  'run',
  'test:self',
  'test',
  'test:browser-fixtures',
  '--force',
];

/** The command a load generator runs: one busy loop that never yields. */
export const LOAD_COMMAND = ['bun', '-e', 'for (;;) {}'];

export function parseHardenOptions(argv: string[], processors: number): HardenOptions {
  const parsed = parseOptions(argv, {
    values: ['rounds', 'load'],
    flags: ['isolated-only', 'json'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const count = (name: string, fallback: number, minimum: number): number => {
    const raw = parsed.values[name];
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < minimum)
      throw new UsageError(`--${name} must be a whole number of at least ${minimum}.`);
    return Number(raw);
  };
  return {
    rounds: count('rounds', DEFAULT_ROUNDS, 1),
    load: count('load', Math.max(1, Math.floor(processors / 2)), 0),
    isolatedOnly: parsed.flags.has('isolated-only'),
    json: parsed.flags.has('json'),
  };
}

/** The steps of one hardening run, in order: every isolated round, then the fast lanes once. */
export function planSteps(options: HardenOptions): Step[] {
  const steps: Step[] = [];
  for (let round = 1; round <= options.rounds; round += 1)
    steps.push({ label: `isolated-${round}`, command: ISOLATED_COMMAND });
  if (!options.isolatedOnly) steps.push({ label: 'fast', command: FAST_COMMAND });
  return steps;
}

/** The verdict and the lines to print for a finished run. */
export function summarize(
  results: StepResult[],
  options: HardenOptions,
): { code: number; lines: string[] } {
  const failed = results.filter((result) => result.exitCode !== 0);
  const lines = [
    `harden: ${results.length} step(s) under ${options.load} load generator(s); ${failed.length} failed.`,
    ...results.map((result) => `  ${result.label}: exit ${result.exitCode}`),
  ];
  if (failed.length > 0)
    lines.push(
      'A failure here is a flake candidate. Compare it against the base with',
      '`bun scripts/chef/gate-run.ts control`, then file the fix as a COR issue; never rerun until green.',
    );
  return { code: failed.length > 0 ? 1 : 0, lines };
}

/** The main checkout: the parent of the Git common directory, so a worktree's run survives it. */
function mainCheckout(): string {
  const result = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  return join(result.stdout.toString().trim(), '..');
}

async function main(): Promise<number> {
  let options: HardenOptions;
  try {
    options = parseHardenOptions(Bun.argv.slice(2), availableParallelism());
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  const generators = Array.from({ length: options.load }, () =>
    Bun.spawn(LOAD_COMMAND, { stdout: 'ignore', stderr: 'ignore' }),
  );
  const stopLoad = () => {
    for (const generator of generators) generator.kill('SIGKILL');
  };
  process.on('SIGINT', () => {
    stopLoad();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    stopLoad();
    process.exit(143);
  });
  const results: StepResult[] = [];
  try {
    for (const step of planSteps(options)) {
      process.stdout.write(`\nharden: ${step.label}: ${step.command.join(' ')}\n`);
      const child = Bun.spawn(step.command, { stdout: 'inherit', stderr: 'inherit' });
      results.push({
        label: step.label,
        command: step.command.join(' '),
        exitCode: await child.exited,
      });
    }
  } finally {
    stopLoad();
    await Promise.all(generators.map((generator) => generator.exited));
  }
  const { code, lines } = summarize(results, options);
  const directory = join(mainCheckout(), 'tmp', 'harden');
  mkdirSync(directory, { recursive: true });
  const record = join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(record, `${JSON.stringify({ options, results, code }, null, 2)}\n`);
  process.stdout.write(
    options.json
      ? `${JSON.stringify({ ok: code === 0, record, results })}\n`
      : `\n${[...lines, `Record: ${record}`].join('\n')}\n`,
  );
  return code;
}

if (import.meta.main) process.exitCode = await main();
