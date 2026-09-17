import { describe, expect, test } from 'bun:test';
import { collectEntries, type CorpusEntry } from './corpus.ts';
import { assertUniqueCssProperties } from './css-support.ts';
import { createValueResolver, mergeAndExpandExtends } from './resolve.ts';
import type { TokenDocument } from './types.ts';
const collect = (documents: TokenDocument[]): Map<string, CorpusEntry> => {
  const entries = new Map<string, CorpusEntry>();
  collectEntries(mergeAndExpandExtends(documents), '', undefined, entries);
  return entries;
};

describe('CIN-483: duplicate cssProperty checks use emitted values', () => {
  test('property aliases resolving to the same value may share a property', () => {
    const documents: TokenDocument[] = [
      {
        dimension: {
          $type: 'dimension',
          a: { $value: { value: 1, unit: 'rem' } },
          b: { $value: { value: 1, unit: 'rem' } },
        },
        first: {
          $type: 'number',
          $ref: '#/dimension/a/$value/value',
          $extensions: { 'com.lostgradient.cinder': { cssProperty: '--cinder-shared' } },
        },
        second: {
          $type: 'number',
          $ref: '#/dimension/b/$value/value',
          $extensions: { 'com.lostgradient.cinder': { cssProperty: '--cinder-shared' } },
        },
      },
    ];
    const entries = collect(documents);
    expect(() =>
      assertUniqueCssProperties(entries, entries, createValueResolver(documents)),
    ).not.toThrow();
  });

  test('whole-token aliases resolving to the same value may share a property', () => {
    const documents: TokenDocument[] = [
      {
        targetA: {
          $type: 'number',
          $value: 1,
          $extensions: { 'com.lostgradient.cinder': { cssProperty: '--cinder-target' } },
        },
        targetB: {
          $type: 'number',
          $value: 1,
          $extensions: { 'com.lostgradient.cinder': { cssProperty: '--cinder-target' } },
        },
        first: {
          $ref: '#/targetA',
          $extensions: { 'com.lostgradient.cinder': { cssProperty: '--cinder-shared' } },
        },
        second: {
          $ref: '#/targetB',
          $extensions: { 'com.lostgradient.cinder': { cssProperty: '--cinder-shared' } },
        },
      },
    ];
    const entries = collect(documents);
    expect(() =>
      assertUniqueCssProperties(entries, entries, createValueResolver(documents)),
    ).not.toThrow();
  });
});
