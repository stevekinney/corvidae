import { describe, expect, test } from 'bun:test';

import { isIdentifierField, readPayloadEntries } from './payload-inspector-fields.ts';

describe('readPayloadEntries', () => {
  test('lists object entries in order and flags nested values', () => {
    expect(readPayloadEntries({ name: 'Ada', tags: ['a'], owner: { id: 1 }, none: null })).toEqual([
      { key: 'name', value: 'Ada', nested: false, isIndex: false },
      { key: 'tags', value: ['a'], nested: true, isIndex: false },
      { key: 'owner', value: { id: 1 }, nested: true, isIndex: false },
      { key: 'none', value: null, nested: false, isIndex: false },
    ]);
  });

  test('keys array entries by their 1-based position', () => {
    expect(readPayloadEntries(['a', 'b']).map((entry) => [entry.key, entry.isIndex])).toEqual([
      ['1', true],
      ['2', true],
    ]);
  });

  test('writes a Date as its ISO string instead of nesting it', () => {
    const [entry] = readPayloadEntries({ at: new Date('2026-10-30T14:15:07Z') });
    expect(entry).toMatchObject({ value: '2026-10-30T14:15:07.000Z', nested: false });
  });

  test('has no entries for a scalar', () => {
    expect(readPayloadEntries('text')).toEqual([]);
    expect(readPayloadEntries(null)).toEqual([]);
  });
});

describe('isIdentifierField', () => {
  test.each([
    ['userId', 'u_8f2a3b'],
    ['run_id', 'run-1'],
    ['id', 'abc'],
    ['contentHash', 'x'],
    ['any', '3f2b9c1a-7d4e-4a86-9b0c-1e5d6f7a8b90'],
    ['any', 'a'.repeat(40)],
  ])('%s = %s is an identifier', (key, value) => {
    expect(isIdentifierField(key, value)).toBe(true);
  });

  test.each([
    ['name', 'Ada'],
    ['paid', 'idle'],
    ['video', 'clip'],
    ['userId', ''],
    ['userId', 42],
    ['any', 'abcdef'],
  ])('%s = %s is not', (key, value) => {
    expect(isIdentifierField(key, value)).toBe(false);
  });
});
