import { describe, expect, test } from 'bun:test';

import type { SnapshotView } from './inspection-controller.ts';
import { describeExport, describeSearch, describeSnapshot } from './inspection-copy.ts';
import type { SearchView } from './search.ts';
import { captureSnapshot } from './snapshot.ts';

const base: SearchView = {
  status: 'matches',
  count: 3,
  index: undefined,
  capped: false,
  truncated: false,
  wrapped: false,
  excerpt: undefined,
};

describe('describeSearch', () => {
  test('says nothing before a query, and names each refusal', () => {
    expect(describeSearch({ ...base, status: 'idle' })).toBe('');
    expect(describeSearch({ ...base, status: 'too-long' })).toBe(
      'The search is longer than 256 characters.',
    );
    expect(describeSearch({ ...base, status: 'unavailable' })).toBe('Output unavailable.');
    expect(describeSearch({ ...base, status: 'no-matches', count: 0 })).toBe('No matches.');
  });

  test('counts matches before one is active, in the singular and the plural, and when capped', () => {
    expect(describeSearch({ ...base, count: 1 })).toBe('1 match.');
    expect(describeSearch({ ...base, count: 1234 })).toBe('1,234 matches.');
    expect(describeSearch({ ...base, count: 10_000, capped: true })).toBe(
      'More than 10,000 matches.',
    );
  });

  test('reports the active index and count, a wrap, a cap and a bounded search', () => {
    expect(describeSearch({ ...base, index: 1 })).toBe('Match 2 of 3.');
    expect(describeSearch({ ...base, index: 0, wrapped: true })).toBe(
      'Match 1 of 3, wrapped around.',
    );
    expect(describeSearch({ ...base, index: 0, capped: true })).toBe('Match 1 of 3 or more.');
    expect(describeSearch({ ...base, index: 0, truncated: true })).toBe(
      'Match 1 of 3. Only the first 1,048,576 bytes were searched.',
    );
    expect(describeSearch({ ...base, status: 'no-matches', count: 0, truncated: true })).toContain(
      'Only the first',
    );
  });
});

function viewOf(
  text: string,
  overrides: Partial<SnapshotView> = {},
  truncated = false,
): SnapshotView {
  return {
    snapshot: captureSnapshot({ text, truncated, bytes: text.length }, 1),
    stale: false,
    replaced: false,
    refreshable: true,
    linksActive: true,
    ...overrides,
  };
}

describe('describeSnapshot', () => {
  test('has nothing to say about a fresh, complete snapshot', () => {
    expect(describeSnapshot(viewOf('text'))).toEqual([]);
  });

  test('names empty, truncated with the bounds, stale, and replaced', () => {
    expect(describeSnapshot(viewOf(''))).toEqual(['No retained output.']);
    expect(describeSnapshot(viewOf('abc', {}, true))).toEqual([
      'Snapshot truncated: the first 3 bytes are shown. The terminal keeps at most 10,000 lines.',
    ]);
    expect(describeSnapshot(viewOf('a', { stale: true }))).toEqual([
      'Snapshot stale: the terminal has changed since it was taken.',
    ]);
    expect(describeSnapshot(viewOf('a', { stale: true, replaced: true }))).toEqual([
      'Snapshot stale: the session was replaced, so this snapshot cannot be refreshed.',
    ]);
  });
});

describe('describeExport', () => {
  test('states the size, and the limits when it was cut', () => {
    expect(
      describeExport({ text: 'ab', truncated: false, exportedBytes: 2, retainedBytes: 2 }),
    ).toBe('Export ready: 2 bytes of plain text.');
    const cut = describeExport({
      text: 'ab',
      truncated: true,
      exportedBytes: 2,
      retainedBytes: 99,
    });
    expect(cut).toContain('2 of at least 99 retained bytes');
    expect(cut).toContain('1,048,576 bytes or 10,000 lines');
    expect(cut).toContain('nothing is added to mark the cut');
  });
});
