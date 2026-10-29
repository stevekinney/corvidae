import { describe, expect, test } from 'bun:test';
import { mapEnum } from './catalog-mapping.ts';

describe('mapEnum', () => {
  test('throws when the default is only an inherited key of the value table', () => {
    const mapping = { values: { a: 'a' }, default: 'constructor' };
    expect(() => mapEnum(mapping, 'Example', undefined, () => {})).toThrow(
      'Example has no mapping for its default',
    );
  });

  test('reports an inherited key as unsupported and uses the default', () => {
    const messages: string[] = [];
    const mapping = { values: { a: 'first', b: 'second' }, default: 'a' };
    expect(mapEnum(mapping, 'Example', '__proto__', (message) => messages.push(message))).toBe(
      'first',
    );
    expect(messages).toEqual(['Example "__proto__" is not supported; using "a"']);
  });
});
