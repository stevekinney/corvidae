/**
 * COR-771 — replays recorded governed-memory recalls.
 *
 * A recording names a policy revision, the records to store, the query, and
 * the recall options (its retrieval plan included), together with the evidence
 * manifest the recall produced when it was recorded. The replay stores the
 * same records in a fresh governed memory with a deterministic clock and
 * identifier sequence, runs the recorded plan again, and compares manifests:
 * it passes when they match, or when every difference is one the recording
 * names in `expectedDifferences`.
 *
 *   bun scripts/replay-recall.ts <recording.json>...
 *   bun scripts/replay-recall.ts --record <recording.json>...
 *
 * `--record` rewrites each recording's `manifest` from a fresh run instead.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage } from '@lostgradient/weft';
import { z } from 'zod';

import { createMemoryAuthority } from '../src/governance/authority';
import { createGovernedMemory } from '../src/governance/governed-memory';
import type { RecallForModelOptions } from '../src/governance/governed-memory-types';
import { createMemoryGovernanceLedger } from '../src/governance/ledger';
import {
  createMemoryGovernancePolicy,
  MEMORY_CLASSES,
  MEMORY_SOURCE_KINDS,
} from '../src/governance/policy';
import {
  compareMemoryEvidenceManifests,
  memoryEvidenceManifest,
  type MemoryEvidenceManifest,
  type MemoryRecallDifference,
} from '../src/governance/recall-replay';
import { createInMemoryMemoryRecordStorage, createMockEmbedder } from '../src/test/index';

const recordingSchema = z.object({
  name: z.string().min(1),
  policyRevision: z.string().min(1),
  records: z.array(
    z.object({
      content: z.string().min(1),
      source: z.enum(MEMORY_SOURCE_KINDS),
      memoryClass: z.enum(MEMORY_CLASSES).optional(),
      /** How far the clock moves before this record is written. */
      advanceMilliseconds: z.number().int().nonnegative().optional(),
    }),
  ),
  query: z.string(),
  options: z.record(z.string(), z.unknown()).default({}),
  manifest: z.unknown().optional(),
  expectedDifferences: z.array(z.string()).default([]),
  /**
   * The bundle revision the replay must produce when `expectedDifferences` is
   * not empty. Naming the differences alone would let other drift pass beside
   * them, so a recording that expects differences pins the revision too.
   */
  expectedRevision: z.string().optional(),
});

/** One recording: what to store, what to recall, and the manifest the recall produced. */
export type RecallRecording = z.input<typeof recordingSchema>;

/** The outcome of replaying one recording. */
export interface RecallReplay {
  readonly name: string;
  readonly manifest: MemoryEvidenceManifest;
  readonly differences: readonly MemoryRecallDifference[];
  /**
   * Whether the replay compared against a baseline and found exactly the
   * differences the recording expects, by kind and in order, at the bundle
   * revision it pins when it expects any.
   */
  readonly passed: boolean;
}

const COLLECTION = 'replay';

/** Stores the recording's records and runs its recall, all on a deterministic clock and identifier sequence. */
export async function replayRecording(input: RecallRecording): Promise<RecallReplay> {
  const recording = recordingSchema.parse(input);
  const runtime = createManualRuntimeServices({
    origin: '2026-01-01T00:00:00.000Z',
    // Fixed, not per recording, so two recordings of the same records name them alike.
    identifierSeed: 'recall-replay',
  });
  const memory = createGovernedMemory({
    storage: createInMemoryMemoryRecordStorage({ now: () => runtime.clock.now() }),
    ledger: createMemoryGovernanceLedger(new MemoryStorage()),
    embedder: createMockEmbedder(64),
    policy: createMemoryGovernancePolicy({ revision: recording.policyRevision }),
    runtime,
  });
  await memory.init();
  const authority = createMemoryAuthority({
    principal: { kind: 'user', id: 'replay:principal' },
    tenantId: 'replay-tenant',
    ownerId: 'replay-owner',
    purpose: 'recall-replay',
    capabilities: ['memory:write', 'memory:search'],
    policyRevision: 'authorization:replay',
    projection: 'bureau',
  });
  try {
    for (const record of recording.records) {
      if (record.advanceMilliseconds !== undefined)
        await runtime.advance(record.advanceMilliseconds);
      await memory.write(authority, record.content, {
        collection: COLLECTION,
        source: record.source,
        ...(record.memoryClass === undefined ? {} : { memoryClass: record.memoryClass }),
      });
    }
    const options = { ...recording.options, collection: COLLECTION } as RecallForModelOptions;
    const manifest = memoryEvidenceManifest(
      await memory.recallForModel(authority, recording.query, options),
    );
    const differences =
      recording.manifest === undefined
        ? []
        : compareMemoryEvidenceManifests(recording.manifest as MemoryEvidenceManifest, manifest);
    const kinds = differences.map((difference) => difference.kind);
    const pinned =
      recording.expectedDifferences.length === 0 ||
      manifest.revision === recording.expectedRevision;
    return {
      name: recording.name,
      manifest,
      differences,
      // A recording with no baseline proves nothing, so it never passes outside `--record`.
      passed:
        recording.manifest !== undefined &&
        pinned &&
        kinds.join(',') === recording.expectedDifferences.join(','),
    };
  } finally {
    await memory.close();
  }
}

/**
 * A recording refreshed from a fresh run: its manifest replaced, and its
 * expected differences dropped, because a baseline never differs from itself.
 */
export function recordedBaseline(
  recording: RecallRecording,
  manifest: MemoryEvidenceManifest,
): RecallRecording {
  const { expectedDifferences: _stale, expectedRevision: _pinned, ...baseline } = recording;
  return { ...baseline, manifest };
}

async function main(argv: readonly string[]): Promise<number> {
  const record = argv.includes('--record');
  const files = argv.filter((argument) => argument !== '--record');
  if (files.length === 0) {
    console.error('Usage: bun scripts/replay-recall.ts [--record] <recording.json>...');
    return 2;
  }
  let failed = 0;
  for (const file of files) {
    const recording = (await Bun.file(file).json()) as RecallRecording;
    const replay = await replayRecording(recording);
    if (record) {
      await Bun.write(
        file,
        `${JSON.stringify(recordedBaseline(recording, replay.manifest), null, 2)}\n`,
      );
      console.log(`recorded ${replay.name}`);
      continue;
    }
    if (!replay.passed) failed += 1;
    console.log(`${replay.passed ? 'ok' : 'FAILED'} ${replay.name}`);
    for (const difference of replay.differences) console.log(`  ${JSON.stringify(difference)}`);
  }
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
