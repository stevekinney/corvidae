import { describe, expect, it } from 'bun:test';

import { summarizeMemoryGrowth, type MemorySample } from './memory-growth.ts';

const MEGABYTE = 1024 * 1024;

function seriesFromMegabytes(megabytes: number[]): MemorySample[] {
  return megabytes.map((value, index) => ({ timestamp: index * 500, bytes: value * MEGABYTE }));
}

describe('summarizeMemoryGrowth', () => {
  it('counts a steady fall as no growth at all', () => {
    const summary = summarizeMemoryGrowth(seriesFromMegabytes([100, 100, 90, 80, 70, 60, 50]), 2);

    expect(summary.postWarmupMemoryGrowthBytes).toBe(0);
    expect(summary.postWarmupMemoryPeakRiseBytes).toBe(0);
    expect(summary.memoryGrowthRatePerSecond).toBe(0);
    expect(summary.samplesAnalyzed).toBe(5);
  });

  it('reports a leak as growth, rise and a positive rate', () => {
    // 2 MB per 500 ms sample is 4 MB/s.
    const summary = summarizeMemoryGrowth(seriesFromMegabytes([50, 50, 50, 52, 54, 56, 58]), 2);

    expect(summary.postWarmupMemoryGrowthBytes).toBe(8 * MEGABYTE);
    expect(summary.postWarmupMemoryPeakRiseBytes).toBe(8 * MEGABYTE);
    expect(summary.memoryGrowthRatePerSecond).toBeCloseTo(4 * MEGABYTE, -3);
  });

  it('measures a leak that begins after memory has finished falling from its low point', () => {
    const summary = summarizeMemoryGrowth(
      seriesFromMegabytes([100, 100, 90, 70, 60, 60, 66, 72]),
      2,
    );

    expect(summary.postWarmupMemoryGrowthBytes).toBe(12 * MEGABYTE);
    expect(summary.postWarmupMemoryPeakRiseBytes).toBe(12 * MEGABYTE);
  });

  it('measures the largest rise even when memory falls back afterward', () => {
    const summary = summarizeMemoryGrowth(seriesFromMegabytes([80, 80, 60, 75, 62, 61]), 2);

    expect(summary.postWarmupMemoryPeakRiseBytes).toBe(15 * MEGABYTE);
    expect(summary.postWarmupMemoryGrowthBytes).toBe(1 * MEGABYTE);
  });

  it('skips the warmup samples entirely', () => {
    const summary = summarizeMemoryGrowth(seriesFromMegabytes([10, 200, 60, 60, 60]), 2);

    expect(summary.postWarmupMemoryGrowthBytes).toBe(0);
    expect(summary.postWarmupMemoryPeakRiseBytes).toBe(0);
    expect(summary.peakMemoryBytes).toBe(200 * MEGABYTE);
  });

  it('reports zeros when there is nothing left to analyze', () => {
    const summary = summarizeMemoryGrowth(seriesFromMegabytes([10, 20]), 4);

    expect(summary).toMatchObject({
      postWarmupMemoryGrowthBytes: 0,
      postWarmupMemoryPeakRiseBytes: 0,
      memoryGrowthRatePerSecond: 0,
      samplesAnalyzed: 0,
    });
    expect(summarizeMemoryGrowth([], 4).averageMemoryBytes).toBe(0);
  });
});
