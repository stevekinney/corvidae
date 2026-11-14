import { describe, expect, test } from 'bun:test';

import { sourceKeys } from './source-keys.ts';

describe('sourceKeys', () => {
  test('gives every source its own key, duplicates included', () => {
    const keys = sourceKeys([
      { label: 'Annual report', url: 'https://example.com/annual' },
      { label: 'Annual report', url: 'https://example.com/annual' },
      { label: 'Board minutes' },
    ]);
    expect(new Set(keys).size).toBe(3);
  });

  test('keeps a source key when an earlier source is withdrawn', () => {
    const kept = { label: 'Board minutes', detail: 'Page 3' };
    const before = sourceKeys([{ label: 'Annual report' }, kept]);
    const after = sourceKeys([kept]);
    expect(after[0]).toBe(before[1]);
  });
});
