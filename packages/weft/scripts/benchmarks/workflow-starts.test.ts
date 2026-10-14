import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { isConstrainedCodexRunner } from './benchmark-environment.ts';
import { isCoverageInstrumentationEnabled } from './coverage-mode.ts';
import {
  buildMeasuredWorkflowArgument,
  buildWarmupWorkflowArgument,
  type WorkflowStartAdmissionMeasurement,
} from './workflow-starts-runner.ts';

/**
 * K2a: Workflow start admission throughput benchmark.
 *
 * Measures aggregate durable-admission throughput for trivial workflows
 * against the real architecture target using a fresh Bun subprocess.
 *
 * Admissions are counted per second of the child's main-thread CPU time rather than per
 * wall-clock second (`main-thread-cpu.ts`), so other work on the host does not stretch the
 * denominator; the wall-clock rate is still reported, but not asserted.
 *
 * The timer stops after `engine.start()` admissions resolve, before awaiting
 * workflow completion, because this gate is intentionally about the start hot
 * path rather than end-to-end workflow runtime. Coverage instrumentation from
 * `bun test --coverage` does not propagate into `bun run`, so the child
 * measurement path itself is not directly instrumented.
 *
 * It is still parent-process contention sensitive: `packages/weft/scripts/check-coverage.ts`
 * runs the entire suite — all ~11.5K tests across ~780 files, this one included — as one
 * `bun test --coverage` invocation, and Bun's coverage workers for the other 779 files
 * compete for CPU with this benchmark's `bun run` child while it measures. A COR
 * coverage-gate-adoption run observed 31,585/sec against the 50,000/sec baseline target under
 * that contention (single sample; not re-measured in isolation), the same class of effect
 * `activity-completions.test.ts` and `token-stream-latency.test.ts` already document and gate
 * with a lower coverage-mode floor via `isCoverageInstrumentationEnabled()`. This benchmark
 * predates that pattern and lacked it; the floor below is a conservative margin under the one
 * observed sample and should be tightened once more coverage-mode runs establish a real
 * low-water mark, the way `activity-completions.test.ts`'s target was calibrated.
 */

const IS_CONSTRAINED_CODEX_RUNNER = isConstrainedCodexRunner();
const BASELINE_TARGET_ADMISSIONS_PER_SECOND = IS_CONSTRAINED_CODEX_RUNNER ? 1_000 : 50_000;
const COVERAGE_TARGET_ADMISSIONS_PER_SECOND = IS_CONSTRAINED_CODEX_RUNNER ? 1_000 : 20_000;

function getTargetAdmissionsPerSecond(): number {
  return isCoverageInstrumentationEnabled()
    ? COVERAGE_TARGET_ADMISSIONS_PER_SECOND
    : BASELINE_TARGET_ADMISSIONS_PER_SECOND;
}

const ARCHITECTURE_TARGET_ADMISSIONS_PER_SECOND = getTargetAdmissionsPerSecond();
const TOTAL_STARTS = 10_000;
const START_BATCH_SIZE = 100;
const WARMUP_STARTS = 50;
const TRIAL_COUNT = 3;
const runArchitectureBenchmark = it;
const BENCHMARK_ENVIRONMENT_KEYS = [
  'HOME',
  'NODE_OPTIONS',
  'NODE_V8_COVERAGE',
  'PATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
] as const;
const workflowStartsRunnerPath = fileURLToPath(
  new URL('./workflow-starts-runner.ts', import.meta.url),
);

function isWorkflowStartAdmissionMeasurement(
  value: unknown,
): value is WorkflowStartAdmissionMeasurement {
  if (!isRecord(value)) {
    return false;
  }

  const candidate = value;
  return (
    hasPositiveInteger(candidate['batchSize']) &&
    hasNonNegativeInteger(candidate['warmupStarts']) &&
    hasPositiveInteger(candidate['measuredStarts']) &&
    hasPositiveFiniteNumber(candidate['admissionsPerSecond']) &&
    hasPositiveFiniteNumber(candidate['wallClockAdmissionsPerSecond'])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function hasPositiveInteger(value: unknown): value is number {
  return hasNonNegativeInteger(value) && value > 0;
}

function hasPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function runWorkflowStartAdmissionBenchmark(): WorkflowStartAdmissionMeasurement {
  const environment: Record<string, string> = {};
  for (const key of BENCHMARK_ENVIRONMENT_KEYS) {
    const globals = globalThis as typeof globalThis & {
      Bun?: { env?: Record<string, string | undefined> };
      process?: { env?: Record<string, string | undefined> };
    };
    const value = (globals.Bun?.env ?? globals.process?.env)?.[key];
    if (typeof value === 'string') {
      environment[key] = value;
    }
  }

  const result = Bun.spawnSync(
    [
      process.execPath,
      'run',
      workflowStartsRunnerPath,
      String(TOTAL_STARTS),
      String(START_BATCH_SIZE),
      String(WARMUP_STARTS),
    ],
    {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: environment,
    },
  );

  if (result.exitCode !== 0) {
    const errorOutput = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`Workflow start benchmark subprocess failed: ${errorOutput}`);
  }

  const stdoutText = new TextDecoder().decode(result.stdout);
  const lastNonEmptyOutputLine = stdoutText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (!lastNonEmptyOutputLine) {
    throw new Error('Workflow start benchmark subprocess did not emit a measurement payload');
  }

  const parsed = JSON.parse(lastNonEmptyOutputLine) as unknown;
  if (!isWorkflowStartAdmissionMeasurement(parsed)) {
    throw new Error('Workflow start benchmark subprocess returned an invalid measurement payload');
  }

  return parsed;
}

function medianMeasurement(
  measurements: WorkflowStartAdmissionMeasurement[],
): WorkflowStartAdmissionMeasurement {
  const sortedMeasurements = measurements.toSorted(
    (left, right) => left.admissionsPerSecond - right.admissionsPerSecond,
  );
  const median = sortedMeasurements[Math.floor(sortedMeasurements.length / 2)];

  if (median === undefined) {
    throw new Error('Workflow start benchmark produced no measurements');
  }

  return median;
}

describe('Workflow start admission throughput', () => {
  it('uses distinct workflow arguments for warmup and measured starts', () => {
    const warmupArguments = Array.from({ length: WARMUP_STARTS }, (_, index) =>
      buildWarmupWorkflowArgument(index),
    );
    const measuredArguments = Array.from({ length: START_BATCH_SIZE }, (_, index) =>
      buildMeasuredWorkflowArgument(index),
    );
    const warmupArgumentSet = new Set(warmupArguments);

    for (const measuredArgument of measuredArguments) {
      expect(warmupArgumentSet.has(measuredArgument)).toBeFalse();
    }
  });

  it('records workflow-start throughput in a non-gating smoke benchmark', async () => {
    const measurement = runWorkflowStartAdmissionBenchmark();

    console.log(
      [
        `\n  Workflow start admission throughput smoke benchmark:`,
        `    Total starts:    ${measurement.measuredStarts.toLocaleString()}`,
        `    Start batch size:${measurement.batchSize.toLocaleString()}`,
        `    Warmup starts:   ${measurement.warmupStarts.toLocaleString()}`,
        `    Admissions:      ${measurement.admissionsPerSecond.toLocaleString()}/sec of main-thread CPU`,
        `    Wall clock:      ${measurement.wallClockAdmissionsPerSecond.toLocaleString()}/sec (not asserted)`,
        `    Spec target:     ${ARCHITECTURE_TARGET_ADMISSIONS_PER_SECOND.toLocaleString()}`,
        `    Child coverage:  no (Bun does not cover \`bun run\` subprocesses)\n`,
      ].join('\n'),
    );

    expect(measurement.admissionsPerSecond).toBeGreaterThan(0);
  }, 120_000);

  runArchitectureBenchmark(
    `median admissions exceed ${ARCHITECTURE_TARGET_ADMISSIONS_PER_SECOND.toLocaleString()} workflows/sec`,
    async () => {
      const measurements = Array.from({ length: TRIAL_COUNT }, () =>
        runWorkflowStartAdmissionBenchmark(),
      );
      const measurement = medianMeasurement(measurements);

      console.log(
        [
          `\n  Workflow start admission throughput architecture benchmark:`,
          `    Samples:         ${measurements
            .map((sample) => sample.admissionsPerSecond.toLocaleString())
            .join(', ')}`,
          `    Total starts:    ${measurement.measuredStarts.toLocaleString()}`,
          `    Start batch size:${measurement.batchSize.toLocaleString()}`,
          `    Warmup starts:   ${measurement.warmupStarts.toLocaleString()}`,
          `    Median:          ${measurement.admissionsPerSecond.toLocaleString()}/sec of main-thread CPU`,
          `    Wall clock:      ${measurements
            .map((sample) => sample.wallClockAdmissionsPerSecond.toLocaleString())
            .join(', ')} (not asserted)`,
          `    Spec target:     ${ARCHITECTURE_TARGET_ADMISSIONS_PER_SECOND.toLocaleString()}`,
          `    Child coverage:  no (Bun does not cover \`bun run\` subprocesses)\n`,
        ].join('\n'),
      );

      expect(measurement.admissionsPerSecond).toBeGreaterThanOrEqual(
        ARCHITECTURE_TARGET_ADMISSIONS_PER_SECOND,
      );
    },
    120_000,
  );
});
