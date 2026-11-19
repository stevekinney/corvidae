#!/usr/bin/env bun
// Chef design-review round counter: bounds design review to one full round plus one narrow look per
// branch, then returns NEEDS_JUDGMENT. On 2026-11-17 one pull request took three rounds, two spot
// checks and nine workers, and each correction broke what the previous round had accepted; the cap
// was prose in three places and no script counted. Coverage comes before counting: a round counts
// only when its capture met the manifest the design rows declare, so an incomplete capture neither
// spends a round nor passes for one.
//
// Usage:
//   bun scripts/chef/design-rounds.ts dispatch --branch <name> --capture <directory>
//                                     [--state-directory <directory>] [--json]
//   bun scripts/chef/design-rounds.ts status --branch <name> [--state-directory <directory>] [--json]
//
// Run `dispatch` before each `design-reviewer` dispatch. `--capture` is the capture directory of the
// round, whose `summary.json` must hold `coverage.complete: true`, which
// `bun scripts/design-review-capture.ts --expect <expected-captures.json>` writes. The count lives in
// `design-rounds.json` under the main checkout's `tmp/chef/execution-state`, never in a worktree, so
// a worker's fresh checkout cannot reset it. Dispatching the same capture again is the same round
// (a malformed verdict sent back to the same reviewer).
//
// Exit codes: 0 the round may be dispatched; 1 the round was refused (incomplete coverage or the
// rounds are spent: NEEDS_JUDGMENT); 2 invalid usage.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

import { acquireHostLock, processStartTime } from '../run-exclusively.ts';
import { emitResult, parseOptions, requireOption, UsageError } from './process-runner.ts';
import { resolveMainCheckout } from './repository-locations.ts';

/** One full round, then one narrow look. */
export const ROUND_LIMIT = 2;

/** What each counted round is called. */
const ROUND_NAMES = ['full round', 'narrow look'] as const;

interface BranchRounds {
  rounds: { capture: string }[];
}

interface RoundsFile {
  version: 1;
  branches: Record<string, BranchRounds>;
}

export interface RoundsDependencies {
  /** The directory that holds `design-rounds.json`; defaults to the main checkout's execution state. */
  stateDirectory?: string;
}

function stateDirectoryOf(
  parsedValue: string | undefined,
  dependencies: RoundsDependencies,
): string {
  return resolve(
    dependencies.stateDirectory ??
      parsedValue ??
      join(resolveMainCheckout(), 'tmp', 'chef', 'execution-state'),
  );
}

function readRounds(path: string): RoundsFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { version: 1, branches: Object.create(null) as Record<string, BranchRounds> };
  }
  const parsed = JSON.parse(text) as Partial<RoundsFile> | null;
  if (parsed === null || parsed.version !== 1 || typeof parsed.branches !== 'object')
    throw new UsageError(`${path} is not a design-rounds file; fix or remove it.`);
  const branches = Object.create(null) as Record<string, BranchRounds>;
  for (const [name, value] of Object.entries(parsed.branches))
    branches[name] = { rounds: Array.isArray(value?.rounds) ? value.rounds : [] };
  return { version: 1, branches };
}

function roundsOf(file: RoundsFile, branch: string): BranchRounds {
  return Object.hasOwn(file.branches, branch)
    ? (file.branches[branch] as BranchRounds)
    : { rounds: [] };
}

/** A capture's coverage verdict from its `summary.json`: complete, or the reason it is not. */
function coverageProblem(capture: string): string | undefined {
  let summary: { coverage?: { complete?: unknown; missing?: unknown } };
  try {
    summary = JSON.parse(readFileSync(join(capture, 'summary.json'), 'utf8'));
  } catch {
    return `${capture} has no readable summary.json; capture with design-review-capture.ts --expect <expected-captures.json>`;
  }
  const coverage = summary.coverage;
  if (coverage === undefined || typeof coverage.complete !== 'boolean')
    return `${capture} was captured without --expect, so its coverage is unproven`;
  if (coverage.complete) return undefined;
  const missing = Array.isArray(coverage.missing) ? coverage.missing.length : 0;
  return `the capture is missing ${missing} declared state(s); each is named in its summary.json under coverage.missing`;
}

async function underLock<T>(stateDirectory: string, operation: () => T): Promise<T> {
  const lockDirectory = join(stateDirectory, 'locks', 'design-rounds');
  mkdirSync(join(stateDirectory, 'locks'), { recursive: true });
  const pidStartedAt = processStartTime(process.pid);
  const lock = await acquireHostLock({
    lockDirectory,
    holder: {
      pid: process.pid,
      ...(pidStartedAt === undefined ? {} : { pidStartedAt }),
      command: 'chef design-rounds',
      cwd: process.cwd(),
      acquiredAt: new Date().toISOString(),
    },
    pollIntervalMs: 5,
  });
  try {
    return operation();
  } finally {
    await lock.release();
  }
}

function save(path: string, file: RoundsFile): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(temporary, path);
}

function report(
  json: boolean,
  code: number,
  fields: Record<string, unknown>,
  text: string,
): { code: number; output: string } {
  return { code, output: json ? JSON.stringify({ ok: code === 0, ...fields }) : text };
}

export async function run(
  argv: string[],
  dependencies: RoundsDependencies = {},
): Promise<{ code: number; output: string }> {
  const parsed = parseOptions(argv, {
    values: ['branch', 'capture', 'state-directory'],
    flags: ['json'],
  });
  const [command] = parsed.positionals;
  if (parsed.positionals.length !== 1 || (command !== 'dispatch' && command !== 'status'))
    throw new UsageError(
      'Usage: design-rounds.ts dispatch --branch <name> --capture <directory> | status --branch <name> [--state-directory <directory>] [--json]',
    );
  const branch = requireOption(parsed, 'branch');
  const json = parsed.flags.has('json');
  const stateDirectory = stateDirectoryOf(parsed.values['state-directory'], dependencies);
  const path = join(stateDirectory, 'design-rounds.json');
  mkdirSync(stateDirectory, { recursive: true });

  if (command === 'status') {
    const used = roundsOf(readRounds(path), branch).rounds.length;
    return report(
      json,
      0,
      { branch, used, limit: ROUND_LIMIT },
      `${branch}: ${used} of ${ROUND_LIMIT} design-review rounds used.`,
    );
  }

  const capture = resolve(requireOption(parsed, 'capture'));
  // Coverage first: a capture that missed a declared state spends nothing and passes for nothing.
  const problem = coverageProblem(capture);
  if (problem !== undefined)
    return report(
      json,
      1,
      { branch, counted: false, reason: problem },
      `Design round not counted and not dispatchable: ${problem}.`,
    );
  return underLock(stateDirectory, () => {
    const file = readRounds(path);
    const rounds = roundsOf(file, branch);
    const seen = rounds.rounds.findIndex((round) => round.capture === capture);
    if (seen >= 0)
      return report(
        json,
        0,
        { branch, round: seen + 1, counted: false, repeat: true },
        `${branch}: ${ROUND_NAMES[seen]} (round ${seen + 1} of ${ROUND_LIMIT}) already counted for this capture.`,
      );
    if (rounds.rounds.length >= ROUND_LIMIT)
      return report(
        json,
        1,
        { branch, status: 'NEEDS_JUDGMENT', used: rounds.rounds.length, limit: ROUND_LIMIT },
        `NEEDS_JUDGMENT: ${branch} has used its ${ROUND_LIMIT} design-review rounds (one full round and one narrow look). Stop dispatching reviewers; the coordinator decides which findings stand.`,
      );
    file.branches[branch] = { rounds: [...rounds.rounds, { capture }] };
    save(path, file);
    const round = rounds.rounds.length + 1;
    return report(
      json,
      0,
      { branch, round, name: ROUND_NAMES[round - 1], counted: true, host: hostname() },
      `${branch}: ${ROUND_NAMES[round - 1]} (round ${round} of ${ROUND_LIMIT}) counted; dispatch the design-reviewer${round === ROUND_LIMIT ? ', on what changed since the last round only, and no further round follows' : ''}.`,
    );
  });
}

if (import.meta.main) {
  try {
    const result = await run(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), result);
    process.exitCode = result.code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
