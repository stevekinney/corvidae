#!/usr/bin/env bun
// Outcome accounting combines explicitly linked attempts. It does not infer a run from account-wide
// telemetry: callers provide the outcome boundary and the transcript paths that belong to it.
//
// Usage:
//   bun scripts/chef/outcome-accounting.ts verify-task-bank <path>
//
// Exit codes: 0 verified, 1 invalid task bank, 2 invalid CLI usage.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
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
  /** Complete, ordinary source tree used for the buggy baseline. */
  files: Record<string, string>;
  /** Evaluator-only replacements for files the trial is permitted to edit. */
  repairedFiles: Record<string, string>;
  oraclePath: string;
  oracleArgv: string[];
  acceptanceCases: string[];
}

export interface TaskBank {
  version: 1;
  orderSeed: string;
  policySnapshot: string;
  tasks: TaskSnapshot[];
}

const POLICY_SNAPSHOT_PATH = 'scripts/chef/fixtures/sdlc-policy-baseline.json';
const POLICY_SNAPSHOT_DIGEST = '8b288e55d76ef0df5b959d0f945b51a8176e270a188c0e6754a22f36b8bb6403';
const POLICY_BASE_REVISION = '721367ba220dc2384c83ee1c33b3a38bdf702e5b';
const POLICY_SOURCE_COUNT = 17;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_REVISION = /^[a-f0-9]{40}$/;
const TASK_ID = /^[a-z]+-[0-9]{2}$/;

function normalizedTaskPath(path: string): string | undefined {
  if (!path || isAbsolute(path)) return undefined;
  const normalized = normalize(path);
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${sep}`))
    return undefined;
  return normalized;
}

function sha256(contents: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(contents).digest('hex');
}

function policySnapshotReference(snapshot: string): { path: string; digest: string } | undefined {
  const separator = snapshot.lastIndexOf('@');
  if (separator < 1) return undefined;
  const path = snapshot.slice(0, separator);
  const digest = snapshot.slice(separator + 1);
  if (normalizedTaskPath(path) === undefined || !SHA256.test(digest)) return undefined;
  return { path, digest };
}

function policySnapshotErrors(bank: TaskBank): string[] {
  const reference = policySnapshotReference(bank.policySnapshot);
  if (reference === undefined) return ['Task bank has an invalid policy snapshot reference.'];
  if (reference.path !== POLICY_SNAPSHOT_PATH)
    return [`Task bank must use policy snapshot: ${POLICY_SNAPSHOT_PATH}.`];
  if (reference.digest !== POLICY_SNAPSHOT_DIGEST)
    return ['Task bank has an incorrect policy snapshot digest.'];
  return [];
}

function readPolicySnapshot(): unknown {
  try {
    const contents = readFileSync(POLICY_SNAPSHOT_PATH, 'utf8');
    if (sha256(contents) !== POLICY_SNAPSHOT_DIGEST) return undefined;
    return JSON.parse(contents) as unknown;
  } catch {
    return undefined;
  }
}

function gitSourceAt(baseRevision: string, path: string): Uint8Array | undefined {
  const result = Bun.spawnSync(['git', 'show', `${baseRevision}:${path}`], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.exitCode === 0 ? result.stdout : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Validate the frozen snapshot shape and source bytes through an injectable Git reader. */
export function validatePolicySnapshot(
  value: unknown,
  readSource: (baseRevision: string, path: string) => Uint8Array | undefined = gitSourceAt,
): string[] {
  const snapshot = record(value);
  if (snapshot === undefined) return ['Task bank policy snapshot is malformed.'];
  const baseRevision = snapshot['baseRevision'];
  if (
    baseRevision !== POLICY_BASE_REVISION ||
    typeof baseRevision !== 'string' ||
    !GIT_REVISION.test(baseRevision)
  )
    return ['Task bank policy snapshot has an invalid base revision.'];
  if (snapshot['repository'] !== 'stevekinney/corvidae')
    return ['Task bank policy snapshot has an invalid repository identity.'];
  const sourceMap = record(snapshot['sources']);
  if (sourceMap === undefined) return ['Task bank policy snapshot has malformed sources.'];
  const sources = Object.entries(sourceMap);
  if (sources.length !== POLICY_SOURCE_COUNT)
    return [`Task bank policy snapshot needs exactly ${POLICY_SOURCE_COUNT} sources.`];
  const errors: string[] = [];
  for (const [path, digest] of sources) {
    if (normalizedTaskPath(path) === undefined)
      errors.push(`Task bank policy snapshot has an unsafe source path: ${path}.`);
    else if (typeof digest !== 'string' || !SHA256.test(digest))
      errors.push(`Task bank policy snapshot has an invalid source digest: ${path}.`);
  }
  if (errors.length > 0) return errors;
  for (const [path, digest] of sources) {
    const contents = readSource(baseRevision, path);
    if (contents === undefined)
      errors.push(`Task bank policy snapshot source is absent from its base: ${path}.`);
    else if (sha256(contents) !== digest)
      errors.push(`Task bank policy snapshot source digest differs at its base: ${path}.`);
  }
  return errors;
}

/** Verify the immutable policy snapshot and its source hashes once per bank evaluation. */
export function verifyTaskBankProvenance(bank: TaskBank): string[] {
  const errors = policySnapshotErrors(bank);
  if (errors.length > 0) return errors;
  const snapshot = readPolicySnapshot();
  if (snapshot === undefined)
    return ['Task bank policy snapshot is missing, malformed, or changed.'];
  errors.push(...validatePolicySnapshot(snapshot));
  const typedSnapshot = record(snapshot);
  if (typedSnapshot?.['baseRevision'] !== POLICY_BASE_REVISION) return errors;
  if (bank.tasks.some((task) => task.baseRevision !== typedSnapshot['baseRevision']))
    errors.push('Task bank tasks must use the policy snapshot base revision.');
  return errors;
}

function taskPathErrors(task: TaskSnapshot): string[] {
  const errors: string[] = [];
  if (typeof task.id !== 'string' || !TASK_ID.test(task.id))
    errors.push(`${task.id} has an invalid task id.`);
  const files = new Set<string>();
  for (const path of Object.keys(task.files)) {
    const normalized = normalizedTaskPath(path);
    if (normalized === undefined) errors.push(`${task.id} has an unsafe file path: ${path}.`);
    else if (files.has(normalized))
      errors.push(`${task.id} has duplicate normalized file path: ${path}.`);
    else files.add(normalized);
  }
  const permitted = new Set<string>();
  for (const path of task.permittedPaths) {
    const normalized = normalizedTaskPath(path);
    if (normalized === undefined) errors.push(`${task.id} has an unsafe permitted path: ${path}.`);
    else if (!files.has(normalized)) errors.push(`${task.id} permits missing file: ${path}.`);
    else if (normalized === normalizedTaskPath(task.oraclePath))
      errors.push(`${task.id} permits its oracle: ${path}.`);
    else if (permitted.has(normalized))
      errors.push(`${task.id} has duplicate permitted path: ${path}.`);
    else permitted.add(normalized);
  }
  for (const path of Object.keys(task.repairedFiles)) {
    const normalized = normalizedTaskPath(path);
    if (normalized === undefined) errors.push(`${task.id} has an unsafe repaired path: ${path}.`);
    else if (!permitted.has(normalized))
      errors.push(`${task.id} repairs unpermitted path: ${path}.`);
    else if (normalized === normalizedTaskPath(task.oraclePath))
      errors.push(`${task.id} repairs its oracle: ${path}.`);
  }
  const oracle = normalizedTaskPath(task.oraclePath);
  if (oracle === undefined || !files.has(oracle)) errors.push(`${task.id} has no oracle file.`);
  if (oracle !== undefined && (task.oracleArgv.length !== 1 || task.oracleArgv[0] !== oracle))
    errors.push(`${task.id} must execute only its oracle: ${task.oraclePath}.`);
  return errors;
}

/** Validate frozen task-bank structure before any evaluator material is written to disk. */
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
    if (task.acceptanceCases.length === 0)
      errors.push(`${task.id} has no independently stated cases.`);
    errors.push(...taskPathErrors(task));
  }
  for (const [family, tasks] of families) {
    if (tasks.length !== 2 || tasks.filter((task) => task.heldOut).length !== 1)
      errors.push(`${family} needs one tuning task and one held-out task.`);
  }
  return errors;
}

export type TaskControl = 'buggy' | 'repaired' | 'empty';

/** Materialize one frozen snapshot without ever allowing a control to replace its oracle. */
export function materializeTask(
  task: TaskSnapshot,
  directory: string,
  control: TaskControl,
): string {
  const errors = taskPathErrors(task);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  const root = resolve(directory, task.id, control);
  for (const [path, contents] of Object.entries(task.files)) {
    const output = resolve(root, path);
    if (relative(root, output).startsWith('..')) throw new Error(`${task.id} escaped its root.`);
    mkdirSync(resolve(output, '..'), { recursive: true });
    writeFileSync(output, contents);
  }
  const replacements =
    control === 'repaired'
      ? task.repairedFiles
      : control === 'empty'
        ? Object.fromEntries(task.permittedPaths.map((path) => [path, '']))
        : {};
  for (const [path, contents] of Object.entries(replacements))
    writeFileSync(resolve(root, path), contents);
  return root;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] !== 'verify-task-bank' || argv.length !== 2) return 2;
  const path = argv[1] ?? '';
  if (!existsSync(path)) return 2;
  let bank: TaskBank;
  try {
    bank = JSON.parse(readFileSync(path, 'utf8')) as TaskBank;
  } catch {
    return 2;
  }
  const errors = verifyTaskBank(bank);
  errors.push(...verifyTaskBankProvenance(bank));
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
