/**
 * The storage sizes the Storage use card draws (row 76n): the size reports on the engine's feed
 * inside the last 24 hours, one per moment, oldest first. A card with fewer than two draws no chart.
 */
import { describe, expect, test } from 'bun:test';

import { sampleOf, withinWindow } from './storage-sizes.svelte.ts';

const NOW = Date.UTC(2026, 10, 2, 16, 46);
const HOUR = 3_600_000;

describe('sampleOf', () => {
  test('reads a size report, and nothing else', () => {
    expect(
      sampleOf({ kind: 'storage:size-reported', emittedAtMs: 5, payload: { sizeBytes: 1024 } }),
    ).toEqual({ at: 5, bytes: 1024 });
    expect(
      sampleOf({ kind: 'alert:fired', emittedAtMs: 5, payload: { sizeBytes: 1 } }),
    ).toBeUndefined();
  });

  test('refuses a report with no usable size', () => {
    for (const payload of [
      null,
      {},
      { sizeBytes: 'big' },
      { sizeBytes: -1 },
      { sizeBytes: Number.NaN },
    ]) {
      expect(sampleOf({ kind: 'storage:size-reported', emittedAtMs: 5, payload })).toBeUndefined();
    }
  });
});

describe('withinWindow', () => {
  test('keeps the last 24 hours, one sample per moment, oldest first', () => {
    const samples = withinWindow(
      [
        { at: NOW - HOUR, bytes: 3 },
        { at: NOW - 30 * HOUR, bytes: 1 },
        { at: NOW - 5 * HOUR, bytes: 2 },
        { at: NOW - 5 * HOUR, bytes: 2 },
      ],
      NOW,
    );
    expect(samples).toEqual([
      { at: NOW - 5 * HOUR, bytes: 2 },
      { at: NOW - HOUR, bytes: 3 },
    ]);
  });
});
