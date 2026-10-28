/**
 * Regression tests for one defect class: a plain-object lookup answering for a name every object
 * inherits. Each case uses `constructor` where a caller-chosen name is looked up, so a read that
 * skips `Object.hasOwn` finds `Object` and treats it as a declared entry.
 *
 * The check in `scripts/check-inherited-key-reads.ts` keeps new reads of this kind out of `src`.
 */

import { describe, expect, test } from 'bun:test';

import { createOwnedGoalEngine } from './goal-ownership';
import { mediaInputModesOf, mediaOutputModesOf } from './http/a2a-agent-card';
import { ownEntry } from './own-entry';
import { readEnvironmentVariable } from './skills/environment-configuration';

describe('ownEntry', () => {
  test('reads an own entry and nothing a record inherits', () => {
    const record = JSON.parse('{"run-1":"owner","constructor":"own"}') as Record<string, string>;
    expect(ownEntry(record, 'run-1')).toBe('owner');
    expect(ownEntry(record, 'constructor')).toBe('own');
    expect(ownEntry({ 'run-1': 'owner' }, 'constructor')).toBeUndefined();
    expect(ownEntry({ 'run-1': 'owner' }, 'toString')).toBeUndefined();
  });
});

describe('a backend descriptor that names a modality constructor', () => {
  test('advertises no media types for it', () => {
    const descriptors = [{ modalities: { constructor: { input: true, output: true } } }];
    expect(mediaOutputModesOf(descriptors)).toEqual(['text/plain']);
    expect(mediaInputModesOf(descriptors, undefined)).toEqual(mediaInputModesOf([], undefined));
  });
});

describe('an environment variable named constructor', () => {
  test('is not set', () => {
    expect(readEnvironmentVariable('constructor')).toBeUndefined();
  });
});

describe('an owned goal engine', () => {
  test('answers for the engine it wraps when asked for a name every object inherits', () => {
    class FakeEngine {
      readonly marker = 'engine';
    }
    const engine = new FakeEngine();
    const owned = createOwnedGoalEngine(
      engine as unknown as Parameters<typeof createOwnedGoalEngine>[0],
      async () => ({ status: 'absent' }) as never,
      async () => undefined as never,
    );
    expect((owned as unknown as { constructor: { name: string } }).constructor.name).toContain(
      'FakeEngine',
    );
  });
});
