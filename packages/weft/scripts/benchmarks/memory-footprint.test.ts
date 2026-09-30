import { describe, expect, it } from 'bun:test';

import { readMemoryFootprint } from './memory-footprint.ts';

const RETAINED_BYTES = 128 * 1024 * 1024;
/** Half the allocation: enough to prove the reading tracks retained pages. */
const MINIMUM_OBSERVED_GROWTH_BYTES = RETAINED_BYTES / 2;

/**
 * Random bytes do not compress, so the kernel cannot shrink the allocation out
 * of the footprint ledger while the test is reading it.
 */
function fillWithIncompressibleBytes(target: Uint8Array): void {
  const maximumChunkBytes = 65_536;
  for (let offset = 0; offset < target.length; offset += maximumChunkBytes) {
    crypto.getRandomValues(target.subarray(offset, offset + maximumChunkBytes));
  }
}

describe('readMemoryFootprint', () => {
  it('reports a positive integer byte count and names its measure', () => {
    const reading = readMemoryFootprint();

    expect(Number.isInteger(reading.bytes)).toBe(true);
    expect(reading.bytes).toBeGreaterThan(0);
    expect(reading.measure).toBe(
      process.platform === 'darwin' ? 'physical-footprint' : 'resident-set-size',
    );
  });

  it('rises when the process retains and touches memory', () => {
    const before = readMemoryFootprint().bytes;
    const retained = new Uint8Array(RETAINED_BYTES);
    fillWithIncompressibleBytes(retained);
    const after = readMemoryFootprint().bytes;

    expect(after - before).toBeGreaterThanOrEqual(MINIMUM_OBSERVED_GROWTH_BYTES);
    expect(retained.length).toBe(RETAINED_BYTES);
  });
});
