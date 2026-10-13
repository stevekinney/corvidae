import { describe, expect, test } from 'bun:test';

import {
  byteByByteChunks,
  createRandom,
  PARTITION_SEED,
  partitionAt,
  SEEDED_PARTITION_COUNT,
  seededPartitions,
  twoChunkSplits,
} from './partitions.ts';

const ten = Uint8Array.from({ length: 10 }, (_, index) => index);

function listed(partitions: readonly Uint8Array[][]): number[][][] {
  return partitions.map((partition) => partition.map((chunk) => [...chunk]));
}

describe('the seeded generator', () => {
  test('is the checked-in seed, and produces the recorded sequence from it', () => {
    expect(PARTITION_SEED).toBe(1_869_636_978);
    const random = createRandom(PARTITION_SEED);
    expect([random(), random(), random()]).toEqual([
      0.2812085982877761, 0.22235642932355404, 0.06880174740217626,
    ]);
  });

  test('stays within [0, 1) and differs between seeds', () => {
    const random = createRandom(1);
    const values = Array.from({ length: 1000 }, () => random());
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(createRandom(1)()).not.toBe(createRandom(2)());
  });

  test('produces the recorded partitions for the checked-in seed', () => {
    expect(listed(seededPartitions(ten, PARTITION_SEED, 4))).toEqual([
      [[], [0, 1], [2, 3, 4], [5, 6], [7, 8, 9]],
      [[], [0, 1, 2], [3, 4], [], [5], [], [], [6, 7, 8, 9], []],
      [[], [0, 1, 2, 3, 4], [5, 6], [7], [8, 9], [], []],
      [[0, 1], [2], [3, 4, 5], [6], [], [7], [8, 9]],
    ]);
  });

  test('reproduces the same 1,000 partitions every time and covers empty and many-chunk cases', () => {
    const first = seededPartitions(ten);
    expect(first).toHaveLength(SEEDED_PARTITION_COUNT);
    expect(SEEDED_PARTITION_COUNT).toBe(1000);
    expect(listed(first)).toEqual(listed(seededPartitions(ten)));
    for (const partition of first) {
      expect(partition.length).toBeGreaterThanOrEqual(2);
      expect(Buffer.concat(partition)).toEqual(Buffer.from(ten));
    }
    expect(first.some((partition) => partition.some((chunk) => chunk.length === 0))).toBe(true);
    expect(new Set(first.map((partition) => partition.length)).size).toBeGreaterThan(5);
    expect(
      new Set(listed(first).map((partition) => JSON.stringify(partition))).size,
    ).toBeGreaterThan(500);
  });

  test('partitions an empty payload into empty chunks only', () => {
    for (const partition of seededPartitions(new Uint8Array(0), PARTITION_SEED, 5)) {
      expect(partition.every((chunk) => chunk.length === 0)).toBe(true);
    }
  });
});

describe('deterministic splits', () => {
  test('cuts at the given offsets, copying every chunk', () => {
    const chunks = partitionAt(ten, [3, 3, 7]);
    expect(listed([chunks])[0]).toEqual([[0, 1, 2], [], [3, 4, 5, 6], [7, 8, 9]]);
    chunks[0]!.fill(99);
    expect(ten[0]).toBe(0);
  });

  test('has every two-chunk split, including the two with an empty side', () => {
    const splits = twoChunkSplits(ten);
    expect(splits).toHaveLength(ten.length + 1);
    expect(splits[0]!.map((chunk) => chunk.length)).toEqual([0, 10]);
    expect(splits[10]!.map((chunk) => chunk.length)).toEqual([10, 0]);
    splits.forEach((split, cut) => {
      expect(split.map((chunk) => chunk.length)).toEqual([cut, 10 - cut]);
      expect(Buffer.concat(split)).toEqual(Buffer.from(ten));
    });
  });

  test('has one chunk per byte for byte-by-byte delivery', () => {
    const chunks = byteByByteChunks(ten);
    expect(chunks).toHaveLength(10);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(ten));
    expect(byteByByteChunks(new Uint8Array(0))).toEqual([]);
  });
});
