import { describe, expect, test } from 'bun:test';

import {
  assertWritable,
  isManagedKey,
  managedPrefix,
  WEFT_RESERVED_KEY_PREFIXES,
  WriteRefusedError,
} from './reserved-prefix.ts';

const BUREAU = ['settings', 'skill:', 'asset:v1:'];

describe('managedPrefix', () => {
  test('names the Weft prefix a managed key falls under', () => {
    expect(managedPrefix('wf:order-123', BUREAU)).toBe('wf:');
    expect(managedPrefix('lease:engine-primary', BUREAU)).toBe('lease:');
  });

  test('names the Bureau prefix a managed key falls under, whole-key entries included', () => {
    expect(managedPrefix('skill:summarize', BUREAU)).toBe('skill:');
    expect(managedPrefix('settings', BUREAU)).toBe('settings');
    expect(managedPrefix('asset:v1:abc', BUREAU)).toBe('asset:v1:');
  });

  test('is undefined for an application key', () => {
    expect(managedPrefix('app:my-service:session', BUREAU)).toBeUndefined();
    expect(managedPrefix('session:u-8841', BUREAU)).toBeUndefined();
  });

  test('every Weft prefix guards its keys, with no Bureau prefix known', () => {
    expect(WEFT_RESERVED_KEY_PREFIXES.length).toBeGreaterThan(0);
    for (const prefix of WEFT_RESERVED_KEY_PREFIXES) {
      expect(managedPrefix(`${prefix}anything`, [])).toBe(prefix);
    }
  });
});

describe('isManagedKey', () => {
  test('true for a Weft key or a Bureau key, false for an application key', () => {
    expect(isManagedKey('state:workflow-1', BUREAU)).toBe(true);
    expect(isManagedKey('skill:one', BUREAU)).toBe(true);
    expect(isManagedKey('cache:rates:usd', BUREAU)).toBe(false);
  });

  test('false for the empty key', () => {
    expect(isManagedKey('', BUREAU)).toBe(false);
  });
});

describe('assertWritable', () => {
  const say = (prefix: string | undefined) =>
    prefix === undefined ? 'unknown' : `managed ${prefix}`;

  test('lets a key of the application through once the Bureau prefixes are known', () => {
    expect(() => assertWritable('app:one', BUREAU, say)).not.toThrow();
  });

  test('refuses a Weft key and a Bureau key, naming the prefix', () => {
    expect(() => assertWritable('wf:one', BUREAU, say)).toThrow(
      new WriteRefusedError('managed wf:'),
    );
    expect(() => assertWritable('skill:one', BUREAU, say)).toThrow('managed skill:');
    expect(() => assertWritable('settings', BUREAU, say)).toThrow(WriteRefusedError);
  });

  test('refuses every key while the Bureau prefixes are unknown, even one no list names', () => {
    expect(() => assertWritable('app:one', undefined, say)).toThrow('unknown');
  });
});
