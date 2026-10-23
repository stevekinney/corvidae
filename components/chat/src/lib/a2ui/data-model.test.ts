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

  test('an explicit null model stays null; only an absent one starts as {}', () => {
    expect(new A2uiDataModel(null).snapshot()).toBeNull();
    expect(new A2uiDataModel(undefined).snapshot()).toEqual({});

    const model = new A2uiDataModel({ a: 1 });
    model.replace(null);
    expect(model.snapshot()).toBeNull();
    model.replace(undefined);
    expect(model.snapshot()).toEqual({});
  });

  test('an array is written only at an index; any other token writes nothing', () => {
    const changes: unknown[] = [];
    const model = new A2uiDataModel(['first', 'second'], (value) => changes.push(value));
    for (const pointer of ['/', '/abc', '/01', '/-1', '/1.5']) model.set(pointer, 'x');
    expect(model.snapshot()).toEqual(['first', 'second']);

    const nested = new A2uiDataModel({ list: ['a'] });
    nested.set('/list/', 'x');
    nested.set('/list/name/deep', 'x');
    expect(nested.snapshot()).toEqual({ list: ['a'] });

    model.set('/1', 'changed');
    nested.set('/list/1', 'b');
    expect(model.snapshot()).toEqual(['first', 'changed']);
    expect(nested.snapshot()).toEqual({ list: ['a', 'b'] });
    expect(changes).toEqual([['first', 'changed']]);
  });
});
