import { describe, expect, it } from 'bun:test';

import { readMemoryFootprint, readPhysicalFootprintBytes } from './memory-footprint.ts';

describe('readMemoryFootprint', () => {
  it('reports a positive integer byte count and names its measure', () => {
    const reading = readMemoryFootprint();

    expect(Number.isInteger(reading.bytes)).toBe(true);
    expect(reading.bytes).toBeGreaterThan(0);
    expect(reading.measure).toBe(
      process.platform === 'darwin' ? 'physical-footprint' : 'resident-set-size',
    );
  });

  it('falls back to resident set size where the kernel has no footprint ledger', () => {
    const reading = readMemoryFootprint('linux');

    expect(reading.measure).toBe('resident-set-size');
    expect(reading.bytes).toBeGreaterThan(0);
  });
});

describe('readPhysicalFootprintBytes', () => {
  it('throws instead of substituting another measure when the kernel call fails', () => {
    expect(() => readPhysicalFootprintBytes(() => -1)).toThrow(
      'proc_pid_rusage failed with status -1',
    );
  });

  it('reads the footprint from the ninth word of the usage record', () => {
    const footprint = readPhysicalFootprintBytes((buffer) => {
      buffer[9] = 123_456_789n;
      return 0;
    });

    expect(footprint).toBe(123_456_789);
  });
});
