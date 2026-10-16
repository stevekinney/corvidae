/**
 * `memory-lifecycle`: the versioned memory-lifecycle evaluation command
 * (COR-755).
 *
 *   bun run --cwd testing/evaluation memory-lifecycle run [--lane deterministic|stochastic]
 *       [--seed <label>] [--artifacts-dir <path>] [--report <path.md>] [--suite <path>]
 *   bun run --cwd testing/evaluation memory-lifecycle replay <artifact.json> [--suite <path>]
 *   bun run --cwd testing/evaluation memory-lifecycle baseline [--write]
 *
 * `run` runs the committed suite against all four baselines in one lane,
 * and the lifecycle architecture without each of its structured components
 * over that component's target scenarios, writes one replay artifact per
 * trial, applies the committed
 * `gates/memory-lifecycle.json` policy to the lifecycle architecture and the
 * best simpler baseline of that same run, and prints the report as one JSON
 * document. `$?` is the release decision, with the release gate's codes: 0
 * pass, 1 regression, 2 infrastructure failure, 3 insufficient evidence, 64
 * invalid configuration or usage.
 *
 * `replay` replays one artifact without a model and prints the outcome: 0
 * match, 4 mismatch, 3 unresolvable suite, baseline, or envelope, 64 usage
 * error or missing file, 65 corrupt artifact.
 *
 * `baseline` regenerates the best simpler baseline's evaluation-run record
 * the gate compares with: 0 when the committed record is current (or, with
 * `--write`, once it is written), 1 when it is stale.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import type { EvaluatorConfigurationError } from '../src/configuration';
import { canonicalJson } from '../src/identity';
import {
  MEMORY_LIFECYCLE_REPLAY_EXIT_CODES,
  replayScenarioArtifact,
  type ArtifactReplayOutcome,
} from '../src/memory-lifecycle/artifact';
import { MEMORY_LIFECYCLE_LANES, type MemoryLifecycleLane } from '../src/memory-lifecycle/envelope';
import {
  BEST_SIMPLER_BASELINE_PATH,
  bestSimplerBaselineRecord,
  decideMemoryLifecycleRelease,
} from '../src/memory-lifecycle/release';
import { buildMemoryLifecycleReport } from '../src/memory-lifecycle/report';
import { renderMemoryLifecycleReport } from '../src/memory-lifecycle/report-markdown';
import type { MemoryScenarioSuite } from '../src/memory-lifecycle/scenarios';
import { memoryLifecycleSuite, parseMemoryScenarioSuite } from '../src/memory-lifecycle/suite';
import { runMemoryLifecycleSuite } from '../src/memory-lifecycle/suite-run';
import { differencesBetween } from '../src/replay';
import type { CommandOutput } from './release-gate';

/** `EX_USAGE`. */
const EXIT_USAGE = 64;
const EXIT_STALE = 1;

/** Where `run` writes artifacts unless told otherwise; the repository ignores `.cache/`. */
export const DEFAULT_ARTIFACTS_DIRECTORY = join(
  import.meta.dir,
  '..',
  '.cache',
  'memory-lifecycle',
);

const USAGE = `Usage: bun run --cwd testing/evaluation memory-lifecycle run [options]
       bun run --cwd testing/evaluation memory-lifecycle replay <artifact.json>
       bun run --cwd testing/evaluation memory-lifecycle baseline [--write]

run options:
  --lane <lane>           deterministic (default) or stochastic.
  --suite <path>          A scenario suite file (default: the committed suite). replay takes it too.
  --seed <label>          Seeds every scenario's trials (default: memory-lifecycle/<lane>).
  --artifacts-dir <path>  Where each trial's artifact is written
                          (default: testing/evaluation/.cache/memory-lifecycle/<lane>).
  --report <path>         Also write the Markdown report here.

Exit codes: run: 0 pass, 1 regression, 2 infrastructure failure, 3 insufficient evidence,
64 configuration or usage error; replay: 0 match, 4 mismatch, 3 unresolvable, 64 usage,
65 corrupt artifact; baseline: 0 current or written, 1 stale.
`;

export interface MemoryLifecycleCommandOptions {
  readonly output?: CommandOutput | undefined;
  /** Where `baseline` reads and writes the committed record. Defaults to the gate's. */
  readonly baselinePath?: string | undefined;
}

function print(output: CommandOutput, document: unknown): void {
  output.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}

function usageError(output: CommandOutput, problem: string): number {
  print(output, { kind: 'memory-lifecycle-usage-error', schemaVersion: 1, problem });
  output.stderr.write(`${problem}\n\n${USAGE}`);
  return EXIT_USAGE;
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: {
      lane: { type: 'string' },
      seed: { type: 'string' },
      'artifacts-dir': { type: 'string' },
      report: { type: 'string' },
      suite: { type: 'string' },
      write: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
}

type Invocation = ReturnType<typeof parse>;

/**
 * The suite `--suite` names, or the committed one, or the exit code of why it
 * cannot be used: a missing or non-JSON file is a usage error, a suite that
 * does not validate a configuration error.
 */
async function resolveSuite(
  path: string | undefined,
  output: CommandOutput,
): Promise<MemoryScenarioSuite | number> {
  if (path === undefined) return memoryLifecycleSuite();
  let input: unknown;
  try {
    input = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return usageError(output, `No JSON suite at ${path}`);
  }
  try {
    return parseMemoryScenarioSuite(input);
  } catch (error) {
    const { issues, message } = error as EvaluatorConfigurationError;
    print(output, { kind: 'memory-lifecycle-configuration-error', schemaVersion: 1, issues });
    output.stderr.write(`${message}\n`);
    return EXIT_USAGE;
  }
}

async function runSuite(invocation: Invocation, output: CommandOutput): Promise<number> {
  const { values, positionals } = invocation;
  const lane = values.lane ?? 'deterministic';
  if (!MEMORY_LIFECYCLE_LANES.includes(lane as MemoryLifecycleLane) || positionals.length > 1) {
    return usageError(output, `run takes --lane deterministic or stochastic, not "${lane}"`);
  }
  const suite = await resolveSuite(values.suite, output);
  if (typeof suite === 'number') return suite;
  const directory = resolve(values['artifacts-dir'] ?? join(DEFAULT_ARTIFACTS_DIRECTORY, lane));
  await mkdir(directory, { recursive: true });
  const run = await runMemoryLifecycleSuite({
    lane: lane as MemoryLifecycleLane,
    suite,
    seed: values.seed,
    onArtifact: (artifact) =>
      writeFile(join(directory, `${artifact.id}.json`), `${JSON.stringify(artifact, null, 2)}\n`),
  });
  const release = await decideMemoryLifecycleRelease(run);
  const report = buildMemoryLifecycleReport(run, release);
  print(output, { ...report, artifactsDirectory: directory });
  if (values.report !== undefined) {
    await mkdir(dirname(resolve(values.report)), { recursive: true });
    await writeFile(values.report, renderMemoryLifecycleReport(report));
  }
  output.stderr.write(
    `memory-lifecycle ${lane}: ${release.decision} against ${release.baseline ?? 'no baseline'}; ${report.failures.length} failing trial(s), artifacts in ${directory}\n`,
  );
  return release.exitCode;
}

function describeReplay(outcome: ArtifactReplayOutcome): string {
  switch (outcome.result) {
    case 'match':
      return `Replay of "${outcome.artifactId}" matches, digest ${outcome.digest}`;
    case 'mismatch': {
      const [first] = outcome.differences;
      return `Replay of "${outcome.artifactId}" does not match; first mismatching field "${first?.path ?? 'digest'}"`;
    }
    default:
      return outcome.problem;
  }
}

async function replay(invocation: Invocation, output: CommandOutput): Promise<number> {
  const { positionals } = invocation;
  if (positionals.length !== 2) return usageError(output, 'replay takes one artifact path');
  let text: string;
  try {
    text = await readFile(positionals[1]!, 'utf8');
  } catch {
    return usageError(output, `No artifact at ${positionals[1]}`);
  }
  const suite = await resolveSuite(invocation.values.suite, output);
  if (typeof suite === 'number') return suite;
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    input = undefined;
  }
  const outcome: ArtifactReplayOutcome =
    input === undefined
      ? { result: 'corrupt-artifact', problem: `${positionals[1]} is not JSON` }
      : await replayScenarioArtifact(input, { suite });
  print(output, { kind: 'memory-lifecycle-replay', schemaVersion: 1, ...outcome });
  output.stderr.write(`${describeReplay(outcome)}\n`);
  return MEMORY_LIFECYCLE_REPLAY_EXIT_CODES[outcome.result];
}

async function baseline(
  invocation: Invocation,
  output: CommandOutput,
  path: string,
): Promise<number> {
  if (invocation.positionals.length !== 1) return usageError(output, 'baseline takes no arguments');
  const record = await bestSimplerBaselineRecord();
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (invocation.values.write === true) {
    await writeFile(path, text);
    print(output, {
      kind: 'memory-lifecycle-baseline',
      schemaVersion: 1,
      result: 'written',
      id: record.id,
    });
    output.stderr.write(`Wrote ${path}\n`);
    return 0;
  }
  const committed: unknown = JSON.parse(await readFile(path, 'utf8'));
  const differences = differencesBetween(
    JSON.parse(canonicalJson(committed)),
    JSON.parse(canonicalJson(record)),
  );
  const result = differences.length === 0 ? 'current' : 'stale';
  print(output, {
    kind: 'memory-lifecycle-baseline',
    schemaVersion: 1,
    result,
    id: record.id,
    differences,
  });
  output.stderr.write(
    result === 'current'
      ? `${path} is current\n`
      : `${path} is stale; regenerate it with --write\n`,
  );
  return result === 'current' ? 0 : EXIT_STALE;
}

/** Runs one `memory-lifecycle` invocation and resolves with its exit code. */
export async function runMemoryLifecycleCommand(
  argv: readonly string[],
  options: MemoryLifecycleCommandOptions = {},
): Promise<number> {
  const { output = process } = options;
  let invocation: Invocation;
  try {
    invocation = parse(argv);
  } catch (error) {
    return usageError(output, (error as Error).message);
  }
  switch (invocation.positionals[0]) {
    case 'run':
      return runSuite(invocation, output);
    case 'replay':
      return replay(invocation, output);
    case 'baseline':
      return baseline(invocation, output, options.baselinePath ?? BEST_SIMPLER_BASELINE_PATH);
    default:
      return usageError(output, 'Name a subcommand: run, replay, or baseline.');
  }
}

if (import.meta.main) process.exitCode = await runMemoryLifecycleCommand(Bun.argv.slice(2));
