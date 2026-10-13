import { describe, expect, test } from 'bun:test';
import { collectEntries, type CorpusEntry } from '../../src/tokens/runtime/corpus.ts';
import { assertUniqueCssProperties } from '../../src/tokens/runtime/css-support.ts';
import { serializeEntryValue } from '../../src/tokens/runtime/value-entry.ts';
function entry(path: string, type: 'fontFamily' | 'fontWeight'): CorpusEntry {
  return {
    path,
    value: 'normal',
    type,
    description: undefined,
    cssProperty: '--cinder-test-normal',
    cssRecipe: undefined,
    public: true,
    category: 'typography',
    component: undefined,
    deprecated: undefined,
  };
}

describe('CIN-463 review: collectEntries recognizes $ref tokens, not only $value', () => {
  // Regression: `generate.ts` kept its OWN `isToken` copy, independent of
  // resolve.ts's (which CIN-463 already fixed) -- checking `$value` alone
  // classified a `$ref`-only node as an (empty) group, so it silently
  // vanished from `tokens-base.css` and the generated registry (both walk
  // the raw corpus via `collectEntries`) even though it validated and
  // resolved correctly.
  test('a $ref token is not dropped from the collected entries', () => {
    const into = new Map<string, CorpusEntry>();
    collectEntries(
      {
        base: {
          $value: 1,
          $extensions: { 'com.lostgradient.cinder': { cssProperty: '--cinder-base' } },
        },
        copy: {
          $ref: '#/base',
          $extensions: { 'com.lostgradient.cinder': { cssProperty: '--cinder-copy' } },
        },
      },
      '',
      undefined,
      into,
    );

    expect(into.has('copy')).toBe(true);
    expect(into.get('copy')?.value).toBe('#/base');
  });

  test('a $ref token in a base index resolves to the referenced cssProperty via var()', () => {
    const baseIndex = new Map<string, CorpusEntry>();
    collectEntries(
      {
        base: {
          $type: 'number',
          $value: 1,
          $extensions: { 'com.lostgradient.cinder': { cssProperty: '--cinder-base' } },
        },
        copy: {
          $ref: '#/base',
          $extensions: { 'com.lostgradient.cinder': { cssProperty: '--cinder-copy' } },
        },
      },
      '',
      undefined,
      baseIndex,
    );

    const copyEntry = baseIndex.get('copy');
    expect(copyEntry).toBeDefined();
    expect(serializeEntryValue(copyEntry!, baseIndex)).toBe('var(--cinder-base)');
  });
});

describe('CIN-30 review round 14: the uniqueness key includes $type', () => {
  // Serialization is type-directed: `fontFamily: "normal"` emits `normal` while
  // `fontWeight: "normal"` emits `400`. Hashing only the raw $value called this
  // pair identical, so the first-claimant docs index documented one form while
  // the CSS and the drift test's last-write map used the other -- regeneration
  // then produced documentation the required drift test rejected.
  test('two entries sharing a value but differing in type are a conflict', () => {
    const entries = new Map<string, CorpusEntry>([
      ['type.family', entry('type.family', 'fontFamily')],
      ['type.weight', entry('type.weight', 'fontWeight')],
    ]);

    expect(() => assertUniqueCssProperties(entries)).toThrow(
      /--cinder-test-normal is claimed with conflicting values by type\.family, type\.weight/,
    );
  });

  test('two entries agreeing on value AND type are still permitted', () => {
    const entries = new Map<string, CorpusEntry>([
      ['type.family', entry('type.family', 'fontFamily')],
      ['type.alias', entry('type.alias', 'fontFamily')],
    ]);

    expect(() => assertUniqueCssProperties(entries)).not.toThrow();
  });

  test('two entries that emit the same text but differ in type are a conflict', () => {
    const numberEntry: CorpusEntry = {
      ...entry('type.number', 'fontWeight'),
      value: 1,
      type: 'number',
    };
    const weightEntry: CorpusEntry = {
      ...entry('type.weight', 'fontWeight'),
      value: 1,
    };
    const entries = new Map<string, CorpusEntry>([
      ['type.number', numberEntry],
      ['type.weight', weightEntry],
    ]);

    expect(() => assertUniqueCssProperties(entries)).toThrow(/conflicting values/);
  });
});
