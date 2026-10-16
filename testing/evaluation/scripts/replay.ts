/**
 * `replay`: recompute a stored release-gate decision from its recorded
 * evidence, without calling a model.
 *
 *   bun run --cwd testing/evaluation replay <gateDecisionRecordId> [--store <path>]
 *   bun run --cwd testing/evaluation replay --gate <gateId> --latest [--store <path>]
 *   bun run --filter=@lostgradient/evaluation replay -- --gate <gateId> --latest
 *
 * Stdout is exactly one JSON document, a `replay-report`; on a mismatch it
 * lists every differing field, and stderr names the first. Exit codes: 0 the
 * recomputed decision and digest equal the stored ones, 4 they do not, 3 the
 * recorded evaluator configuration digest or dataset version cannot be
 * resolved, 64 an unknown record or a usage error, 65 a corrupt record. The
 * command never writes, and a store file that does not exist reads as an
 * empty history rather than being created.
 *
 * It replays evaluation decisions only. Replaying a lifecycle fault stays
 * with operative's `replayReproductionArtifact`.
 */
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { BunSQLiteStorage, MemoryStorage, textValueStore } from '@lostgradient/weft';

import { createEvaluationHistory } from '../src/history';
import type { GateEvaluatorLoader } from '../src/release-gate';
import {
  REPLAY_EXIT_CODES,
  replayGateDecision,
  type ReplayOutcome,
  type ReplaySelector,
} from '../src/replay';
import { DEFAULT_HISTORY_STORE } from './history';
import type { CommandOutput } from './release-gate';

/** `EX_USAGE`, shared with an unknown record. */
const EXIT_USAGE = 64;

const USAGE = `Usage: bun run --cwd testing/evaluation replay <gateDecisionRecordId> [--store <path>]
       bun run --cwd testing/evaluation replay --gate <gateId> --latest [--store <path>]

Recomputes a stored gate decision from its recorded evidence without calling a model.

Options:
  --gate <gateId>   With --latest, replay the newest decision of this gate.
  --latest          Select the newest decision of --gate.
  --store <path>    The SQLite history file (default: testing/evaluation/.cache/evaluation-history.sqlite).

Exit codes: 0 match, 4 mismatch, 3 unresolvable evaluator or dataset,
64 unknown record or usage error, 65 corrupt record.
`;

export interface ReplayCommandOptions {
  readonly output?: CommandOutput | undefined;
  readonly loadEvaluator?: GateEvaluatorLoader | undefined;
}

function parseInvocation(
  argv: readonly string[],
): { readonly selector: ReplaySelector; readonly store: string } | string {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        gate: { type: 'string' },
        latest: { type: 'boolean' },
        store: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return (error as Error).message;
  }
  const { values, positionals } = parsed;
  const store = values.store ?? DEFAULT_HISTORY_STORE;
  if (values.gate === undefined && values.latest === undefined && positionals.length === 1) {
    return { selector: { recordId: positionals[0]! }, store };
  }
  if (values.gate !== undefined && values.latest === true && positionals.length === 0) {
    return { selector: { gateId: values.gate }, store };
  }
  return 'Name one gate decision record id, or --gate <gateId> --latest.';
}

function describe(outcome: ReplayOutcome): string {
  switch (outcome.result) {
    case 'match':
      return `Replay of "${outcome.recordId}" matches: ${outcome.decision}, digest ${outcome.digest}`;
    case 'mismatch': {
      const [first] = outcome.differences;
      return `Replay of "${outcome.recordId}" does not match its stored decision; first mismatching field "${first!.path}": stored ${JSON.stringify(first!.stored)}, recomputed ${JSON.stringify(first!.recomputed)}`;
    }
    default:
      return outcome.problem;
  }
}

/** Runs one `replay` invocation and resolves with its exit code. */
export async function runReplayCommand(
  argv: readonly string[],
  options: ReplayCommandOptions = {},
): Promise<number> {
  const { output = process } = options;
  const invocation = parseInvocation(argv);
  if (typeof invocation === 'string') {
    output.stdout.write(
      `${JSON.stringify({ kind: 'replay-report', schemaVersion: 1, result: 'usage-error', problem: invocation }, null, 2)}\n`,
    );
    output.stderr.write(`${invocation}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  // Replay never creates a store: one that does not exist is an empty history.
  const store = textValueStore(
    existsSync(invocation.store) ? new BunSQLiteStorage(invocation.store) : new MemoryStorage(),
  );
  try {
    const outcome = await replayGateDecision(invocation.selector, {
      history: createEvaluationHistory(store),
      loadEvaluator: options.loadEvaluator,
    });
    output.stdout.write(
      `${JSON.stringify({ kind: 'replay-report', schemaVersion: 1, ...outcome }, null, 2)}\n`,
    );
    output.stderr.write(`${describe(outcome)}\n`);
    return REPLAY_EXIT_CODES[outcome.result];
  } finally {
    await store.close();
  }
}

if (import.meta.main) process.exitCode = await runReplayCommand(Bun.argv.slice(2));
