/**
 * `history`: read-only inspection of the append-only evaluation history.
 *
 *   bun run --cwd testing/evaluation history list [--store <path>]
 *   bun run --cwd testing/evaluation history show <recordId> [--store <path>]
 *   bun run --cwd testing/evaluation history compare <baselineId> <candidateId> [--store <path>]
 *
 * Output on stdout is JSON: one line per record for `list`, one document for
 * `show` and `compare`. `list` shows every kind of record the history keeps
 * (evaluation runs, gate decisions, gate overrides, and promotion signals);
 * `compare` takes two evaluation runs. Diagnostics go to stderr, and the exit
 * code is the authoritative result: 0 success, 64 a usage error, an unknown
 * record, or a comparison of something other than two evaluation runs, 65 a
 * corrupt record. The command never writes a record, and a store file that
 * does not exist yet reads as an empty history rather than being created.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  BunSQLiteStorage,
  type ConditionalTextValueStore,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/weft';

import type { EvaluationRunRecord } from '../src/evaluation-run';
import {
  compareEvaluationRuns,
  CorruptHistoricalRecordError,
  createEvaluationHistory,
  type EvaluationHistory,
  type HistoricalRecord,
} from '../src/history';

export const EXIT_SUCCESS = 0;
/** `EX_USAGE`: bad arguments, or a record id the history does not contain. */
export const EXIT_USAGE = 64;
/** `EX_DATAERR`: a stored record failed verification. */
export const EXIT_CORRUPT_RECORD = 65;

/** The package's own history file. `.cache/` is ignored by the repository root. */
export const DEFAULT_HISTORY_STORE = join(
  import.meta.dir,
  '..',
  '.cache',
  'evaluation-history.sqlite',
);

const USAGE = `Usage: bun run --cwd testing/evaluation history <command> [--store <path>]

Commands:
  list                                 Print one JSON line per record, oldest first.
  show <recordId>                      Print one record and its digest as JSON.
  compare <baselineId> <candidateId>   Print per-criterion deltas between two runs as JSON.

Options:
  --store <path>   The SQLite history file (default: testing/evaluation/.cache/evaluation-history.sqlite).

Exit codes: 0 success, 64 usage error, unknown record, or a record that is not an
evaluation run given to compare, 65 corrupt record.
`;

interface Writable {
  write(text: string): unknown;
}

export interface HistoryCommandOutput {
  readonly stdout: Writable;
  readonly stderr: Writable;
}

type Invocation = { readonly store: string } & (
  | { readonly command: 'list' }
  | { readonly command: 'show'; readonly id: string }
  | { readonly command: 'compare'; readonly baselineId: string; readonly candidateId: string }
);

/** Parses `argv` into an invocation, or returns what is wrong with it. */
function parseInvocation(argv: readonly string[]): Invocation | string {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { store: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return (error as Error).message;
  }
  const store = parsed.values.store ?? DEFAULT_HISTORY_STORE;
  const [command, ...operands] = parsed.positionals;
  if (command === 'list' && operands.length === 0) return { command, store };
  if (command === 'show' && operands.length === 1) return { command, id: operands[0]!, store };
  if (command === 'compare' && operands.length === 2) {
    return { command, baselineId: operands[0]!, candidateId: operands[1]!, store };
  }
  return command === undefined
    ? 'Missing a command.'
    : `"${command}" with ${operands.length} operand(s) is not a history command.`;
}

function openStore(path: string): ConditionalTextValueStore {
  // Inspection never creates a store: one that does not exist is an empty history.
  return textValueStore(existsSync(path) ? new BunSQLiteStorage(path) : new MemoryStorage());
}

/** The one-line summary `list` prints for a record. */
function summarize({ digest, record }: HistoricalRecord): Record<string, unknown> {
  const common = { id: record.id, kind: record.kind, recordedAt: record.recordedAt, digest };
  switch (record.kind) {
    case 'evaluation-run':
      return {
        ...common,
        evaluator: record.evaluator,
        dataset: record.dataset,
        codeRevision: record.codeRevision,
        outcomes: record.outcomes,
        passFraction: record.statistics.verdicts.passFraction,
      };
    case 'gate-decision':
      return {
        ...common,
        gateId: record.gateId,
        decision: record.decision,
        actor: record.actor,
        evaluator: record.candidate.evaluator,
        dataset: record.candidate.dataset,
        codeRevision: record.candidate.codeRevision,
      };
    case 'gate-override':
      return {
        ...common,
        gateId: record.gateId,
        gateDecisionId: record.gateDecisionId,
        actor: record.actor,
        expiresAt: record.expiresAt ?? null,
        permanentBaselineChange: record.permanentBaselineChange,
      };
    case 'promotion-signal':
      return {
        ...common,
        gateDecisionRecordId: record.signal.gateDecisionRecordId,
        actor: record.signal.actor,
        package: record.signal.package,
        sourceRevision: record.signal.sourceRevision,
        expiresAt: record.signal.expiresAt,
      };
  }
}

function isEvaluationRun(
  historical: HistoricalRecord,
): historical is HistoricalRecord<EvaluationRunRecord> {
  return historical.record.kind === 'evaluation-run';
}

async function execute(
  invocation: Invocation,
  history: EvaluationHistory,
  output: HistoryCommandOutput,
): Promise<number> {
  const unknown = (id: string): number => {
    output.stderr.write(`No historical record "${id}" in ${invocation.store}\n`);
    return EXIT_USAGE;
  };
  const notARun = ({ record }: HistoricalRecord): number => {
    output.stderr.write(
      `Historical record "${record.id}" is a ${record.kind} record; compare takes two evaluation runs\n`,
    );
    return EXIT_USAGE;
  };
  switch (invocation.command) {
    case 'list':
      for (const historical of await history.list()) {
        output.stdout.write(`${JSON.stringify(summarize(historical))}\n`);
      }
      return EXIT_SUCCESS;
    case 'show': {
      const historical = await history.read(invocation.id);
      if (historical === undefined) return unknown(invocation.id);
      output.stdout.write(`${JSON.stringify(historical, null, 2)}\n`);
      return EXIT_SUCCESS;
    }
    case 'compare': {
      const baseline = await history.read(invocation.baselineId);
      if (baseline === undefined) return unknown(invocation.baselineId);
      const candidate = await history.read(invocation.candidateId);
      if (candidate === undefined) return unknown(invocation.candidateId);
      if (!isEvaluationRun(baseline)) return notARun(baseline);
      if (!isEvaluationRun(candidate)) return notARun(candidate);
      output.stdout.write(
        `${JSON.stringify(compareEvaluationRuns(baseline, candidate), null, 2)}\n`,
      );
      return EXIT_SUCCESS;
    }
  }
}

/** Runs one `history` invocation and resolves with its exit code. */
export async function runHistoryCommand(
  argv: readonly string[],
  output: HistoryCommandOutput = process,
): Promise<number> {
  const invocation = parseInvocation(argv);
  if (typeof invocation === 'string') {
    output.stderr.write(`${invocation}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  const store = openStore(invocation.store);
  try {
    return await execute(invocation, createEvaluationHistory(store), output);
  } catch (error) {
    if (!(error instanceof CorruptHistoricalRecordError)) throw error;
    output.stderr.write(`${error.message}\n`);
    return EXIT_CORRUPT_RECORD;
  } finally {
    await store.close();
  }
}

if (import.meta.main) process.exitCode = await runHistoryCommand(Bun.argv.slice(2));
