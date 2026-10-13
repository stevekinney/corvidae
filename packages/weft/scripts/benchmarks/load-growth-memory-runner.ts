import { Engine } from '../../src/core/engine.ts';
import {
  registerOnRuntimeEngine,
  runtimeWorkflowEngine,
  type RuntimeWorkflowEngine,
} from '../../src/core/runtime-workflow-engine.ts';
import { compileStepWorkflow } from '../../src/core/step-context.ts';
import { workflow, type StepWorkflowContext } from '../../src/core/types.ts';
import { BunSQLiteStorage } from '../../src/storage/bun-sql.ts';
import { readMemoryFootprint, type MemoryMeasure } from './memory-footprint.ts';
import { summarizeMemoryGrowth } from './memory-growth.ts';

const DEFAULT_DURATION_MILLISECONDS = 12_000;
const DEFAULT_TARGET_WORKFLOWS_PER_SECOND = 10_000;
const DEFAULT_SAMPLE_INTERVAL_MILLISECONDS = 500;
const DEFAULT_WARMUP_SAMPLES = 4;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_WARMUP_WORKFLOWS = 10_000;
const DEFAULT_RETENTION_DURATION_MILLISECONDS = 0;
const DEFAULT_RETENTION_SWEEP_INTERVAL = '25ms';
const DEFAULT_RETENTION_SWEEP_BATCH_SIZE = 10_000;

/**
 * One reading of the process's memory, taken after a forced collection.
 *
 * The benchmark reads the kernel's physical footprint (see `memory-footprint.ts`)
 * rather than resident set size. On macOS the JavaScriptCore allocator keeps
 * freed heap pages resident-but-clean, so RSS climbs by several megabytes over a
 * 12-second run while the physical footprint of the same process falls. RSS
 * measured the allocator's lazy return of pages, not retained memory.
 */
type MemorySample = {
  timestamp: number;
  bytes: number;
  measure: MemoryMeasure;
};

export type LoadGrowthMemoryMeasurement = {
  configuredDurationMilliseconds: number;
  measuredDurationMilliseconds: number;
  targetWorkflowsPerSecond: number;
  /**
   * Unthrottled workflows/sec measured during warmup — this machine's actual
   * ceiling, before pacing. Logged as diagnostic context (and structurally
   * validated as a positive integer) so a human can see how far the paced,
   * GC-sampled sustained rate sits below the machine's raw capacity. It is
   * deliberately NOT used as a pass/fail throughput floor — see the policy note
   * on `TARGET_WORKFLOWS_PER_SECOND` in `load-growth-memory.test.ts`.
   */
  calibratedWorkflowsPerSecond: number;
  sampleIntervalMilliseconds: number;
  workflowBatchSize: number;
  warmupSamples: number;
  samplesAnalyzed: number;
  samplesCollected: number;
  totalWorkflows: number;
  workflowsPerSecond: number;
  /** Which kernel measure the readings below are: see `MemoryMeasure`. */
  memoryMeasure: MemoryMeasure;
  /** One-sided figures from `summarizeMemoryGrowth`: a fall in memory is never growth. */
  memoryGrowthRatePerSecond: number;
  peakMemoryBytes: number;
  averageMemoryBytes: number;
  postWarmupMemoryGrowthBytes: number;
  postWarmupMemoryPeakRiseBytes: number;
};

type BenchmarkConfiguration = {
  durationMilliseconds: number;
  targetWorkflowsPerSecond: number;
};

function parsePositiveInteger(
  rawValue: string | undefined,
  fallback: number,
  label: string,
): number {
  if (rawValue === undefined) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return parsed;
}

function loadConfiguration(argv: string[]): BenchmarkConfiguration {
  return {
    durationMilliseconds: parsePositiveInteger(
      argv[2],
      DEFAULT_DURATION_MILLISECONDS,
      'durationMilliseconds',
    ),
    targetWorkflowsPerSecond: parsePositiveInteger(
      argv[3],
      DEFAULT_TARGET_WORKFLOWS_PER_SECOND,
      'targetWorkflowsPerSecond',
    ),
  };
}

async function completeWorkflowBatch(
  engine: RuntimeWorkflowEngine,
  workflowStartIndex: number,
  workflowBatchSize: number,
): Promise<void> {
  const startPromises = [];

  for (let index = 0; index < workflowBatchSize; index += 1) {
    startPromises.push(engine.start('noop', workflowStartIndex + index));
  }

  const handles = await Promise.all(startPromises);
  await Promise.all(handles.map((handle) => handle.result()));
}

async function runWarmup(engine: RuntimeWorkflowEngine): Promise<number> {
  // The warmup runs unthrottled (no pacing sleep), so its rate is this
  // machine's real sustained ceiling. We time only the workflow-completion
  // loop — the trailing settle/GC below is excluded — and return it as
  // diagnostic context for the sustained run (logged, not used as a gate).
  const startedAt = performance.now();

  for (
    let workflowStartIndex = 0;
    workflowStartIndex < DEFAULT_WARMUP_WORKFLOWS;
    workflowStartIndex += DEFAULT_BATCH_SIZE
  ) {
    const workflowBatchSize = Math.min(
      DEFAULT_BATCH_SIZE,
      DEFAULT_WARMUP_WORKFLOWS - workflowStartIndex,
    );
    await completeWorkflowBatch(engine, workflowStartIndex, workflowBatchSize);
  }

  const elapsedMilliseconds = Math.max(1, performance.now() - startedAt);
  const calibratedWorkflowsPerSecond = Math.round(
    (DEFAULT_WARMUP_WORKFLOWS / elapsedMilliseconds) * 1000,
  );

  await Bun.sleep(100);

  if (typeof Bun.gc === 'function') {
    Bun.gc(true);
  }

  return calibratedWorkflowsPerSecond;
}

function snapshotRetainedMemory(): MemorySample {
  if (typeof Bun.gc === 'function') {
    Bun.gc(true);
  }

  const reading = readMemoryFootprint();

  return { timestamp: Date.now(), bytes: reading.bytes, measure: reading.measure };
}

async function runSustainedLoad(
  engine: RuntimeWorkflowEngine,
  durationMilliseconds: number,
  targetWorkflowsPerSecond: number,
  sampleIntervalMilliseconds: number,
): Promise<{ elapsedMilliseconds: number; samples: MemorySample[]; totalWorkflows: number }> {
  const startedAt = performance.now();
  const deadline = startedAt + durationMilliseconds;
  const samples: MemorySample[] = [snapshotRetainedMemory()];
  let lastSampleTimestamp = samples[0]!.timestamp;
  let totalWorkflows = 0;

  while (performance.now() < deadline) {
    await completeWorkflowBatch(engine, totalWorkflows, DEFAULT_BATCH_SIZE);
    totalWorkflows += DEFAULT_BATCH_SIZE;

    if (Date.now() - lastSampleTimestamp >= sampleIntervalMilliseconds) {
      const sample = snapshotRetainedMemory();
      samples.push(sample);
      lastSampleTimestamp = sample.timestamp;
    }

    const pacingTargetWorkflowsPerSecond = targetWorkflowsPerSecond * 1.02;
    const targetElapsedMilliseconds = (totalWorkflows / pacingTargetWorkflowsPerSecond) * 1000;
    const sleepMilliseconds = Math.max(
      0,
      startedAt + targetElapsedMilliseconds - performance.now(),
    );
    await Bun.sleep(sleepMilliseconds);

    if (Date.now() - lastSampleTimestamp >= sampleIntervalMilliseconds) {
      const sample = snapshotRetainedMemory();
      samples.push(sample);
      lastSampleTimestamp = sample.timestamp;
    }
  }

  samples.push(snapshotRetainedMemory());

  const elapsedMilliseconds = Math.max(1, performance.now() - startedAt);

  return { totalWorkflows, elapsedMilliseconds, samples };
}

export async function measureLoadGrowthMemory(
  configuration: BenchmarkConfiguration,
): Promise<LoadGrowthMemoryMeasurement> {
  const storage = new BunSQLiteStorage(':memory:');
  const engine = runtimeWorkflowEngine(
    new Engine({
      storage,
      retention: {
        cancelled: DEFAULT_RETENTION_DURATION_MILLISECONDS,
        completed: DEFAULT_RETENTION_DURATION_MILLISECONDS,
        failed: DEFAULT_RETENTION_DURATION_MILLISECONDS,
        timedOut: DEFAULT_RETENTION_DURATION_MILLISECONDS,
      },
      retentionSweepBatchSize: DEFAULT_RETENTION_SWEEP_BATCH_SIZE,
      retentionSweepInterval: DEFAULT_RETENTION_SWEEP_INTERVAL,
    }),
  );

  try {
    registerOnRuntimeEngine(
      engine,
      workflow({ name: 'noop' }).execute(
        compileStepWorkflow(async (_context: StepWorkflowContext, input: unknown) => {
          return input;
        }),
      ),
    );

    const calibratedWorkflowsPerSecond = await runWarmup(engine);

    const { totalWorkflows, elapsedMilliseconds, samples } = await runSustainedLoad(
      engine,
      configuration.durationMilliseconds,
      configuration.targetWorkflowsPerSecond,
      DEFAULT_SAMPLE_INTERVAL_MILLISECONDS,
    );
    const summary = summarizeMemoryGrowth(samples, DEFAULT_WARMUP_SAMPLES);

    return {
      configuredDurationMilliseconds: configuration.durationMilliseconds,
      measuredDurationMilliseconds: Math.max(
        configuration.durationMilliseconds,
        Math.round(elapsedMilliseconds),
      ),
      targetWorkflowsPerSecond: configuration.targetWorkflowsPerSecond,
      calibratedWorkflowsPerSecond,
      sampleIntervalMilliseconds: DEFAULT_SAMPLE_INTERVAL_MILLISECONDS,
      workflowBatchSize: DEFAULT_BATCH_SIZE,
      warmupSamples: DEFAULT_WARMUP_SAMPLES,
      samplesAnalyzed: summary.samplesAnalyzed,
      samplesCollected: samples.length,
      totalWorkflows,
      workflowsPerSecond: Math.round((totalWorkflows / elapsedMilliseconds) * 1000),
      memoryMeasure: samples[0]!.measure,
      memoryGrowthRatePerSecond: summary.memoryGrowthRatePerSecond,
      peakMemoryBytes: summary.peakMemoryBytes,
      averageMemoryBytes: summary.averageMemoryBytes,
      postWarmupMemoryGrowthBytes: summary.postWarmupMemoryGrowthBytes,
      postWarmupMemoryPeakRiseBytes: summary.postWarmupMemoryPeakRiseBytes,
    };
  } finally {
    engine[Symbol.dispose]();
    storage[Symbol.dispose]();
  }
}

if (import.meta.main) {
  const measurement = await measureLoadGrowthMemory(loadConfiguration(Bun.argv));
  console.log(JSON.stringify(measurement));
}
