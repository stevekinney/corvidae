import { describe, expect, test } from 'bun:test';

import { SHARED_KEY_FAMILIES_OF_A_CHAT } from '@lostgradient/bureau';

import { MANAGED_KEY_PREFIXES } from '../../host/host-storage.ts';
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

describe('the keys the application manages beyond the Bureau\u2019s own', () => {
  const served = MANAGED_KEY_PREFIXES;

  test.each([
    ['a session body', 'agent-session:s-1'],
    ['a session body, second layout', 'agent-session-v2:body:s-1'],
    ['a durable run', 'durable-run:run-1:cursor'],
    ['the Weft schema version', 'weft:schema-version'],
    ['a governed memory record', 'app:agent-bureau:memory:v1:record-1'],
    ['a memory vector', 'app:agent-bureau:memory-vectors:v1:record-1'],
    ['the memory governance ledger', 'app:agent-bureau:memory-governance:v1:event-1'],
  ])('refuses to edit or delete %s', (_name, key) => {
    expect(isManagedKey(key, served)).toBe(true);
    expect(() => assertWritable(key, served, () => 'managed')).toThrow(WriteRefusedError);
  });

  test('covers every family the Bureau shares with the engine and the session store', () => {
    expect(SHARED_KEY_FAMILIES_OF_A_CHAT.length).toBeGreaterThan(0);
    for (const family of SHARED_KEY_FAMILIES_OF_A_CHAT) {
      expect(isManagedKey(`${family.prefix}x`, served), family.prefix).toBe(true);
    }
  });

  test('leaves the application\u2019s own records writable, which the seed tells operators to delete', () => {
    expect(isManagedKey('app:interborough:seed-marker', served)).toBe(false);
    expect(() =>
      assertWritable('app:interborough:seed-marker', served, () => 'managed'),
    ).not.toThrow();
  });
});
