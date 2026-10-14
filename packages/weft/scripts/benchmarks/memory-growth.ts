import { linearRegression } from '../../src/diagnostics/memory-profiler.ts';

/** One reading of process memory: `timestamp` in milliseconds, `bytes` from `readMemoryFootprint`. */
export type MemorySample = {
  timestamp: number;
  bytes: number;
};

export type MemoryGrowthSummary = {
  peakMemoryBytes: number;
  averageMemoryBytes: number;
  /**
   * How far the last analyzed reading sits above the lowest analyzed reading.
   * Zero when memory only fell.
   */
  postWarmupMemoryGrowthBytes: number;
  /**
   * The largest rise from any analyzed reading to a later one. Zero when memory
   * only fell.
   */
  postWarmupMemoryPeakRiseBytes: number;
  /**
   * Least-squares slope of the analyzed readings, floored at zero. A negative
   * slope is memory being returned, not growth.
   */
  memoryGrowthRatePerSecond: number;
  samplesAnalyzed: number;
};

/**
 * Summarizes how much a process's memory grew, ignoring memory it gave back.
 *
 * A leak shows up as memory that rises and stays risen. After a warmup burst,
 * the allocator keeps returning pages to the operating system for several
 * seconds, so the physical footprint legitimately falls through the analysis
 * window. Every figure here is one-sided: a fall never counts as growth, and a
 * rise counts in full, measured from the lowest point that precedes it.
 */
export function summarizeMemoryGrowth(
  samples: MemorySample[],
  warmupSamples: number,
): MemoryGrowthSummary {
  let peakMemoryBytes = 0;
  let totalMemoryBytes = 0;

  for (const sample of samples) {
    peakMemoryBytes = Math.max(peakMemoryBytes, sample.bytes);
    totalMemoryBytes += sample.bytes;
  }

  const analyzedSamples = samples.slice(warmupSamples);
  let lowestBytes = Number.POSITIVE_INFINITY;
  let peakRiseBytes = 0;

  for (const sample of analyzedSamples) {
    lowestBytes = Math.min(lowestBytes, sample.bytes);
    peakRiseBytes = Math.max(peakRiseBytes, sample.bytes - lowestBytes);
  }

  const lastBytes = analyzedSamples.at(-1)?.bytes ?? 0;

  return {
    peakMemoryBytes,
    averageMemoryBytes: samples.length === 0 ? 0 : Math.round(totalMemoryBytes / samples.length),
    postWarmupMemoryGrowthBytes:
      analyzedSamples.length === 0 ? 0 : Math.max(0, lastBytes - lowestBytes),
    postWarmupMemoryPeakRiseBytes: peakRiseBytes,
    memoryGrowthRatePerSecond: Math.max(0, calculateMemorySlopePerSecond(analyzedSamples)),
    samplesAnalyzed: analyzedSamples.length,
  };
}

function calculateMemorySlopePerSecond(analyzedSamples: MemorySample[]): number {
  if (analyzedSamples.length <= 1) {
    return 0;
  }

  const baselineTimestamp = analyzedSamples[0]!.timestamp;
  const points: [number, number][] = analyzedSamples.map((sample) => [
    (sample.timestamp - baselineTimestamp) / 1000,
    sample.bytes,
  ]);

  return linearRegression(points).slope;
}
