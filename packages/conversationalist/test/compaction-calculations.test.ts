import { describe, expect, test } from 'bun:test';

import { calculateChunkSize } from '../src/compaction/chunking';

// Manual runtime standing in for the real clock (AB-321/AB-329) — this file never asserts
// anything about a specific instant, only about compaction behavior over literal messages.

describe('summarizer-based compaction', () => {
  describe('calculateChunkSize', () => {
    test('uses base ratio for normal messages', () => {
      // avgTokens = 50, contextWindow = 10000 -> 50 < 10000 * 0.1 = 1000
      const size = calculateChunkSize(1000, 50, 10000);
      // floor(1000 * 0.4 / 1.2) = floor(333.33) = 333
      expect(size).toBe(333);
    });

    test('uses minimum ratio when average message is large', () => {
      // avgTokens = 1500, contextWindow = 10000 -> 1500 > 10000 * 0.1 = 1000
      const size = calculateChunkSize(5000, 1500, 10000);
      // floor(5000 * 0.15 / 1.2) = floor(625) = 625
      expect(size).toBe(625);
    });

    test('respects custom options', () => {
      const size = calculateChunkSize(1000, 50, 10000, {
        baseChunkRatio: 0.5,
        safetyMargin: 1.0,
      });
      // floor(1000 * 0.5 / 1.0) = 500
      expect(size).toBe(500);
    });

    test('returns at least 1', () => {
      const size = calculateChunkSize(0, 0, 10000);
      expect(size).toBeGreaterThanOrEqual(1);
    });
  });
});
