import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

import { isConstrainedCodexRunner } from './benchmark-environment.ts';
import { runBenchmarkSubprocess } from './benchmark-subprocess.ts';
import { isCoverageInstrumentationEnabled } from './coverage-mode.ts';
import type { LoadGrowthMemoryMeasurement } from './load-growth-memory-runner.ts';

const IS_CONSTRAINED_CODEX_RUNNER = isConstrainedCodexRunner();
const IS_COVERAGE_INSTRUMENTATION_ENABLED = isCoverageInstrumentationEnabled();
/**
 * This load benchmark runs in every environment. Its thresholds already
 * account for constrained runners and coverage instrumentation.
 */
const runLoadGrowthBenchmark = it;
const TARGET_WORKFLOWS_PER_SECOND = IS_CONSTRAINED_CODEX_RUNNER ? 500 : 10_000;
/**
 * `TARGET_WORKFLOWS_PER_SECOND` is the *pacing* rate the runner drives load at,
 * not a pass/fail hardware spec. This benchmark's real signal is memory-footprint stability
 * under sustained load (the assertions below), so achieved throughput is logged
 * for humans but is NOT asserted as a regression gate — an absolute floor
 * conflated "this machine is fast enough" with "no memory leak" and hard-failed
 * capable developer hardware that simply runs below the pacing rate (the
 * sustained path is structurally slower than an unthrottled run because it
 * forces a GC on every memory sample).
 *
 * The one throughput-adjacent guard that remains is a *workload-completion*
 * precondition: if the run dispatched far fewer workflows than even a slow
 * machine should in the configured window, load generation itself collapsed and
 * the memory measurements are not meaningful. This invalidates the run rather than
 * silently passing on no load. The floor below is deliberately low (~25% of the
 * ideal `TARGET_WORKFLOWS_PER_SECOND` × `RUN_DURATION_MILLISECONDS` window) so
 * only a real collapse trips it, never ordinary hardware variance.
 */
/**
 * The bounds below apply to the process's physical footprint, not its resident
 * set size (see `memory-footprint.ts`). The numeric limits are unchanged from
 * when the benchmark read RSS: the JavaScriptCore allocator keeps freed heap
 * pages resident-but-clean on macOS, so RSS grew by several megabytes over the
 * run while the footprint fell, and no bound on RSS could separate that
 * allocator behavior from a leak.
 */
const MAX_MEDIAN_MEMORY_GROWTH_BYTES_PER_SECOND =
  (IS_CONSTRAINED_CODEX_RUNNER ? 16 : 1) * 1024 * 1024;
const MAX_MEDIAN_POST_WARMUP_MEMORY_PEAK_RISE_BYTES =
  (IS_CONSTRAINED_CODEX_RUNNER ? 128 : 8) * 1024 * 1024;
const MAX_MEDIAN_POST_WARMUP_MEMORY_GROWTH_BYTES = MAX_MEDIAN_POST_WARMUP_MEMORY_PEAK_RISE_BYTES;
const MAX_SINGLE_TRIAL_MEMORY_GROWTH_BYTES_PER_SECOND =
  MAX_MEDIAN_MEMORY_GROWTH_BYTES_PER_SECOND * 2;
const MAX_SINGLE_TRIAL_POST_WARMUP_MEMORY_PEAK_RISE_BYTES =
  MAX_MEDIAN_POST_WARMUP_MEMORY_PEAK_RISE_BYTES * 2;
const MAX_SINGLE_TRIAL_POST_WARMUP_MEMORY_GROWTH_BYTES =
  MAX_SINGLE_TRIAL_POST_WARMUP_MEMORY_PEAK_RISE_BYTES;
const SAMPLE_INTERVAL_MILLISECONDS = 500;
const WARMUP_SAMPLES = 4;
const WORKFLOW_BATCH_SIZE = 500;
const RUN_DURATION_MILLISECONDS = 12_000;
// Derived (not hardcoded) so it tracks both environment tiers — the constrained
// Codex runner paces at 500/sec, so its floor is 1,500, not 30,000.
const MINIMUM_TOTAL_WORKFLOWS = Math.floor(
  TARGET_WORKFLOWS_PER_SECOND * (RUN_DURATION_MILLISECONDS / 1000) * 0.25,
);
const TRIAL_COUNT = 3;
const loadGrowthMemoryRunnerPath = fileURLToPath(
  new URL('./load-growth-memory-runner.ts', import.meta.url),
);

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function hasValidSampleCounts(candidate: Record<string, unknown>): boolean {
  return (
    isNonNegativeInteger(candidate['warmupSamples']) &&
    isNonNegativeInteger(candidate['samplesCollected']) &&
    isNonNegativeInteger(candidate['samplesAnalyzed']) &&
    candidate['samplesCollected'] > candidate['warmupSamples'] &&
    candidate['samplesAnalyzed'] === candidate['samplesCollected'] - candidate['warmupSamples']
  );
}

function hasExpectedConfiguration(candidate: Record<string, unknown>): boolean {
  return (
    hasExactInteger(candidate, 'configuredDurationMilliseconds', RUN_DURATION_MILLISECONDS) &&
    hasMinimumInteger(
      candidate,
      'measuredDurationMilliseconds',
      candidate['configuredDurationMilliseconds'],
    ) &&
    hasExactInteger(candidate, 'targetWorkflowsPerSecond', TARGET_WORKFLOWS_PER_SECOND) &&
    hasExactInteger(candidate, 'sampleIntervalMilliseconds', SAMPLE_INTERVAL_MILLISECONDS) &&
    hasExactInteger(candidate, 'workflowBatchSize', WORKFLOW_BATCH_SIZE) &&
    hasExactInteger(candidate, 'warmupSamples', WARMUP_SAMPLES)
  );
}

function hasExactInteger(
  candidate: Record<string, unknown>,
  key: string,
  expected: number,
): boolean {
  return isNonNegativeInteger(candidate[key]) && candidate[key] === expected;
}

function hasMinimumInteger(
  candidate: Record<string, unknown>,
  key: string,
  minimum: unknown,
): boolean {
  return (
    isNonNegativeInteger(candidate[key]) &&
    isNonNegativeInteger(minimum) &&
    candidate[key] >= minimum
  );
}

function hasValidMeasurementSummary(candidate: Record<string, unknown>): boolean {
  return (
    hasValidSampleCounts(candidate) &&
    hasNonNegativeIntegerFields(candidate, [
      'totalWorkflows',
      'workflowsPerSecond',
      'postWarmupMemoryPeakRiseBytes',
      'peakMemoryBytes',
      'averageMemoryBytes',
    ]) &&
    hasPositiveIntegerField(candidate, 'calibratedWorkflowsPerSecond') &&
    hasKnownMemoryMeasure(candidate) &&
    hasFiniteNumberFields(candidate, ['memoryGrowthRatePerSecond', 'postWarmupMemoryGrowthBytes'])
  );
}

function hasKnownMemoryMeasure(candidate: Record<string, unknown>): boolean {
  return (
    candidate['memoryMeasure'] ===
    (process.platform === 'darwin' ? 'physical-footprint' : 'resident-set-size')
  );
}

function hasNonNegativeIntegerFields(candidate: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => isNonNegativeInteger(candidate[key]));
}

function hasPositiveIntegerField(candidate: Record<string, unknown>, key: string): boolean {
  return isNonNegativeInteger(candidate[key]) && candidate[key] > 0;
}

function hasFiniteNumberFields(candidate: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof candidate[key] === 'number' && Number.isFinite(candidate[key]));
}

function isLoadGrowthMemoryMeasurement(value: unknown): value is LoadGrowthMemoryMeasurement {
  if (!isRecord(value)) {
    return false;
  }

  return hasExpectedConfiguration(value) && hasValidMeasurementSummary(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function median(values: number[]): number {
  const sortedValues = values.toSorted((left, right) => left - right);
  const middleIndex = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 0) {
    return (sortedValues[middleIndex - 1]! + sortedValues[middleIndex]!) / 2;
  }

  return sortedValues[middleIndex]!;
}

function runLoadGrowthMemoryBenchmark(): LoadGrowthMemoryMeasurement {
  return runBenchmarkSubprocess({
    benchmarkName: 'Load-growth memory benchmark',
    runnerArguments: [String(RUN_DURATION_MILLISECONDS), String(TARGET_WORKFLOWS_PER_SECOND)],
    runnerPath: loadGrowthMemoryRunnerPath,
    validateMeasurement: isLoadGrowthMemoryMeasurement,
  });
}

describe('Load-growth memory stability', () => {
  runLoadGrowthBenchmark(
    `acceptance criterion: No unbounded growth under load. Short sustained-load regression benchmark keeps post-warmup memory footprint growth within a bounded band under load driven at ${TARGET_WORKFLOWS_PER_SECOND.toLocaleString()} workflows/sec.`,
    async () => {
      // Warm the subprocess runner once so the measured trials observe the
      // steady-state benchmark path instead of Bun's first-run transpilation and
      // process setup overhead under the full suite.
      runLoadGrowthMemoryBenchmark();

      const measurements = Array.from({ length: TRIAL_COUNT }, () =>
        runLoadGrowthMemoryBenchmark(),
      );
      const medianThroughput = median(
        measurements.map((measurement) => measurement.workflowsPerSecond),
      );
      const medianCalibratedThroughput = median(
        measurements.map((measurement) => measurement.calibratedWorkflowsPerSecond),
      );
      const medianTotalWorkflows = median(
        measurements.map((measurement) => measurement.totalWorkflows),
      );
      const medianMemoryGrowthRatePerSecond = median(
        measurements.map((measurement) => measurement.memoryGrowthRatePerSecond),
      );
      const maximumMemoryGrowthRatePerSecond = Math.max(
        ...measurements.map((measurement) => measurement.memoryGrowthRatePerSecond),
      );
      const medianPostWarmupMemoryGrowthBytes = median(
        measurements.map((measurement) => measurement.postWarmupMemoryGrowthBytes),
      );
      const medianPostWarmupMemoryPeakRiseBytes = median(
        measurements.map((measurement) => measurement.postWarmupMemoryPeakRiseBytes),
      );
      const maximumPostWarmupMemoryGrowthBytes = Math.max(
        ...measurements.map((measurement) => measurement.postWarmupMemoryGrowthBytes),
      );
      const maximumPostWarmupMemoryPeakRiseBytes = Math.max(
        ...measurements.map((measurement) => measurement.postWarmupMemoryPeakRiseBytes),
      );

      console.log(
        [
          `\n  Load-growth memory benchmark:`,
          ...measurements.map(
            (measurement, index) =>
              `    Trial ${String(index + 1).padStart(2, ' ')}: ${measurement.workflowsPerSecond.toLocaleString()} workflows/sec, ` +
              `Footprint growth rate ${measurement.memoryGrowthRatePerSecond.toFixed(0)} bytes/sec, ` +
              `Footprint growth ${measurement.postWarmupMemoryGrowthBytes.toLocaleString()} bytes, ` +
              `Footprint peak rise ${measurement.postWarmupMemoryPeakRiseBytes.toLocaleString()} bytes`,
          ),
          `    Median throughput:    ${medianThroughput.toLocaleString()} workflows/sec (logged, not gated)`,
          `    Calibrated ceiling:   ${medianCalibratedThroughput.toLocaleString()} workflows/sec (unthrottled warmup)`,
          `    Median workflows:     ${medianTotalWorkflows.toLocaleString()} (min for valid run: ${MINIMUM_TOTAL_WORKFLOWS.toLocaleString()})`,
          `    Median footprint growth rate:  ${medianMemoryGrowthRatePerSecond.toFixed(0)} bytes/sec`,
          `    Max footprint growth rate:     ${maximumMemoryGrowthRatePerSecond.toFixed(0)} bytes/sec`,
          `    Median footprint growth:  ${medianPostWarmupMemoryGrowthBytes.toLocaleString()} bytes`,
          `    Median footprint peak rise:   ${medianPostWarmupMemoryPeakRiseBytes.toLocaleString()} bytes`,
          `    Max footprint growth:     ${maximumPostWarmupMemoryGrowthBytes.toLocaleString()} bytes`,
          `    Max footprint peak rise:      ${maximumPostWarmupMemoryPeakRiseBytes.toLocaleString()} bytes`,
          `    Memory measure:    ${measurements[0]!.memoryMeasure}`,
          `    Target pacing rate:   ${TARGET_WORKFLOWS_PER_SECOND.toLocaleString()} workflows/sec`,
          `    Coverage mode:     ${IS_COVERAGE_INSTRUMENTATION_ENABLED ? 'yes' : 'no'}\n`,
        ].join('\n'),
      );

      // Workload-completion precondition (NOT a throughput gate — see the policy
      // note on TARGET_WORKFLOWS_PER_SECOND): a run that dispatched almost no
      // workflows means load generation collapsed, so its memory numbers are moot.
      expect(medianTotalWorkflows).toBeGreaterThanOrEqual(MINIMUM_TOTAL_WORKFLOWS);
      expect(medianMemoryGrowthRatePerSecond).toBeLessThanOrEqual(
        MAX_MEDIAN_MEMORY_GROWTH_BYTES_PER_SECOND,
      );
      expect(medianPostWarmupMemoryGrowthBytes).toBeLessThanOrEqual(
        MAX_MEDIAN_POST_WARMUP_MEMORY_GROWTH_BYTES,
      );
      expect(medianPostWarmupMemoryPeakRiseBytes).toBeLessThanOrEqual(
        MAX_MEDIAN_POST_WARMUP_MEMORY_PEAK_RISE_BYTES,
      );
      if (!IS_COVERAGE_INSTRUMENTATION_ENABLED && !IS_CONSTRAINED_CODEX_RUNNER) {
        expect(maximumMemoryGrowthRatePerSecond).toBeLessThanOrEqual(
          MAX_SINGLE_TRIAL_MEMORY_GROWTH_BYTES_PER_SECOND,
        );
        expect(maximumPostWarmupMemoryGrowthBytes).toBeLessThanOrEqual(
          MAX_SINGLE_TRIAL_POST_WARMUP_MEMORY_GROWTH_BYTES,
        );
        expect(maximumPostWarmupMemoryPeakRiseBytes).toBeLessThanOrEqual(
          MAX_SINGLE_TRIAL_POST_WARMUP_MEMORY_PEAK_RISE_BYTES,
        );
      }
    },
    120_000,
  );
});
