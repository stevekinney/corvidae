#!/usr/bin/env bun
// Outcome accounting combines explicitly linked attempts. It does not infer a run from account-wide
// telemetry: callers provide the outcome boundary and the transcript paths that belong to it.
//
// Usage:
//   bun scripts/chef/outcome-accounting.ts verify-task-bank <path>
//   bun scripts/chef/outcome-accounting.ts initialize <record> <outcome> [<allowance> <provenance>]
//   bun scripts/chef/outcome-accounting.ts reserve <record> <outcome> <operation> <tokens>
//   bun scripts/chef/outcome-accounting.ts settle <record> <outcome> <operation> <tokens>
//   bun scripts/chef/outcome-accounting.ts release <record> <outcome> <operation>
//   bun scripts/chef/outcome-accounting.ts read <record> <outcome>
//
// Exit codes: 0 verified, 1 invalid task bank, 2 invalid CLI usage.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initialize, release, reserve, settle } from './outcome-budget.ts';
import {
  costOf,
  readTranscript,
  transcriptFiles,
  type Price,
  type UsageProblem,
} from './transcript-usage.ts';

export interface AttemptLink {
  id: string;
  kind: 'root' | 'child' | 'correction' | 'restart';
  status: 'accepted' | 'failed' | 'cancelled' | 'resumed';
  transcriptPaths: string[];
  startedAt?: string;
  endedAt?: string;
}

export interface OutcomeRecord {
  id: string;
  source: string;
  task: string;
  provider: string;
  requestedModel: string;
  observedModel: string;
  requestedEffort: string;
  observedEffort: string;
  policyRevision: string;
  requiredCriteria: string[];
  completedCriteria: string[];
  deliveryState: 'pending' | 'delivered' | 'failed';
  reviewerEffort: string;
  humanInterventions: string[];
  verificationMilliseconds: number | 'unknown';
  budget?: BudgetState;
  attempts: AttemptLink[];
}

export interface TokenTotals {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface OutcomeAccounting {
  outcome: OutcomeRecord;
  tokens: TokenTotals;
  cost: number | 'unknown';
  incompleteUsage: UsageProblem[];
  includedTranscriptPaths: string[];
  deliveryThroughput: number;
  outcomeSuccess: boolean;
  escapedSeededDefects: number | 'unknown';
  elapsedVerificationMilliseconds: number | 'unknown';
  humanInterventions: number;
}

export interface BudgetState {
  allowanceTokens?: number;
  spentTokens: number;
  reservedTokens: number;
}

export interface BudgetAssessment {
  allowanceTokens: number | 'unknown';
  cumulativeCommittedTokens: number;
  softLimitReached: boolean;
  mayDispatch: boolean;
  hardLimitEnforced: false;
}

function inAttempt(callTime: string | undefined, attempt: AttemptLink): boolean {
  if (callTime === undefined)
    return attempt.startedAt === undefined && attempt.endedAt === undefined;
  return (
    (attempt.startedAt === undefined || callTime >= attempt.startedAt) &&
    (attempt.endedAt === undefined || callTime <= attempt.endedAt)
  );
}

function emptyTokens(): TokenTotals {
  return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

/** Account only explicitly linked paths once, and only calls inside each attempt's declared window. */
export function accountOutcome(
  outcome: OutcomeRecord,
  prices?: Record<string, Price>,
  escapedSeededDefects: number | 'unknown' = 'unknown',
): OutcomeAccounting {
  const tokens = emptyTokens();
  const incompleteUsage: UsageProblem[] = [];
  const paths = new Map<string, AttemptLink[]>();
  const calls = [] as NonNullable<ReturnType<typeof readTranscript>>['calls'];
  for (const attempt of outcome.attempts) {
    let files: string[];
    try {
      files = attempt.transcriptPaths.flatMap(transcriptFiles);
    } catch (error) {
      incompleteUsage.push({ kind: 'malformed-line', line: 0, message: String(error) });
      continue;
    }
    for (const file of files) {
      const path = resolve(file);
      const linked = paths.get(path) ?? [];
      linked.push(attempt);
      paths.set(path, linked);
    }
  }
  for (const [path, attempts] of paths) {
    const transcript = readTranscript(path);
    if (transcript === undefined) {
      incompleteUsage.push({
        kind: 'malformed-line',
        line: 0,
        message: `${path} is not a supported transcript.`,
      });
      continue;
    }
    incompleteUsage.push(...transcript.problems);
    if (transcript.calls.length === 0)
      incompleteUsage.push({
        kind: 'missing-usage',
        line: 0,
        message: `${path} has no model calls.`,
      });
    if (
      attempts.some(
        (attempt) => attempt.startedAt !== undefined || attempt.endedAt !== undefined,
      ) &&
      transcript.calls.some((call) => call.timestamp === undefined)
    )
      incompleteUsage.push({
        kind: 'missing-usage',
        line: 0,
        message: `${path} has an unscoped call without a timestamp.`,
      });
    for (const call of transcript.calls.filter((entry) =>
      attempts.some((attempt) => inAttempt(entry.timestamp, attempt)),
    )) {
      tokens.uncachedInput += call.uncachedInput;
      tokens.cacheRead += call.cacheRead;
      tokens.cacheWrite += call.cacheWrite;
      tokens.output += call.output;
      calls.push(call);
    }
  }
  const costs = calls.map((call) => costOf(call, prices));
  const cost =
    prices !== undefined &&
    incompleteUsage.length === 0 &&
    costs.every((value) => value !== undefined)
      ? costs.reduce((total, value) => total + (value ?? 0), 0)
      : 'unknown';
  return {
    outcome,
    tokens,
    cost,
    incompleteUsage,
    includedTranscriptPaths: [...paths.keys()].toSorted(),
    deliveryThroughput: outcome.deliveryState === 'delivered' ? 1 : 0,
    outcomeSuccess:
      outcome.deliveryState === 'delivered' &&
      outcome.requiredCriteria.every((criterion) => outcome.completedCriteria.includes(criterion)),
    escapedSeededDefects,
    elapsedVerificationMilliseconds: outcome.verificationMilliseconds,
    humanInterventions: outcome.humanInterventions.length,
  };
}

/** Allowances are optional and cumulative; an unknown allowance never becomes an invented limit. */
export function assessBudget(state: BudgetState): BudgetAssessment {
  const cumulativeCommittedTokens = state.spentTokens + state.reservedTokens;
  const softLimitReached =
    state.allowanceTokens !== undefined && cumulativeCommittedTokens >= state.allowanceTokens;
  return {
    allowanceTokens: state.allowanceTokens ?? 'unknown',
    cumulativeCommittedTokens,
    softLimitReached,
    mayDispatch: !softLimitReached,
    hardLimitEnforced: false,
  };
}

export interface TaskSnapshot {
  id: string;
  family:
    | 'local-regression'
    | 'cross-workspace-contract'
    | 'concurrency'
    | 'agreed-ui-behavior'
    | 'interrupted-delivery';
  baseRevision: string;
  heldOut: boolean;
  permittedPaths: string[];
  deliveryBoundary: string;
  files: {
    candidatePath: string;
    candidate: string;
    repaired: string;
    empty: string;
    oraclePath: string;
    oracle: string;
  };
}

export interface TaskBank {
  version: 1;
  orderSeed: string;
  policySnapshot: string;
  tasks: TaskSnapshot[];
}

/** Validate frozen task-bank structure and its independently executable fixture oracle. */
export function verifyTaskBank(bank: TaskBank): string[] {
  const errors: string[] = [];
  if (!bank.orderSeed) errors.push('Task bank needs an order seed.');
  if (!bank.policySnapshot) errors.push('Task bank needs an immutable policy snapshot.');
  if (bank.tasks.length !== 10) errors.push('Task bank needs exactly ten tasks.');
  const families = new Map<string, TaskSnapshot[]>();
  for (const task of bank.tasks) {
    const group = families.get(task.family) ?? [];
    group.push(task);
    families.set(task.family, group);
    if (!task.baseRevision || !task.deliveryBoundary || task.permittedPaths.length === 0)
      errors.push(`${task.id} is missing a frozen boundary.`);
    if (
      !task.files.candidatePath ||
      !task.files.candidate ||
      !task.files.repaired ||
      !task.files.empty ||
      !task.files.oraclePath ||
      !task.files.oracle
    )
      errors.push(`${task.id} has no executable input or oracle.`);
  }
  for (const [family, tasks] of families) {
    if (tasks.length !== 2 || tasks.filter((task) => task.heldOut).length !== 1)
      errors.push(`${family} needs one tuning task and one held-out task.`);
  }
  return errors;
}

/** Prove each oracle rejects its buggy and empty candidates while accepting the repair. */
export function verifyTaskControls(bank: TaskBank, scratch = tmpdir()): string[] {
  const errors = verifyTaskBank(bank);
  const directory = mkdtempSync(join(scratch, 'chef-task-bank-'));
  try {
    for (const task of bank.tasks) {
      const oracle = join(directory, `${task.id}-oracle.ts`);
      writeFileSync(oracle, task.files.oracle);
      for (const [name, contents, expected] of [
        ['buggy', task.files.candidate, 1],
        ['repaired', task.files.repaired, 0],
        ['empty', task.files.empty, 1],
      ] as const) {
        const candidate = join(directory, `${task.id}-${name}.ts`);
        writeFileSync(candidate, contents);
        const result = Bun.spawnSync(['bun', oracle, candidate]);
        if (result.exitCode !== expected)
          errors.push(
            `${task.id} ${name} control exited ${result.exitCode}, expected ${expected}.`,
          );
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return errors;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'initialize' && (argv.length === 3 || argv.length === 5)) {
    const allowance =
      argv.length === 5 ? { amount: Number(argv[3]), provenance: argv[4] ?? '' } : undefined;
    process.stdout.write(`${JSON.stringify(await initialize(argv[1]!, argv[2]!, allowance))}\n`);
    return 0;
  }
  if (argv[0] === 'read' && argv.length === 3) {
    process.stdout.write(`${JSON.stringify(await initialize(argv[1]!, argv[2]!))}\n`);
    return 0;
  }
  if (argv[0] === 'reserve' && argv.length === 5) {
    process.stdout.write(
      `${JSON.stringify(await reserve(argv[1]!, argv[2]!, argv[3]!, Number(argv[4])))}\n`,
    );
    return 0;
  }
  if (argv[0] === 'settle' && argv.length === 5) {
    process.stdout.write(
      `${JSON.stringify(await settle(argv[1]!, argv[2]!, argv[3]!, Number(argv[4])))}\n`,
    );
    return 0;
  }
  if (argv[0] === 'release' && argv.length === 4) {
    process.stdout.write(`${JSON.stringify(await release(argv[1]!, argv[2]!, argv[3]!))}\n`);
    return 0;
  }
  if (argv[0] !== 'verify-task-bank' || argv.length !== 2) return 2;
  const path = argv[1] ?? '';
  if (!existsSync(path)) return 2;
  let bank: TaskBank;
  try {
    bank = JSON.parse(readFileSync(path, 'utf8')) as TaskBank;
  } catch {
    return 2;
  }
  const errors = verifyTaskControls(bank);
  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`);
    return 1;
  }
  process.stdout.write(`Verified ${bank.tasks.length} frozen tasks with seed ${bank.orderSeed}.\n`);
  return 0;
}

if (import.meta.main) {
  main(Bun.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
      return undefined;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
