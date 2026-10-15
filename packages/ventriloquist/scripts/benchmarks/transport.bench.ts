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
  meets,
  type BenchmarkCell,
  type Target,
} from './benchmark-report.ts';
import {
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
const cells: BenchmarkCell[] = [
  {
    id: 'throughput-and-queues',
    method:
      'eight mebibytes of 64 KiB chunks through the Bun WebSocket host, four chunks in flight, until the client reports the last byte parsed',
    target: throughputTarget,
    sampleCount: SAMPLES.transfer,
    warmupCount: 0,
    control: throughputControl(),
    observed: await measureThroughput('websocket'),
  },
  {
    id: 'direct-throughput-and-queues',
    method: 'the same transfer through the in-memory path',
    target: throughputTarget,
    sampleCount: SAMPLES.transfer,
    warmupCount: 0,
    control: throughputControl(),
    observed: await measureThroughput('direct'),
  },
  {
    id: 'input-latency',
    method:
      'one thousand one-byte inputs over the Bun WebSocket host, each timed until its acknowledgement into the host FIFO',
    target: latencyTarget,
    sampleCount: SAMPLES.latency,
    warmupCount: 0,
    control: latencyControl(),
    observed: await measureAcknowledgementLatency('websocket'),
  },
  {
    id: 'direct-input-latency',
    method: 'the same thousand acknowledgements through the in-memory path',
    target: latencyTarget,
    sampleCount: SAMPLES.latency,
    warmupCount: 0,
    control: latencyControl(),
    observed: await measureAcknowledgementLatency('direct'),
  },
  {
    id: 'pty-echo-latency',
    method:
      'one thousand one-byte inputs to a real PTY over the Bun WebSocket host, each timed until the terminal echoed it back',
    target: latencyTarget,
    sampleCount: SAMPLES.latency,
    warmupCount: 0,
    control: latencyControl(),
    observed: await measureTerminalEchoLatency('websocket'),
  },
  {
    id: 'memory-plateau',
    method:
      'resident memory growth across a 32 MiB transfer over the Bun WebSocket host, after one identical warmup transfer',
    target: memoryTarget,
    sampleCount: SAMPLES.transfer,
    warmupCount: SAMPLES.memoryWarmup,
    control: memoryControl(),
    observed: await measureMemoryPlateau('websocket'),
  },
  {
    id: 'cleanup-duration',
    method: 'stop to cleanup result for a real PTY child over the Bun WebSocket host',
    target: cleanupTarget,
    sampleCount: SAMPLES.transfer,
    warmupCount: 0,
    control: await cleanupControl(),
    observed: await measureCleanup('websocket', 'pty', false),
  },
  {
    id: 'stubborn-cleanup-duration',
    method:
      'stop to cleanup result for a real PTY child and descendant that both ignore TERM, at the default one second grace',
    target: cleanupTarget,
    sampleCount: SAMPLES.transfer,
    warmupCount: 0,
    control: await cleanupControl(),
    observed: await measureCleanup('websocket', 'pty', true),
  },
  {
    id: 'control-path-under-backlog',
    method:
      'stop to cleanup result with 512 KiB of output unparsed and 64 operations queued behind a stalled write',
    target: cleanupTarget,
    sampleCount: SAMPLES.transfer,
    warmupCount: 0,
    control: await cleanupControl(),
    observed: await measureControlPath('websocket'),
  },
];

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

describe('the benchmark report', () => {
  test('is a valid resource report under the shared evidence schema, whatever the measurements were', () => {
    const written = JSON.parse(readFileSync(reportPath, 'utf8')) as EvidenceReport;
    expect(structuralErrors(written)).toEqual([]);
    // A missed target is evidence, not a malformed report; the targets are asserted below.
    expect(
      validateEvidence(written, 'resource').filter((error) => error !== 'target comparator failed'),
    ).toEqual([]);
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
      expect(meets(cell.target, measured), `measured ${measured} ${cell.target.unit}`).toBe(true);
    });
  }
});
