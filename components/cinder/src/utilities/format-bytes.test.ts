import { describe, expect, test } from 'bun:test';

import { formatBytes } from './format-bytes.ts';

describe('formatBytes', () => {
  test('prints bytes below a kilobyte whole', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  test('keeps one decimal when the size is not a whole unit', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });

  test('prints a whole unit without a trailing .0, as the design reads 4 KB and 12 MB', () => {
    expect(formatBytes(4 * 1024)).toBe('4 KB');
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
  });
});
