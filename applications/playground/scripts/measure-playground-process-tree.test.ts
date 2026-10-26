import { describe, expect, it } from 'bun:test';

import {
  descendantsOf,
  parseProcessTable,
  startTreeSampler,
  treeResidentBytes,
} from './measure-playground-process-tree.ts';
import { quietFor } from '@lostgradient/testing/wait-until';

const table = `
    1     0   2048
  100     1   1000
  101   100    500
  102   101    250
  200     1   9999
  garbage line
  103   100    125
`;

describe('parseProcessTable', () => {
  it('reads pid, parent pid, and resident kibibytes and skips malformed lines', () => {
    const rows = parseProcessTable(table);
    expect(rows).toHaveLength(6);
    expect(rows[1]).toEqual({ pid: 100, parentPid: 1, residentKibibytes: 1000 });
  });
});

describe('descendantsOf', () => {
  it('walks every generation beneath the root and nothing beside it', () => {
    expect([...descendantsOf(100, parseProcessTable(table))].toSorted((a, b) => a - b)).toEqual([
      100, 101, 102, 103,
    ]);
  });

  it('returns nothing once the root has exited', () => {
    expect(descendantsOf(555, parseProcessTable(table)).size).toBe(0);
  });
});

describe('treeResidentBytes', () => {
  it('sums the owned tree and converts kibibytes to bytes', () => {
    expect(treeResidentBytes([100], parseProcessTable(table))).toEqual({
      residentBytes: (1000 + 500 + 250 + 125) * 1024,
      processCount: 4,
      pids: [100, 101, 102, 103],
    });
  });

  it('counts a process once when two roots overlap', () => {
    expect(treeResidentBytes([100, 101], parseProcessTable(table)).residentBytes).toBe(
      (1000 + 500 + 250 + 125) * 1024,
    );
  });
});

describe('startTreeSampler', () => {
  it('reports the largest summed sample as the tree peak, in bytes', async () => {
    const readings = ['10 1 100\n11 10 50\n', '10 1 300\n11 10 50\n12 11 25\n', '10 1 200\n'];
    let reads = 0;
    let clock = 0;
    const sampler = startTreeSampler({
      rootPids: () => [10],
      readProcessTable: () => Promise.resolve(readings[Math.min(reads++, readings.length - 1)]!),
      intervalMilliseconds: 1,
      now: () => (clock += 5),
    });
    while (reads < readings.length) await Bun.sleep(2);
    const series = await sampler.stop();
    expect(series.peakResidentBytes).toBe((300 + 50 + 25) * 1024);
    expect(series.peakProcessCount).toBe(3);
    expect(series.observedPids).toEqual([10, 11, 12]);
    expect(series.sampleCount).toBe(series.samples.length);
  });

  it('records nothing while no root is known', async () => {
    const sampler = startTreeSampler({
      rootPids: () => [],
      readProcessTable: () => Promise.resolve('10 1 100\n'),
      intervalMilliseconds: 1,
    });
    await quietFor(5);
    const series = await sampler.stop();
    expect(series.sampleCount).toBe(0);
    expect(series.peakResidentBytes).toBe(0);
  });

  it('skips a tick instead of stacking reads behind a slow ps', async () => {
    let release: (() => void) | undefined;
    const sampler = startTreeSampler({
      rootPids: () => [10],
      readProcessTable: () =>
        new Promise<string>((resolve) => {
          release = () => resolve('10 1 100\n');
        }),
      intervalMilliseconds: 1,
    });
    // load-proof: the 1 ms interval's first tick is due before this pause ends, and timers run in deadline order
    await Bun.sleep(10);
    release?.();
    const series = await sampler.stop();
    expect(series.skippedTicks).toBeGreaterThan(0);
    expect(series.sampleCount).toBe(1);
  });
});

describe('startTreeSampler failures (4273630265)', () => {
  it('retains failed reads and their messages instead of discarding them', async () => {
    let reads = 0;
    const sampler = startTreeSampler({
      rootPids: () => [10],
      readProcessTable: () => {
        reads += 1;
        return Promise.reject(new Error(`ps failed ${reads}`));
      },
      intervalMilliseconds: 1,
    });
    while (reads < 3) await Bun.sleep(2);
    const series = await sampler.stop();
    expect(series.sampleCount).toBe(0);
    expect(series.failedReads).toBeGreaterThanOrEqual(3);
    expect(series.failureMessages[0]).toBe('ps failed 1');
    expect(series.failureMessages.length).toBeLessThanOrEqual(5);
  });
});

describe('startTreeSampler memory pressure (CIN-588 harness fix 5)', () => {
  it('reads the pressure level on every tick and keeps the maximum', async () => {
    const levels = [1, 4, 2];
    let pressureReads = 0;
    let tableReads = 0;
    const sampler = startTreeSampler({
      rootPids: () => [10],
      readProcessTable: () => {
        tableReads += 1;
        return Promise.resolve('10 1 100\n');
      },
      readPressureLevel: () =>
        Promise.resolve(levels[Math.min(pressureReads++, levels.length - 1)]!),
      intervalMilliseconds: 1,
    });
    // Paced by table reads, so a sampler that never reads pressure fails instead of hanging.
    while (tableReads < 6) await Bun.sleep(2);
    const series = await sampler.stop();
    expect(series.maximumPressureLevel).toBe(4);
    expect(series.pressureReadings).toBeGreaterThanOrEqual(3);
  });

  it('records no pressure level when none can be read', async () => {
    const sampler = startTreeSampler({
      rootPids: () => [10],
      readProcessTable: () => Promise.resolve('10 1 100\n'),
      readPressureLevel: () => Promise.resolve(null),
      intervalMilliseconds: 1,
    });
    await quietFor(5);
    const series = await sampler.stop();
    expect(series.maximumPressureLevel).toBeNull();
    expect(series.pressureReadings).toBe(0);
  });
});
