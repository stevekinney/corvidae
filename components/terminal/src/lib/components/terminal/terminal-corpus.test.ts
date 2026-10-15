import {
  CORPUS,
  REQUIRED_CORPUS_FIXTURE_IDS,
  SUPPLEMENTARY_CORPUS_FIXTURE_IDS,
  byteByByteChunks,
  seededPartitions,
  twoChunkSplits,
} from '@lostgradient/ventriloquist';
import { describe, expect, test } from 'bun:test';

import {
  ALL_CASES,
  CORPUS_ORACLES,
  RENDERER_CASES,
  createCapturedEngine,
  type ScreenOracle,
} from './terminal-corpus-test-support.ts';

/** An engine mounted into the document, as the component mounts it, so replies match a live one. */
function mounted() {
  const host = document.createElement('div');
  document.body.append(host);
  const captured = createCapturedEngine();
  captured.engine.mount(host);
  return { captured, host };
}

/** Engines that deliver independent partitions side by side, so parse timers overlap. */
const SWEEP_WIDTH = 16;

/**
 * Deliver every partition to a fresh-state engine and compare the resulting screen with the
 * oracle. The oracle is the declared literal, never the contiguous delivery's own output.
 */
async function sweep(
  oracle: ScreenOracle,
  partitions: readonly (readonly Uint8Array[])[],
): Promise<void> {
  const engines = Array.from({ length: Math.min(SWEEP_WIDTH, partitions.length) }, mounted);
  let next = 0;
  try {
    await Promise.all(
      engines.map(async ({ captured }) => {
        for (let index = next++; index < partitions.length; index = next++) {
          captured.reset();
          await captured.deliver(partitions[index]!);
          const actual = captured.capture(oracle);
          if (!Bun.deepEquals(actual, oracle, true)) {
            const sizes = partitions[index]!.map((chunk) => chunk.length).join(',');
            throw new Error(
              `partition ${index} (chunk sizes ${sizes}) produced\n${JSON.stringify(actual)}\nexpected\n${JSON.stringify(oracle)}`,
            );
          }
        }
      }),
    );
  } finally {
    for (const { captured, host } of engines) {
      captured.engine.dispose();
      host.remove();
    }
  }
}

const SEEDED_QUARTERS = [0, 1, 2, 3] as const;

function seededQuarter(bytes: Uint8Array, quarter: number): Uint8Array[][] {
  const all = seededPartitions(bytes);
  const size = Math.ceil(all.length / SEEDED_QUARTERS.length);
  return all.slice(quarter * size, (quarter + 1) * size);
}

describe('corpus coverage', () => {
  test('declares an oracle for every corpus fixture, required and supplementary, and no other', () => {
    const corpusIds = [...REQUIRED_CORPUS_FIXTURE_IDS, ...SUPPLEMENTARY_CORPUS_FIXTURE_IDS];
    expect(Object.keys(CORPUS_ORACLES).toSorted()).toEqual(corpusIds.toSorted());
    expect(CORPUS.map((fixture) => fixture.id).toSorted()).toEqual(corpusIds.toSorted());
  });

  test('the seeded quarters together are exactly the fixed-seed partitions', () => {
    const bytes = CORPUS[0]!.bytes;
    const joined = SEEDED_QUARTERS.flatMap((quarter) => seededQuarter(bytes, quarter));
    expect(joined).toEqual(seededPartitions(bytes));
  });

  test('every case has a unique id, and the renderer adds cases beyond the corpus', () => {
    const ids = ALL_CASES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(RENDERER_CASES.length).toBeGreaterThan(0);
  });
});

describe('contiguous delivery matches the declared oracle', () => {
  test.each(ALL_CASES.map((entry) => [entry.id, entry] as const))('%s', async (_id, entry) => {
    const { captured, host } = mounted();
    await captured.deliver([entry.bytes]);
    expect(captured.capture(entry.oracle)).toEqual(entry.oracle);
    captured.engine.dispose();
    host.remove();
  });
});

describe('every chunking matches the same oracle', () => {
  test('a reset engine is empty and clear, so reused engines start fresh', async () => {
    const { captured, host } = mounted();
    const alternate = RENDERER_CASES.find((entry) => entry.id === 'alternate-screen-open')!;
    await captured.deliver([alternate.bytes]);
    expect(captured.capture(alternate.oracle).bufferType).toBe('alternate');
    captured.reset();
    const empty = { bufferType: 'normal', cursor: { x: 0, y: 0 }, lines: [] } as const;
    expect(captured.capture(empty)).toEqual(empty);
    const attributes = RENDERER_CASES.find((entry) => entry.id === 'dim-bold-inverse')!;
    await captured.deliver([attributes.bytes]);
    expect(captured.capture(attributes.oracle)).toEqual(attributes.oracle);
    captured.engine.dispose();
    host.remove();
  });

  describe.each(ALL_CASES.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    test('under every two-chunk split', () => sweep(entry.oracle, twoChunkSplits(entry.bytes)));

    test('one byte at a time', () => sweep(entry.oracle, [byteByByteChunks(entry.bytes)]));

    test('under the fixed-seed partitions', () =>
      sweep(entry.oracle, seededPartitions(entry.bytes)));

    if (entry.declaredChunks !== undefined) {
      const declared = entry.declaredChunks;
      test('under the chunks the fixture declares, empty ones included', () =>
        sweep(entry.oracle, [declared]));
    }
  });
});
