import { arch, cpus, loadavg, platform, release, totalmem } from 'node:os';

import type {
  EvidenceCell,
  EvidenceReport,
  ObservedWorkload,
  WorkloadDefinition,
} from '../../../../scripts/terminal/evidence-schema.ts';

/** The targets COR-483 froze in `documentation/terminal/security-and-budgets.md`; a miss reopens a limit, never a comparator. */
export const TARGETS = {
  throughputBytesPerSecond: 1_000_000,
  inputP99Milliseconds: 10,
  memoryDeltaMebibytes: 64,
  cleanupMilliseconds: 5_000,
} as const;

/** The sample counts COR-483 froze: one transfer, one thousand latency samples, one warmup pass for memory. */
export const SAMPLES = { latency: 1_000, transfer: 1, memoryWarmup: 1 } as const;

export type Target = WorkloadDefinition['plan']['target'];

/** Whether a measured value satisfies a target, with the comparator the target names. */
export function meets(target: Target, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (target.comparator === 'gte') return value >= target.value;
  if (target.comparator === 'lte') return value <= target.value;
  return value === target.value;
}

/** The percentile the evidence validator recomputes, so a reported value can be checked byte for byte. */
export function percentile(values: readonly number[], fraction: number): number {
  const ordered = values.toSorted((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? NaN;
}

/** What the host looked like during the run, because the numbers below mean nothing without it. */
export function hostConditions() {
  return {
    loadAverage: loadavg(),
    cpuCount: cpus().length,
    platform: `${platform()}/${arch()}`,
    kernel: release(),
    totalMemoryBytes: totalmem(),
  };
}

export type BenchmarkCell = {
  readonly id: string;
  readonly method: string;
  readonly target: Target;
  readonly sampleCount: number;
  readonly warmupCount: number;
  readonly observed: ObservedWorkload;
  readonly control: ObservedWorkload;
};

function toCell(cell: BenchmarkCell): EvidenceCell {
  const observation = cell.observed.metrics[cell.target.metric];
  const passed = observation !== undefined && meets(cell.target, observation.value);
  return {
    id: cell.id,
    passed,
    observations: [
      `${cell.target.metric} ${observation?.value ?? 'missing'} ${cell.target.unit}, target ${cell.target.comparator} ${cell.target.value}`,
    ],
    versions: { bun: Bun.version, platform: `${platform()}/${arch()}`, kernel: release() },
    metrics: cell.observed.metrics,
    workload: {
      fixtureId: cell.id,
      environment: { hardware: `${arch()}/${platform()}`, runtime: `Bun ${Bun.version}` },
      plan: {
        durationMilliseconds: 120_000,
        sampleCount: cell.sampleCount,
        warmupCount: cell.warmupCount,
        method: cell.method,
        target: cell.target,
      },
      control: { passed: true, observed: cell.control },
      observed: cell.observed,
    },
  };
}

/** A `resource` report under the shared evidence schema. A missed target is a failed cell, still a valid report. */
export function buildBenchmarkReport(
  cells: readonly BenchmarkCell[],
  sourceSha: string,
): EvidenceReport {
  const evidence = cells.map(toCell);
  return {
    schemaVersion: 1,
    reportKind: 'resource',
    sourceSha,
    runId: crypto.randomUUID(),
    observedAt: new Date().toISOString(),
    expectedCellIds: cells.map((cell) => cell.id),
    cells: evidence,
    passed: evidence.every((cell) => cell.passed),
  };
}
