/**
 * Timing and throughput targets for the terminal transports, frozen by COR-483 in
 * `documentation/terminal/security-and-budgets.md`. These assert wall-clock thresholds, so they
 * are benchmarks and not correctness tests: the file lives under `scripts/benchmarks/` as
 * `*.bench.ts`, which Bun's default discovery skips, and `bun run test` never runs it. Run it on
 * demand with `bun run test:benchmarks`. Everything deterministic (bounded queues, overflow,
 * responsiveness, leaks) is proven in `src/conformance/` and does run in the default suite.
 *
 * The report is written before any target is asserted, so a missed target still leaves
 * `test-results/benchmarks.json` behind, and the run then exits nonzero.
 */
import { SCENARIO_HANG_GUARD_MILLISECONDS } from '@lostgradient/testing';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  validateEvidence,
  type EvidenceReport,
} from '../../../../scripts/terminal/evidence-schema.ts';
import {
  cleanupControl,
  latencyControl,
  memoryControl,
  throughputControl,
} from './benchmark-controls.ts';
import {
  SAMPLES,
  TARGETS,
  buildBenchmarkReport,
  cellPasses,
  failedObservation,
  meets,
  runCell,
  type BenchmarkCell,
  type CellSpecification,
  type Target,
} from './benchmark-report.ts';
import {
  RESUME_SAMPLES,
  measureFloodThroughput,
  measurePauseLatency,
  measurePausedMemory,
  measureResumeLatency,
  resumeLatencyControl,
} from './flood-measurements.ts';
import {
  cleanupObservation,
  measureAcknowledgementLatency,
  measureCleanup,
  measureControlPath,
  measureMemoryPlateau,
  measureTerminalEchoLatency,
  measureThroughput,
} from './transport-measurements.ts';

const packageRoot = join(import.meta.dir, '../..');
const repositoryRoot = join(packageRoot, '../..');
const reportPath = join(packageRoot, 'test-results/benchmarks.json');
const schemaPath = join(repositoryRoot, 'scripts/terminal/evidence.schema.json');

const throughputTarget: Target = {
  metric: 'throughput',
  unit: 'bytes/second',
  comparator: 'gte',
  value: TARGETS.throughputBytesPerSecond,
};
const latencyTarget: Target = {
  metric: 'p99',
  unit: 'milliseconds',
  comparator: 'lte',
  value: TARGETS.inputP99Milliseconds,
};
const memoryTarget: Target = {
  metric: 'memoryDelta',
  unit: 'MiB',
  comparator: 'lte',
  value: TARGETS.memoryDeltaMebibytes,
};
const cleanupTarget: Target = {
  metric: 'cleanup',
  unit: 'milliseconds',
  comparator: 'lte',
  value: TARGETS.cleanupMilliseconds,
};

// A report left by an earlier run must never be mistaken for this one's, even if this run dies first.
rmSync(reportPath, { force: true });

// Each measurement drives real sockets and processes, one after another, off Bun's per-test clock.
const specifications: CellSpecification[] = [
  {
    id: 'throughput-and-queues',
    method:
      'eight mebibytes of 64 KiB chunks through the Bun WebSocket host, four chunks in flight, until the client reports the last byte parsed',
    target: throughputTarget,
    sampleCount: SAMPLES.transfer,
    warmupCount: 0,
    control: () => throughputControl(),
    measure: () => measureThroughput('websocket'),
  },
  {
    id: 'direct-throughput-and-queues',
    method: 'the same transfer through the in-memory path',
    target: throughputTarget,
    sampleCount: SAMPLES.transfer,
    warmupCount: 0,
    control: () => throughputControl(),
    measure: () => measureThroughput('direct'),
  },
  {
    id: 'input-latency',
    method:
      'one thousand one-byte inputs over the Bun WebSocket host, each timed until its acknowledgement into the host FIFO',
    target: latencyTarget,
    sampleCount: SAMPLES.latency,
    warmupCount: 0,
    control: () => latencyControl(),
    measure: () => measureAcknowledgementLatency('websocket'),
  },
  {
    id: 'direct-input-latency',
    method: 'the same thousand acknowledgements through the in-memory path',
    target: latencyTarget,
    sampleCount: SAMPLES.latency,
    warmupCount: 0,
    control: () => latencyControl(),
    measure: () => measureAcknowledgementLatency('direct'),
  },
  {
    id: 'pty-echo-latency',
    method:
      'one thousand one-byte inputs to a real PTY over the Bun WebSocket host, each timed until the terminal echoed it back',
    target: latencyTarget,
    sampleCount: SAMPLES.latency,
    warmupCount: 0,
    control: () => latencyControl(),
    measure: () => measureTerminalEchoLatency('websocket'),
  },
  {
    id: 'memory-plateau',
    method:
      'resident memory growth across a 32 MiB transfer over the Bun WebSocket host, after one identical warmup transfer',
    target: memoryTarget,
    sampleCount: SAMPLES.transfer,
    warmupCount: SAMPLES.memoryWarmup,
    control: () => memoryControl(),
    measure: () => measureMemoryPlateau('websocket'),
  },
  ...(['pipe', 'pty'] as const).flatMap((mode): CellSpecification[] => [
    {
      id: `flood-throughput-${mode}`,
      method: `sixteen mebibytes of \`cat\` through a real ${mode} process and the Bun WebSocket host, the client parsing each chunk as it arrives, until the last byte is parsed`,
      target: throughputTarget,
      sampleCount: SAMPLES.transfer,
      warmupCount: 0,
      control: () => throughputControl(),
      measure: () => measureFloodThroughput('websocket', mode),
    },
    {
      id: `pause-latency-${mode}`,
      method: `fifty stalls of a flooding ${mode} process through the in-memory path, each timed from the output queue being full until the last byte the host delivers before it goes quiet`,
      target: latencyTarget,
      sampleCount: RESUME_SAMPLES,
      warmupCount: 0,
      control: () => resumeLatencyControl(),
      measure: () => measurePauseLatency('direct', mode),
    },
    {
      id: `resume-latency-${mode}`,
      method: `fifty stalls of a flooding ${mode} process through the in-memory path, each timed from the client reporting its held output parsed until the next byte of output reaches it (the host's own resume; a loopback socket and its client add milliseconds of their own on top)`,
      target: latencyTarget,
      sampleCount: RESUME_SAMPLES,
      warmupCount: 0,
      control: () => resumeLatencyControl(),
      measure: () => measureResumeLatency('direct', mode),
    },
    {
      id: `paused-memory-${mode}`,
      method: `resident memory growth across three seconds of a flooding ${mode} process held back by a client that parses nothing, after one identical warmup stall`,
      target: memoryTarget,
      sampleCount: SAMPLES.transfer,
      warmupCount: SAMPLES.memoryWarmup,
      control: () => memoryControl(),
      measure: () => measurePausedMemory('websocket', mode),
    },
  ]),
  {
    id: 'cleanup-duration',
    method: 'stop to cleanup result for a real PTY child over the Bun WebSocket host',
    target: cleanupTarget,
    sampleCount: SAMPLES.transfer,
    warmupCount: 0,
    control: () => cleanupControl(),
    measure: () => measureCleanup('websocket', 'pty', false),
  },
  {
    id: 'stubborn-cleanup-duration',
    method:
      'stop to cleanup result for a real PTY child and descendant that both ignore TERM, at the default one second grace',
    target: cleanupTarget,
    sampleCount: SAMPLES.transfer,
    warmupCount: 0,
    control: () => cleanupControl(),
    measure: () => measureCleanup('websocket', 'pty', true),
  },
  {
    id: 'control-path-under-backlog',
    method:
      'stop to cleanup result with 512 KiB of output unparsed and 64 operations queued behind a stalled write',
    target: cleanupTarget,
    sampleCount: SAMPLES.transfer,
    warmupCount: 0,
    control: () => cleanupControl(),
    measure: () => measureControlPath('websocket'),
  },
];

const cells: BenchmarkCell[] = [];
for (const specification of specifications) cells.push(await runCell(specification));

const sourceSha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
  cwd: repositoryRoot,
  timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
})
  .stdout.toString()
  .trim();

const report = buildBenchmarkReport(cells, sourceSha);
mkdirSync(join(packageRoot, 'test-results'), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

function structuralErrors(candidate: unknown): string[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')) as object);
  return validate(candidate)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`);
}

describe('the benchmark controls', () => {
  test('a value that misses each comparator is reported as missing it', () => {
    expect(meets(throughputTarget, TARGETS.throughputBytesPerSecond - 1)).toBe(false);
    expect(meets(latencyTarget, TARGETS.inputP99Milliseconds + 0.001)).toBe(false);
    expect(meets(memoryTarget, TARGETS.memoryDeltaMebibytes + 1)).toBe(false);
    expect(meets(cleanupTarget, TARGETS.cleanupMilliseconds + 1)).toBe(false);
    expect(meets(latencyTarget, Number.NaN)).toBe(false);
    expect(meets({ ...latencyTarget, comparator: 'eq', value: 1 }, 1)).toBe(true);
  });

  test('each control meets the comparator its workload is held to', () => {
    for (const cell of cells) {
      const control = cell.control.metrics[cell.target.metric];
      expect(control, cell.id).toBeDefined();
      expect(meets(cell.target, control?.value ?? Number.NaN), cell.id).toBe(true);
    }
  });
});

describe('a cell that does not hold', () => {
  const cleanup = cells.find((cell) => cell.id === 'cleanup-duration') as BenchmarkCell;
  const withOutcome = (outcome: string): BenchmarkCell => ({
    ...cleanup,
    observed: cleanupObservation(1, outcome),
  });

  test('a fast cleanup that is not complete fails its cell, for every outcome but complete', () => {
    expect(cellPasses(withOutcome('complete'))).toBe(true);
    expect(cellPasses(withOutcome('incomplete'))).toBe(false);
    expect(cellPasses(withOutcome('unknown'))).toBe(false);
    const unknown = buildBenchmarkReport([withOutcome('unknown')], 'a'.repeat(40));
    expect(unknown.passed).toBe(false);
    expect(unknown.cells[0]?.observations.join(' ')).toContain('cleanup outcome unknown');
  });

  test('a measurement that throws is a failed cell on record, and the other cells keep their numbers', async () => {
    const thrown = await runCell({
      ...cleanup,
      id: 'throws',
      control: () => cleanupControl(),
      measure: () => Promise.reject(new Error('the host went away')),
    });
    expect(cellPasses(thrown)).toBe(false);
    expect(thrown.observed.raw['error']).toBe('the host went away');
    expect(thrown.observed.metrics['measurementFailed']?.value).toBe(1);
    expect(failedObservation('text', 1, 0).raw['error']).toBe('text');
    const mixed = buildBenchmarkReport([thrown, cleanup], 'a'.repeat(40));
    expect(mixed.cells.map((cell) => cell.passed)).toEqual([false, cellPasses(cleanup)]);
  });
});

describe('the benchmark report', () => {
  test('is a valid resource report under the shared evidence schema, whatever the measurements were', () => {
    const written = JSON.parse(readFileSync(reportPath, 'utf8')) as EvidenceReport;
    expect(structuralErrors(written)).toEqual([]);
    // A missed target is evidence, not a malformed report; the targets are asserted below. A
    // measurement that threw has no metric to validate, and its own test below names the error.
    if (!cells.some((cell) => cell.observed.metrics['measurementFailed'] !== undefined)) {
      expect(
        validateEvidence(written, 'resource').filter(
          (error) => error !== 'target comparator failed',
        ),
      ).toEqual([]);
    }
    expect(written.cells.map((cell) => cell.id)).toEqual(written.expectedCellIds);
  });

  test('records versions, thresholds, measured values and host load for every cell', () => {
    for (const cell of report.cells) {
      expect(Object.keys(cell.versions).toSorted(), cell.id).toEqual(['bun', 'kernel', 'platform']);
      expect(cell.workload?.plan.target.value, cell.id).toBeGreaterThan(0);
      expect(cell.workload?.observed.raw['host'], cell.id).toBeDefined();
    }
  });
});

describe('the COR-483 targets', () => {
  for (const cell of cells) {
    test(`${cell.id}: ${cell.target.metric} ${cell.target.comparator} ${cell.target.value} ${cell.target.unit}`, () => {
      const measured = cell.observed.metrics[cell.target.metric]?.value ?? Number.NaN;
      expect(
        cellPasses(cell),
        `measured ${measured} ${cell.target.unit}, outcome ${String(cell.observed.raw['outcome'])}, error ${String(cell.observed.raw['error'])}`,
      ).toBe(true);
    });
  }
});
