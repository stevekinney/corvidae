import { describe, expect, it } from 'bun:test';

import {
  normalizeDeleteRangeOptions,
  resolveDeleteRangeBounds,
  storageDeleteRange,
  type DeleteRangeOptions,
} from './delete-range.ts';
import type { Storage } from './interface.ts';
import { MemoryStorage } from './memory.ts';

function bounds(prefix: string, options: DeleteRangeOptions) {
  return resolveDeleteRangeBounds(prefix, normalizeDeleteRangeOptions(options));
}

describe('normalizeDeleteRangeOptions', () => {
  it('refuses a bound that is not a string', () => {
    expect(() => normalizeDeleteRangeOptions({ lt: 3 as unknown as string })).toThrow(
      'deleteRange bounds must be strings',
    );
  });

  it('refuses a limit that is not a non-negative integer', () => {
    for (const limit of [-1, 1.5, Number.NaN, '2' as unknown as number]) {
      expect(() => normalizeDeleteRangeOptions({ lt: 'b', limit })).toThrow(
        'deleteRange limit must be a finite non-negative integer',
      );
    }
  });

  it('normalizes a negative-zero limit to zero', () => {
    expect(Object.is(normalizeDeleteRangeOptions({ lt: 'b', limit: -0 }).limit, 0)).toBe(true);
  });
});

describe('resolveDeleteRangeBounds', () => {
  it('starts inclusive at the prefix and ends exclusive at the prefix end', () => {
    expect(bounds('ev:', { gte: 'ev:' })).toEqual({
      lower: { key: 'ev:', open: false },
      upper: { key: 'ev;', open: true },
    });
  });

  it('lets the stricter side win when gt and gte meet at one key', () => {
    expect(bounds('ev:', { gte: 'ev:5', gt: 'ev:5' })?.lower).toEqual({ key: 'ev:5', open: true });
    expect(bounds('ev:', { gte: 'ev:7', gt: 'ev:5' })?.lower).toEqual({ key: 'ev:7', open: false });
  });

  it('tightens the upper bound by lt and lte', () => {
    expect(bounds('ev:', { lt: 'ev:5' })?.upper).toEqual({ key: 'ev:5', open: true });
    expect(bounds('ev:', { lte: 'ev:5' })?.upper).toEqual({ key: 'ev:5', open: false });
    expect(bounds('ev:', { lt: 'ev:5', lte: 'ev:5' })?.upper).toEqual({ key: 'ev:5', open: true });
    expect(bounds('ev:', { lt: 'ev:7', lte: 'ev:5' })?.upper).toEqual({ key: 'ev:5', open: false });
  });

  it('leaves the upper bound open for an empty prefix with no upper option', () => {
    expect(bounds('', { gt: 'a' })).toEqual({ lower: { key: 'a', open: true }, upper: undefined });
    expect(bounds('', { lte: 'm' })?.upper).toEqual({ key: 'm', open: false });
  });

  it('reports an impossible range as null', () => {
    expect(bounds('ev:', { gt: 'ev:5', lt: 'ev:3' })).toBeNull();
    expect(bounds('ev:', { gt: 'ev:5', lte: 'ev:5' })).toBeNull();
    expect(bounds('ev:', { gte: 'ev:5', lt: 'ev:5' })).toBeNull();
    expect(bounds('ev:', { gte: 'ev:5', lte: 'ev:5' })).toEqual({
      lower: { key: 'ev:5', open: false },
      upper: { key: 'ev:5', open: false },
    });
  });
});

describe('storageDeleteRange', () => {
  it('deletes through the scan fallback when the adapter has no deleteRange', async () => {
    await using memory = new MemoryStorage();
    const storage: Storage = {
      capabilities: () => memory.capabilities(),
      get: (key) => memory.get(key),
      put: (key, value) => memory.put(key, value),
      delete: (key) => memory.delete(key),
      scan: (prefix, options) => memory.scan(prefix, options),
      batch: (operations) => memory.batch(operations),
      [Symbol.dispose]: () => {},
    };
    for (const key of ['ev:1', 'ev:2', 'ev:3']) await memory.put(key, new Uint8Array([1]));

    expect(await storageDeleteRange(storage, 'ev:', { lt: 'ev:3' })).toBe(2);
    expect(await memory.get('ev:3')).not.toBeNull();
    expect(await memory.get('ev:1')).toBeNull();
  });
});
