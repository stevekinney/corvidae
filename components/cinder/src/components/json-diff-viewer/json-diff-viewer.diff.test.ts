import { describe, expect, test } from 'bun:test';

import { requiredValue } from '@lostgradient/testing';

import {
  ROOT_KEY,
  diffJsonValues,
  previewJsonValue,
  type JsonDiffEntry,
} from './json-diff-viewer.diff.ts';

function kinds(entries: readonly JsonDiffEntry[]): string[] {
  return entries.map((entry) => `${entry.kind}:${entry.key}`);
}

describe('diffJsonValues', () => {
  test('equal values have no changes', () => {
    expect(diffJsonValues({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }).changes).toEqual([]);
    expect(diffJsonValues(3, 3).changes).toEqual([]);
    expect(diffJsonValues(null, null).changes).toEqual([]);
  });

  test('splits added, removed, changed and unchanged object keys, keeping key order', () => {
    const level = diffJsonValues({ kept: 1, edited: 1, gone: 1 }, { kept: 1, edited: 2, fresh: 1 });
    expect(kinds(level.changes)).toEqual(['changed:edited', 'removed:gone', 'added:fresh']);
    expect(kinds(level.unchanged)).toEqual(['unchanged:kept']);
    expect(level.changes[0]).toMatchObject({ before: '1', after: '2' });
  });

  test('nests a change inside an unchanged-looking parent to any depth', () => {
    const level = diffJsonValues({ a: { b: { c: { d: 1 } } } }, { a: { b: { c: { d: 2 } } } });
    let entry = requiredValue(level.changes[0]);
    const path = [entry.key];
    while (entry.children !== undefined) {
      entry = requiredValue(entry.children.changes[0]);
      path.push(entry.key);
    }
    expect(path).toEqual(['a', 'b', 'c', 'd']);
    expect(entry).toMatchObject({ kind: 'changed', before: '1', after: '2' });
  });

  test('compares arrays by index', () => {
    const level = diffJsonValues([1, 2, 3], [1, 9]);
    expect(kinds(level.changes)).toEqual(['changed:1', 'removed:2']);
    expect(kinds(level.unchanged)).toEqual(['unchanged:0']);
    expect(kinds(diffJsonValues([1], [1, 2]).changes)).toEqual(['added:1']);
  });

  test('shows a type change as one removed and one added entry', () => {
    const level = diffJsonValues({ value: 1 }, { value: '1' });
    expect(level.changes).toHaveLength(2);
    expect(level.changes[0]).toMatchObject({ kind: 'removed', key: 'value', before: '1' });
    expect(level.changes[1]).toMatchObject({ kind: 'added', key: 'value', after: '"1"' });
    expect(level.changes[0]?.id).not.toBe(level.changes[1]?.id);
  });

  test('treats an object becoming an array, and null becoming an object, as a type change', () => {
    expect(kinds(diffJsonValues({ v: {} }, { v: [] }).changes)).toEqual(['removed:v', 'added:v']);
    expect(kinds(diffJsonValues({ v: null }, { v: {} }).changes)).toEqual(['removed:v', 'added:v']);
  });

  test('handles values that are not collections at the root', () => {
    expect(kinds(diffJsonValues('a', 'b').changes)).toEqual([`changed:${ROOT_KEY}`]);
    expect(kinds(diffJsonValues({ a: 1 }, [1]).changes)).toEqual([
      `removed:${ROOT_KEY}`,
      `added:${ROOT_KEY}`,
    ]);
  });

  test('treats an undefined property as absent, as JSON does', () => {
    expect(diffJsonValues({ a: undefined }, {}).changes).toEqual([]);
    expect(kinds(diffJsonValues({}, { a: undefined, b: 1 }).changes)).toEqual(['added:b']);
  });

  test('compares collections past maxDepth whole instead of walking them', () => {
    const before = { a: { b: { c: 1 } } };
    const after = { a: { b: { c: 2 } } };
    const level = diffJsonValues(before, after, 2);
    const inner = requiredValue(requiredValue(level.changes[0]).children?.changes[0]);
    expect(inner).toMatchObject({ kind: 'changed', key: 'b', before: '{1 key}', after: '{1 key}' });
    expect(inner.children).toBeUndefined();
    expect(diffJsonValues(before, structuredClone(before), 2).changes).toEqual([]);
  });

  test('a deeply nested value does not overflow the stack', () => {
    const nest = (depth: number, leaf: number): unknown => {
      let value: unknown = { leaf };
      for (let index = 0; index < depth; index += 1) value = { next: value };
      return value;
    };
    expect(diffJsonValues(nest(2000, 1), nest(2000, 2)).changes).toHaveLength(1);
  });
});

describe('previewJsonValue', () => {
  test('previews primitives as JSON and collections by size', () => {
    expect(previewJsonValue('a')).toBe('"a"');
    expect(previewJsonValue(null)).toBe('null');
    expect(previewJsonValue([1, 2])).toBe('[2 items]');
    expect(previewJsonValue([1])).toBe('[1 item]');
    expect(previewJsonValue({ a: 1, b: undefined })).toBe('{1 key}');
  });

  test('cuts a long string with an ellipsis', () => {
    expect(previewJsonValue('x'.repeat(500)).length).toBeLessThan(130);
    expect(previewJsonValue('x'.repeat(500)).endsWith('…')).toBe(true);
  });
});
