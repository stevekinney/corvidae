/** The checked-in seed every reproducible partition run starts from. Changing it changes the matrix. */
export const PARTITION_SEED = 0x6f_70_65_72;

/** How many seeded partitions each fixture is delivered in. */
export const SEEDED_PARTITION_COUNT = 1000;

/** The most cut points one seeded partition uses, so partitions range from two chunks to many. */
const MAXIMUM_CUTS = 12;

/** A 32-bit generator (mulberry32). It is deterministic from its seed on every runtime. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Cut `bytes` at the given offsets, producing a fresh copy of each chunk. Equal cuts give empty chunks. */
export function partitionAt(bytes: Uint8Array, cuts: readonly number[]): Uint8Array[] {
  const boundaries = [0, ...cuts, bytes.length];
  const chunks: Uint8Array[] = [];
  for (let index = 1; index < boundaries.length; index += 1) {
    chunks.push(bytes.slice(boundaries[index - 1], boundaries[index]));
  }
  return chunks;
}

/** Every two-chunk split of `bytes`, including the two that leave one chunk empty: `length + 1` splits. */
export function twoChunkSplits(bytes: Uint8Array): Uint8Array[][] {
  return Array.from({ length: bytes.length + 1 }, (_, cut) => partitionAt(bytes, [cut]));
}

/** `bytes` delivered one byte at a time: `length` chunks. */
export function byteByByteChunks(bytes: Uint8Array): Uint8Array[] {
  return Array.from(bytes, (byte) => Uint8Array.of(byte));
}

/**
 * `count` partitions of `bytes` into two or more chunks at random cut points, which may coincide
 * and so produce empty chunks. The same seed, bytes and count always produce the same partitions.
 */
export function seededPartitions(
  bytes: Uint8Array,
  seed: number = PARTITION_SEED,
  count: number = SEEDED_PARTITION_COUNT,
): Uint8Array[][] {
  const random = createRandom(seed);
  return Array.from({ length: count }, () => {
    const cutCount = 1 + Math.floor(random() * MAXIMUM_CUTS);
    const cuts = Array.from({ length: cutCount }, () =>
      Math.floor(random() * (bytes.length + 1)),
    ).toSorted((left, right) => left - right);
    return partitionAt(bytes, cuts);
  });
}
