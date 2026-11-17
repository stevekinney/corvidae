import { describe, expect, test } from 'bun:test';

import type { CorpusEntry } from './corpus.ts';
import { DEFERRED_COMPONENT_ALIAS_FAMILIES } from './css-configuration.ts';
import {
  assertUniqueOverrideCssProperties,
  isRootDeclaredEntry,
  renderBaseDeclarations,
  renderOverrideDeclarations,
} from './css-support.ts';
import { buildTokenRegistryFromIndexes, serializeTokenRegistry } from './registry.ts';
import { serializeEntryValue } from './value-entry.ts';
import { serializeTypedValue } from './value-formatters.ts';

function entry(path: string, overrides: Partial<CorpusEntry> = {}): CorpusEntry {
  return {
    path,
    value: '1px',
    type: 'dimension',
    description: undefined,
    cssProperty: `--cinder-${path}`,
    cssRecipe: undefined,
    public: true,
    ...overrides,
  };
}

const identity = (value: unknown) => value;

describe('color serialization', () => {
  const color = (extra: Record<string, unknown>) =>
    serializeTypedValue(
      'color',
      { colorSpace: 'srgb', components: [0.1, 0.2, 0.3], ...extra },
      'c',
    );

  test('keeps a hex literal that cannot be written in shorthand as it is', () => {
    expect(color({ hex: '#123456' })).toBe('#123456');
    expect(color({ hex: '#FFFFFF' })).toBe('#fff');
  });

  test('refuses a color space it has no serialization for, naming the space', () => {
    expect(() =>
      serializeTypedValue('color', { colorSpace: 'cmyk', components: [0, 0, 0] }, 'c'),
    ).toThrow('No direct CSS serialization implemented for color colorSpace "cmyk"');
  });
});

describe('typed value serialization', () => {
  test('refuses a value that is not the shape its type declares, naming the token', () => {
    expect(() => serializeTypedValue('dimension', 'wide', 'size.wide')).toThrow(
      'Token at "size.wide" has $type "dimension" but its $value is not a valid {value, unit} dimension.',
    );
    expect(() => serializeTypedValue('duration', 'slow', 'motion.slow')).toThrow(
      'Token at "motion.slow" has $type "duration" but its $value is not a valid {value, unit} duration.',
    );
    expect(() => serializeTypedValue('fontFamily', 7, 'font.body')).toThrow(
      'Token at "font.body" has $type "fontFamily" but its $value is not a valid string | string[] font family.',
    );
  });
});

describe('component alias declarations', () => {
  const alias = (overrides: Partial<CorpusEntry> = {}) =>
    entry('button.fill', { component: 'button', value: '{color.fill}', ...overrides });

  test('declares every entry at the root while no component family defers its aliases', () => {
    expect(isRootDeclaredEntry(alias())).toBe(true);
  });

  test('defers a bare alias of a deferred family and nothing else', () => {
    DEFERRED_COMPONENT_ALIAS_FAMILIES.add('button');
    try {
      expect(isRootDeclaredEntry(alias())).toBe(false);
      expect(isRootDeclaredEntry(alias({ cssRecipe: 'literal' }))).toBe(true);
      expect(isRootDeclaredEntry(alias({ value: '1px' }))).toBe(true);
      expect(isRootDeclaredEntry(alias({ component: 'card' }))).toBe(true);
    } finally {
      DEFERRED_COMPONENT_ALIAS_FAMILIES.delete('button');
    }
  });
});

describe('override property uniqueness', () => {
  test('lets a failure that is not an Error through unchanged', () => {
    const overrides = new Map([
      ['a', entry('a', { cssProperty: '--shared' })],
      ['b', entry('b', { cssProperty: '--shared' })],
    ]);
    const failure = 'resolver gave up';
    let thrown: unknown;
    try {
      assertUniqueOverrideCssProperties(overrides, new Map(), new Map(), 'dark', () => {
        throw failure;
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
  });
});

describe('entry serialization', () => {
  test('refuses an entry with neither a type nor a recipe', () => {
    expect(() => serializeEntryValue(entry('plain', { type: undefined }), new Map())).toThrow(
      'Token at "plain" has no $type and no cssRecipe; cannot serialize.',
    );
  });
});

describe('stylesheet declaration rendering', () => {
  test('rejects a base token that declares no custom property', () => {
    const base = new Map([['a', entry('a', { cssProperty: undefined })]]);
    expect(() => renderBaseDeclarations(base, identity)).toThrow(
      'Base corpus token at "a" has no cssProperty extension.',
    );
  });

  test('rejects an override with no matching base token', () => {
    const overrides = new Map([['a', entry('a')]]);
    expect(() => renderOverrideDeclarations(overrides, new Map(), identity)).toThrow(
      'Override token at "a" has no matching base token with a cssProperty.',
    );
  });
});

describe('the token registry', () => {
  const build = (...entries: CorpusEntry[]) =>
    buildTokenRegistryFromIndexes(
      new Map(entries.map((candidate) => [candidate.path, candidate])),
      new Set(),
    );

  test.each([
    ['no cssProperty', { cssProperty: undefined }, 'has no cssProperty extension'],
    ['no public flag', { public: undefined }, 'has no public extension'],
    ['a blank category', { category: '  ' }, 'has a blank category extension'],
    ['a blank component', { component: '' }, 'has a blank component extension'],
  ])('rejects a base token with %s', (_label, overrides, message) => {
    expect(() => build(entry('a', overrides))).toThrow(message);
  });

  test('serializes to the JSON the generator commits', () => {
    const registry = build(entry('a', { category: 'space', component: 'card' }));
    expect(JSON.parse(serializeTokenRegistry(registry))).toEqual(
      JSON.parse(JSON.stringify(registry)),
    );
    expect(registry.entries.map((candidate) => candidate.cssProperty)).toEqual(['--cinder-a']);
  });
});
