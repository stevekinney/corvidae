import { describe, expect, test } from 'bun:test';

import { A2uiDataModel, childPointer, pointerSegments, resolvePath } from './data-model.svelte.ts';

describe('the data model', () => {
  test('`/` addresses the member whose key is empty, as RFC 6901 requires', () => {
    expect(pointerSegments('')).toEqual([]);
    expect(pointerSegments('/')).toEqual(['']);
    expect(pointerSegments('/a/')).toEqual(['a', '']);

    const model = new A2uiDataModel({ '': 'empty key', other: 1 });
    expect(model.get('/')).toBe('empty key');
    expect(model.get('')).toEqual({ '': 'empty key', other: 1 });

    model.set('/', 'changed');
    expect(model.snapshot()).toEqual({ '': 'changed', other: 1 });
  });

  test('relative paths at the root resolve to the whole document', () => {
    expect(resolvePath('.', '')).toBe('');
    expect(resolvePath('', '')).toBe('');
    expect(resolvePath('name', '')).toBe('/name');
    expect(resolvePath('name', '/items/0')).toBe('/items/0/name');
    expect(childPointer('', 0)).toBe('/0');
    expect(childPointer('/items', 'a/b')).toBe('/items/a~1b');
  });
});
