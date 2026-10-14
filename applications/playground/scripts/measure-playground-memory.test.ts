import { describe, expect, it } from 'bun:test';

import {
  captureMemoryPressure,
  footprintCategorySeries,
  parseFootprint,
  parseFootprintSize,
  parseVmStat,
} from './measure-playground-memory.ts';

const footprintOutput = `======================================================================
bun [4242]: 64-bit    Footprint: 3986 MB (16384 bytes per page)
======================================================================

  Dirty      Clean  Reclaimable    Regions    Category
    ---        ---          ---        ---    ---
3200 MB        0 B          0 B        410    JS VM Gigacage
 512 MB     16 KB       1.5 MB         12    Malloc Small
 120 KB        0 B          0 B          1    page table
    0 B     544 KB          0 B         86    __TEXT
    0 B        0 B          0 B          1    mapped file
    ---        ---          ---        ---    ---
3712 MB     560 KB       1.5 MB        510    TOTAL
`;

describe('parseFootprintSize', () => {
  it('converts footprint units to bytes', () => {
    expect(parseFootprintSize('0 B')).toBe(0);
    expect(parseFootprintSize('576 KB')).toBe(576 * 1024);
    expect(parseFootprintSize('1.5 MB')).toBe(1.5 * 1024 ** 2);
    expect(parseFootprintSize('2 GB')).toBe(2 * 1024 ** 3);
  });

  it('refuses an unknown unit', () => {
    expect(() => parseFootprintSize('3 TB')).toThrow(RangeError);
  });
});

describe('parseFootprint', () => {
  it('reads the total and every category, skipping the TOTAL row', () => {
    const footprint = parseFootprint(footprintOutput);
    expect(footprint.footprintBytes).toBe(3986 * 1024 ** 2);
    expect(Object.keys(footprint.categories)).toEqual([
      'JS VM Gigacage',
      'Malloc Small',
      'page table',
      '__TEXT',
      'mapped file',
    ]);
    expect(footprint.categories['Malloc Small']).toEqual({
      dirtyBytes: 512 * 1024 ** 2,
      cleanBytes: 16 * 1024,
      reclaimableBytes: 1.5 * 1024 ** 2,
      regions: 12,
    });
  });

  it('refuses output without a total', () => {
    expect(() => parseFootprint('nothing here')).toThrow(RangeError);
  });
});

describe('parseVmStat', () => {
  it('turns page counts into bytes and keeps swap counters', () => {
    const output = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   226575.
Pages active:                                1465227.
Pages inactive:                              1462561.
Pages wired down:                             336202.
Pages occupied by compressor:                 647571.
Swapins:                                     8014692.
Swapouts:                                    9907158.
`;
    expect(parseVmStat(output)).toEqual({
      pageSizeBytes: 16_384,
      freeBytes: 226_575 * 16_384,
      activeBytes: 1_465_227 * 16_384,
      inactiveBytes: 1_462_561 * 16_384,
      wiredBytes: 336_202 * 16_384,
      occupiedByCompressorBytes: 647_571 * 16_384,
      swapins: 8_014_692,
      swapouts: 9_907_158,
    });
  });

  it('returns null for output without a page size', () => {
    expect(parseVmStat('unavailable')).toBeNull();
  });
});

describe('footprintCategorySeries', () => {
  const reading = (total: number, malloc: number, extra?: number) => ({
    footprintBytes: total,
    categories: {
      'Malloc Small': { dirtyBytes: malloc, cleanBytes: 0, reclaimableBytes: 0, regions: 1 },
      ...(extra === undefined
        ? {}
        : { 'mapped file': { dirtyBytes: extra, cleanBytes: 0, reclaimableBytes: 0, regions: 1 } }),
    },
  });

  it('builds a dirty-bytes series for each category every checkpoint reports', () => {
    expect(footprintCategorySeries([reading(10, 4, 1), reading(12, 6)])).toEqual({
      'footprint total': [10, 12],
      'footprint Malloc Small dirty': [4, 6],
    });
  });

  it('reports nothing when any checkpoint lacks a footprint', () => {
    expect(footprintCategorySeries([reading(10, 4), null])).toEqual({});
  });
});

describe('captureMemoryPressure (4273630258)', () => {
  it('returns nulls without spawning anything off macOS', () => {
    let spawned = 0;
    const pressure = captureMemoryPressure({
      platform: 'linux',
      run: () => {
        spawned += 1;
        return { exitCode: 0, stdout: '' };
      },
    });
    expect(pressure).toEqual({ availablePercentage: null, vmStat: null });
    expect(spawned).toBe(0);
  });

  it('returns nulls when a tool cannot be spawned', () => {
    const pressure = captureMemoryPressure({
      platform: 'darwin',
      run: () => {
        throw Object.assign(new Error('spawn vm_stat ENOENT'), { code: 'ENOENT' });
      },
    });
    expect(pressure).toEqual({ availablePercentage: null, vmStat: null });
  });
});
