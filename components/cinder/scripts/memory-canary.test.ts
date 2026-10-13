import { afterEach, describe, expect, test } from 'bun:test';

import { formatCanaryReport, peakRssBytesFrom, runMemoryCanaryCommand } from './memory-canary.ts';

const ONE_MEBIBYTE = 1_048_576;
const originalPlatform = process.platform;

function simulatePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

describe('peakRssBytesFrom', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    test(`treats Bun subprocess maxRSS as bytes on ${platform}`, () => {
      simulatePlatform(platform);
      expect(peakRssBytesFrom({ maxRSS: ONE_MEBIBYTE })).toBe(ONE_MEBIBYTE);
    });
  }

  test('reports missing or zero resource usage as unavailable rather than zero', () => {
    expect(peakRssBytesFrom(undefined)).toBeUndefined();
    expect(peakRssBytesFrom({})).toBeUndefined();
    expect(peakRssBytesFrom({ maxRSS: 0 })).toBeUndefined();
  });
});

describe('formatCanaryReport', () => {
  test('prints 1,048,576 bytes as 1.0 MB', () => {
    const report = formatCanaryReport({
      peakRssBytes: ONE_MEBIBYTE,
      suiteCount: 6,
      runtimeVersion: '1.4.2',
    });
    expect(report).toBe('memory-canary: peak RSS 1.0 MB (1048576 bytes) over 6 suites, Bun 1.4.2');
  });

  test('says the measurement is unavailable instead of printing 0.0 MB', () => {
    const report = formatCanaryReport({
      peakRssBytes: undefined,
      suiteCount: 6,
      runtimeVersion: '1.4.2',
    });
    expect(report).toBe('memory-canary: peak RSS unavailable over 6 suites, Bun 1.4.2');
    expect(report).not.toContain('0.0 MB');
  });
});

describe('runMemoryCanaryCommand', () => {
  test('measures a real child in bytes', async () => {
    const allocationBytes = 64 * ONE_MEBIBYTE;
    const result = await runMemoryCanaryCommand([
      process.execPath,
      '-e',
      `const buffer = Buffer.alloc(${allocationBytes}, 1); if (buffer[7] !== 1) process.exit(2);`,
    ]);

    expect(result.exitCode).toBe(0);
    // The child holds the whole buffer resident, so its high-water mark is at
    // least the allocation. These bounds are a unit check, not a memory target:
    // a kibibyte-valued reading lands ~1024 times below the lower bound, and a
    // kibibyte-scaled one at least twice the upper bound, which leaves the
    // child's real footprint hundreds of times of headroom on any host.
    expect(result.peakRssBytes).toBeGreaterThanOrEqual(allocationBytes);
    expect(result.peakRssBytes).toBeLessThan(allocationBytes * 512);
  });

  test('preserves a failing child exit code', async () => {
    const result = await runMemoryCanaryCommand([process.execPath, '-e', 'process.exit(3)']);
    expect(result.exitCode).toBe(3);
  });
});
