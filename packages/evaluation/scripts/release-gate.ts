/**
 * `release-gate`: the local release gate. There is no hosted CI; a person or
 * an agent runs this and reads `$?`.
 *
 *   bun run --cwd packages/evaluation release-gate [--gate <gateId>] [--gates-dir <path>]
 *                                                  [--store <path>] [--actor <principal>]
 *   bun run --filter=@lostgradient/evaluation release-gate
 *
 * Without `--gate` it runs every gate in the gates directory. Stdout is
 * exactly one JSON document, a `release-gate-report`; every human diagnostic
 * goes to stderr. The machine-readable contract is the `--cwd` form: the
 * `--filter` form exits with the same code but prefixes each stdout line.
 *
 * Exit codes: 0 pass, 1 regression, 2 evaluator infrastructure failure, 3
 * insufficient evidence, 64 invalid gate configuration or usage. Several
 * gates exit with the most severe: 64 > 2 > 3 > 1 > 0. A failure of the gate
 * machinery itself, such as an unwritable history store, is an
 * infrastructure failure: it never looks like a pass or a regression.
 *
 * Each decision records the commit checked out when the gate ran (`git
 * rev-parse HEAD`), the only revision a promotion signal can be issued for.
 */
import { mkdir, readdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  BunSQLiteStorage,
  type ConditionalTextValueStore,
  textValueStore,
} from '@lostgradient/weft';

import { describeThresholdBound } from '../src/gate';
import { createEvaluationHistory } from '../src/history';
import {
  type GateReport,
  type GateRunResult,
  mostSevere,
  RELEASE_GATE_EXIT_CODES,
  type ReleaseGateReport,
  runReleaseGate,
  type RunReleaseGateOptions,
  toReleaseGateReport,
} from '../src/release-gate';
import { DEFAULT_HISTORY_STORE } from './history';

/** The committed gates, `packages/evaluation/gates/<gateId>.json`. */
export const DEFAULT_GATES_DIRECTORY = join(import.meta.dir, '..', 'gates');

const USAGE = `Usage: bun run --cwd packages/evaluation release-gate [options]

Runs every gate in the gates directory, or only --gate, and prints one JSON report.

Options:
  --gate <gateId>       Run only gates/<gateId>.json.
  --gates-dir <path>    The gates directory (default: packages/evaluation/gates).
  --store <path>        The SQLite history file (default: packages/evaluation/.cache/evaluation-history.sqlite).
  --actor <principal>   Who is running the gate (default: the current user).

Exit codes: 0 pass, 1 regression, 2 evaluator infrastructure failure,
3 insufficient evidence, 64 invalid gate configuration or usage.
`;

interface Writable {
  write(text: string): unknown;
}

export interface CommandOutput {
  readonly stdout: Writable;
  readonly stderr: Writable;
}

export interface ReleaseGateCommandOptions extends Pick<
  RunReleaseGateOptions,
  'now' | 'runtime' | 'createId' | 'loadEvaluator' | 'revisionDistance' | 'sourceRevision'
> {
  readonly output?: CommandOutput | undefined;
}

interface Invocation {
  readonly gate: string | undefined;
  readonly gatesDirectory: string;
  readonly store: string;
  readonly actor: string;
}

/**
 * Commits from `from` to `to` in the repository at `cwd`, or `undefined`
 * when git cannot tell (an unknown revision, or no repository).
 */
export function gitRevisionDistance(
  from: string,
  to: string,
  cwd: string = import.meta.dir,
): number | undefined {
  const child = Bun.spawnSync(['git', 'rev-list', '--count', `${from}..${to}`], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const count = Number(child.stdout.toString().trim());
  return child.exitCode === 0 && Number.isInteger(count) ? count : undefined;
}

/**
 * The commit checked out in the repository at `cwd` (`git rev-parse HEAD`),
 * or `undefined` when there is none (no repository, or no commit yet).
 */
export function gitHeadRevision(cwd: string = import.meta.dir): string | undefined {
  const child = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', 'HEAD'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return child.exitCode === 0 ? child.stdout.toString().trim() : undefined;
}

function parseInvocation(argv: readonly string[]): Invocation | string {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        gate: { type: 'string' },
        'gates-dir': { type: 'string' },
        store: { type: 'string' },
        actor: { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    return (error as Error).message;
  }
  const { values } = parsed;
  const actor = values.actor ?? userInfo().username;
  if (actor.length === 0) return 'The --actor principal is empty.';
  return {
    gate: values.gate,
    gatesDirectory: values['gates-dir'] ?? DEFAULT_GATES_DIRECTORY,
    store: values.store ?? DEFAULT_HISTORY_STORE,
    actor,
  };
}

/** The gate ids to run: `--gate`, or every `*.json` file in the gates directory, sorted. */
async function gateIds(invocation: Invocation): Promise<string[] | string> {
  if (invocation.gate !== undefined) return [invocation.gate];
  let names: string[];
  try {
    names = await readdir(invocation.gatesDirectory);
  } catch (error) {
    return `Cannot read the gates directory: ${(error as Error).message}`;
  }
  const ids = names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .toSorted();
  return ids.length > 0 ? ids : `No gate files in ${invocation.gatesDirectory}`;
}

function describeGate(gate: GateReport): string[] {
  const lines = [`${gate.gateId}: ${gate.decision} (exit ${gate.exitCode})`];
  if (gate.decision === 'configuration-error') {
    return [...lines, ...gate.issues.map((issue) => `  ${issue}`)];
  }
  lines[0] += `, recorded ${gate.recordId}`;
  const { baseline, findings } = gate;
  if (baseline !== null) {
    const { source } = baseline;
    const cited = source.kind === 'evaluation-run' ? source.path : source.recordId;
    lines.push(`  baseline: ${source.kind} ${cited}, recorded ${baseline.recordedAt}`);
  }
  for (const failure of findings.infrastructureFailures) {
    lines.push(`  infrastructure failure (${failure.reason}): ${failure.detail}`);
  }
  for (const finding of findings.insufficientEvidence) {
    lines.push(`  insufficient evidence (${finding.reason}): ${finding.detail}`);
  }
  for (const regression of findings.regressions) {
    const cleared =
      regression.overriddenBy === null ? '' : `, overridden by ${regression.overriddenBy}`;
    lines.push(
      `  regression: ${regression.criterion} ${regression.metric} ${regression.baseline} -> ${regression.candidate} (${regression.severity}, ${describeThresholdBound(regression)}${cleared})`,
    );
  }
  for (const rejected of gate.rejectedOverrides) {
    lines.push(
      `  override rejected: ${rejected.id} for ${rejected.criterion} ${rejected.metric} (${rejected.reason})`,
    );
  }
  return lines;
}

function print(report: ReleaseGateReport, output: CommandOutput): number {
  output.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const lines = report.gates.flatMap(describeGate);
  lines.push(`release gate: ${report.decision} (exit ${report.exitCode})`);
  output.stderr.write(`${lines.join('\n')}\n`);
  return report.exitCode;
}

/** A usage error: the problem and usage on stderr, and a report of no gates (exit 64) on stdout. */
function usageError(problem: string, output: CommandOutput): number {
  output.stderr.write(`${problem}\n\n${USAGE}`);
  return print(toReleaseGateReport([]), output);
}

/** Runs one `release-gate` invocation and resolves with its exit code. */
export async function runReleaseGateCommand(
  argv: readonly string[],
  options: ReleaseGateCommandOptions = {},
): Promise<number> {
  const { output = process, ...gateOptions } = options;
  const invocation = parseInvocation(argv);
  if (typeof invocation === 'string') return usageError(invocation, output);
  const ids = await gateIds(invocation);
  if (typeof ids === 'string') return usageError(ids, output);
  const results: GateRunResult[] = [];
  let store: ConditionalTextValueStore | undefined;
  try {
    await mkdir(dirname(invocation.store), { recursive: true });
    store = textValueStore(new BunSQLiteStorage(invocation.store));
    const history = createEvaluationHistory(store);
    const sourceRevision = gitHeadRevision();
    for (const gateId of ids) {
      results.push(
        await runReleaseGate({
          revisionDistance: gitRevisionDistance,
          sourceRevision,
          ...gateOptions,
          gatesDirectory: invocation.gatesDirectory,
          gateId,
          history,
          actor: invocation.actor,
        }),
      );
    }
  } catch (error) {
    output.stderr.write(`The release gate itself failed: ${(error as Error).message}\n`);
    const partial = toReleaseGateReport(results);
    const decision = mostSevere([
      ...partial.gates.map((gate) => gate.decision),
      'infrastructure-failure',
    ]);
    return print(
      { ...partial, recordId: null, decision, exitCode: RELEASE_GATE_EXIT_CODES[decision] },
      output,
    );
  } finally {
    await store?.close();
  }
  return print(toReleaseGateReport(results), output);
}

if (import.meta.main) process.exitCode = await runReleaseGateCommand(Bun.argv.slice(2));
