import { describe, expect, it } from 'bun:test';

import { readMemoryFootprint } from './memory-footprint.ts';

/**
 * How far the reading moves depends on how the host's kernel accounts for and
 * reclaims memory, so this lives with the benchmarks, outside the default
 * `test` gate. The deterministic reader tests stay in `memory-footprint.test.ts`.
 */
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

describe('readMemoryFootprint under retained memory', () => {
  it('rises when the process retains and touches memory', () => {
    const before = readMemoryFootprint().bytes;
    const retained = new Uint8Array(RETAINED_BYTES);
    fillWithIncompressibleBytes(retained);
    const after = readMemoryFootprint().bytes;

    expect(after - before).toBeGreaterThanOrEqual(MINIMUM_OBSERVED_GROWTH_BYTES);
    expect(retained.length).toBe(RETAINED_BYTES);
  });
});
