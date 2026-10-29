import { describe, expect, it } from 'bun:test';

import {
  decodeStorageKeyComponent,
  encodeStorageKeyComponent,
  formatSortableStorageTimestamp,
  tryDecodeStorageKeyComponent,
} from './key-encoding.ts';

describe('storage key encoding', () => {
  it('round-trips a component that contains the key delimiter', () => {
    const encoded = encodeStorageKeyComponent('order:42/é');
    expect(encoded).not.toContain(':');
    expect(decodeStorageKeyComponent(encoded)).toBe('order:42/é');
  });

  it('returns null instead of throwing for a malformed component', () => {
    expect(tryDecodeStorageKeyComponent('%E0%A4%A')).toBeNull();
    expect(tryDecodeStorageKeyComponent('plain%20text')).toBe('plain text');
    expect(() => decodeStorageKeyComponent('%E0%A4%A')).toThrow(URIError);
  });

  it('pads timestamps to sixteen digits so they sort lexicographically', () => {
    expect(formatSortableStorageTimestamp(42)).toBe('0000000000000042');
    expect(
      formatSortableStorageTimestamp(1_700_000_000_000) > formatSortableStorageTimestamp(9),
    ).toBe(true);
  });
});
