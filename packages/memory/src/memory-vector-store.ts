import {
  type BatchOperation,
  encodeStorageKeyComponent,
  MAX_BATCH_OPERATIONS,
  type Storage,
  storageBatch,
  storageConditionalBatch,
  storageDeletePrefix,
} from '@lostgradient/storage';
import { z } from 'zod';

import { validateMemoryKeyPrefix } from './create-weft-memory-record-storage-helpers';
import type { MemoryRecordScope } from './memory-record-storage';

/**
 * Default key prefix of the vector store. Disjoint from the record storage's
 * `app:agent-bureau:memory:v1:`, the governance ledger's
 * `app:agent-bureau:memory-governance:v1:`, and every Weft reserved prefix, so
 * all of them can share one {@link Storage} (asserted in a unit test).
 */
export const DEFAULT_MEMORY_VECTOR_KEY_PREFIX = 'app:agent-bureau:memory-vectors:v1:';

/**
 * One embedding of stored memory (COR-1898): the embedder that made its
 * vectors, their dimension, and the generation that tells apart two embeddings
 * by the same embedder. Every vector a profile holds came from `embedderId` and
 * has `dimension` entries, so a profile never mixes models or dimensions.
 */
export interface MemoryEmbeddingProfile {
  /** The embedder registry id whose embedder made every vector in the profile. */
  readonly embedderId: string;
  /** How many entries each vector in the profile has. */
  readonly dimension: number;
  /** Positive; a new embedding by the same embedder takes a generation no profile has used. */
  readonly generation: number;
}

/** One record's vector in a profile, and the record `version` it was embedded at. */
export interface StoredMemoryVector {
  /** The record's `version` when its content was embedded. */
  readonly version: number;
  /** The embedding, `dimension` entries long. */
  readonly vector: Float32Array;
}

/** A record a vector belongs to: its id within its scope. */
export interface MemoryVectorReference {
  /** The record id. */
  readonly id: string;
  /** The record's scope. */
  readonly scope: MemoryRecordScope;
}

/** Where a switch of the active embedding stands: `running`, or how it ended without completing. */
export type MemoryEmbeddingJobState = 'running' | 'failed' | 'cancelled';

/**
 * The durable record of a switch of the active embedding (COR-1898): the embedding it started
 * from, the profile it fills, and how far it got. A switch that completes leaves no record; one
 * that failed or was cancelled keeps it, so its state and error stay readable, until the next
 * switch starts.
 */
export interface MemoryEmbeddingJob {
  /** The active profile when the switch started, which recall uses until it completes. */
  readonly from: MemoryEmbeddingProfile;
  /** The profile the switch fills, with a generation no other profile has had. */
  readonly target: MemoryEmbeddingProfile;
  /** Where the switch stands. */
  readonly state: MemoryEmbeddingJobState;
  /** How many stored records the target held a vector for when last counted. */
  readonly done: number;
  /** How many records were stored when last counted. */
  readonly total: number;
  /** Why a `failed` switch failed: `target-unavailable`, or the error the target embedder gave. */
  readonly error?: string;
}

/**
 * A vector whose length is not its profile's dimension, or which holds an entry
 * that is not a finite number. Nothing was written.
 */
export class MemoryVectorDimensionError extends Error {
  /** Stable code for callers that branch on the refusal. */
  readonly code = 'embedding-dimension-mismatch';

  constructor(
    /** The profile the vector was meant for. */
    readonly profile: MemoryEmbeddingProfile,
    /** How many entries the vector had. */
    readonly received: number,
  ) {
    super(
      `The embedder "${profile.embedderId}" is registered with ${profile.dimension} dimensions, ` +
        `but gave a vector of ${received}; a profile holds one dimension only.`,
    );
    this.name = 'MemoryVectorDimensionError';
  }
}

/**
 * A vector written to a profile the store does not hold: one never created, or removed since.
 * Nothing was written, so no vector can sit in a profile that deletion does not visit.
 */
export class MemoryVectorProfileMissingError extends Error {
  /** Stable code for callers that branch on the refusal. */
  readonly code = 'embedding-profile-missing';

  constructor(
    /** The profile the vector was meant for. */
    readonly profile: MemoryEmbeddingProfile,
  ) {
    super(
      `The embedding profile "${profile.embedderId}" (${profile.dimension} dimensions, generation ` +
        `${profile.generation}) is not stored; create it before writing its vectors.`,
    );
    this.name = 'MemoryVectorProfileMissingError';
  }
}

/**
 * Where memory's vectors live (COR-1898), apart from the records they embed, so
 * stored memory can hold more than one embedding while it moves to another.
 * Vectors are kept per {@link MemoryEmbeddingProfile}, keyed by profile, scope,
 * and record id. One profile is active: recall and admission use it.
 */
export interface MemoryVectorStore {
  /**
   * The active profile. When none is stored yet, `initial` becomes the active
   * profile, written only if no other writer stored one first, and the stored
   * profile is returned either way.
   */
  activeProfile(initial: MemoryEmbeddingProfile): Promise<MemoryEmbeddingProfile>;
  /** The stored active profile, or `undefined` when none is stored yet. Writes nothing. */
  getActiveProfile(): Promise<MemoryEmbeddingProfile | undefined>;
  /** Every profile the store holds, the active one included. */
  listProfiles(): Promise<MemoryEmbeddingProfile[]>;
  /**
   * Adds `profile` beside the others without making it active, so vectors can be written into it
   * while the active profile keeps serving recall. Returns `false`, and changes nothing, when the
   * store already holds that profile: a profile is never created twice.
   */
  createProfile(profile: MemoryEmbeddingProfile): Promise<boolean>;
  /**
   * Stores `vector` as the record's embedding in `profile`, replacing any
   * earlier one. Throws {@link MemoryVectorDimensionError} for a vector that
   * does not fit the profile, and {@link MemoryVectorProfileMissingError} when
   * the store does not hold `profile`, writing nothing either way. The write is
   * conditioned on the profile's marker in one compare-and-swap, so a vector
   * never lands in a profile {@link MemoryVectorStore.deleteMany} cannot find.
   */
  put(
    profile: MemoryEmbeddingProfile,
    reference: MemoryVectorReference,
    entry: StoredMemoryVector,
  ): Promise<void>;
  /** The vectors `profile` holds for `ids` in `scope`, by record id. Absent ids are left out. */
  getMany(
    profile: MemoryEmbeddingProfile,
    scope: MemoryRecordScope,
    ids: readonly string[],
  ): Promise<Map<string, StoredMemoryVector>>;
  /** Deletes the referenced records' vectors from every profile the store holds. */
  deleteMany(references: readonly MemoryVectorReference[]): Promise<void>;
  /** Whether {@link MemoryVectorStore.markInlineVectorsCopied} has run on this store. */
  inlineVectorsCopied(): Promise<boolean>;
  /**
   * Records that the vectors records held inline before COR-1898 have been copied into the store,
   * so memory never scans its records for them again.
   */
  markInlineVectorsCopied(): Promise<void>;
  /**
   * The profile a completed switch replaced most recently, kept beside the active one until the
   * next switch completes, or `undefined` when no switch has completed.
   */
  getPreviousProfile(): Promise<MemoryEmbeddingProfile | undefined>;
  /**
   * A generation no profile has had: one more than the last this store gave out. Every switch takes
   * one, so no switch ever fills a profile that existed before, even one deleted since.
   */
  nextGeneration(): Promise<number>;
  /**
   * Removes `profile` and every vector it holds. The marker goes first, so a {@link
   * MemoryVectorStore.put} into the profile that has not committed yet is refused, and one that
   * has is among the vectors removed.
   */
  deleteProfile(profile: MemoryEmbeddingProfile): Promise<void>;
  /** Deletes one record's vector from `profile` alone, leaving its vectors in other profiles. */
  delete(profile: MemoryEmbeddingProfile, reference: MemoryVectorReference): Promise<void>;
  /** The switch record, or `undefined` when no switch is running or has ended without completing. */
  getJob(): Promise<MemoryEmbeddingJob | undefined>;
  /**
   * Replaces the switch record with `next` (`undefined` removes it), only if it still is
   * `expected`. Returns whether it did.
   */
  replaceJob(
    expected: MemoryEmbeddingJob | undefined,
    next: MemoryEmbeddingJob | undefined,
  ): Promise<boolean>;
  /**
   * Completes the switch `expected` describes, in one compare-and-swap: its target becomes the
   * active profile, its `from` becomes the previous one, and the record is removed. Returns `false`,
   * changing nothing, when the record or the active profile is no longer what the switch expects.
   */
  completeJob(expected: MemoryEmbeddingJob): Promise<boolean>;
}

/** Options for {@link createMemoryVectorStore}. */
export interface CreateMemoryVectorStoreOptions {
  /** Defaults to {@link DEFAULT_MEMORY_VECTOR_KEY_PREFIX}; must not collide with a Weft reserved prefix. */
  readonly keyPrefix?: string;
}

const profileSchema = z
  .object({
    schemaVersion: z.literal(1),
    embedderId: z.string().min(1),
    dimension: z.number().int().positive(),
    generation: z.number().int().positive(),
  })
  .strict();

const jobSchema = z
  .object({
    schemaVersion: z.literal(1),
    from: profileSchema,
    target: profileSchema,
    state: z.enum(['running', 'failed', 'cancelled']),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    error: z.string().optional(),
  })
  .strict();

const generationSchema = z
  .object({ schemaVersion: z.literal(1), generation: z.number().int().positive() })
  .strict();

const vectorSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.number().int().positive(),
    vector: z.array(z.number()),
  })
  .strict();

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeJson(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

function decodeProfile(bytes: Uint8Array): MemoryEmbeddingProfile {
  const { embedderId, dimension, generation } = profileSchema.parse(
    JSON.parse(textDecoder.decode(bytes)),
  );
  return { embedderId, dimension, generation };
}

function encodeProfile(profile: MemoryEmbeddingProfile): Uint8Array {
  // `put` compares a profile's marker with these bytes, so the encoding never changes.
  return encodeJson({
    schemaVersion: 1,
    embedderId: profile.embedderId,
    dimension: profile.dimension,
    generation: profile.generation,
  });
}

function profileRecord(profile: MemoryEmbeddingProfile): Record<string, unknown> {
  return {
    schemaVersion: 1,
    embedderId: profile.embedderId,
    dimension: profile.dimension,
    generation: profile.generation,
  };
}

/** One fixed field order, so a compare-and-swap can expect the bytes a record encodes to. */
function encodeJob(job: MemoryEmbeddingJob): Uint8Array {
  return encodeJson({
    schemaVersion: 1,
    from: profileRecord(job.from),
    target: profileRecord(job.target),
    state: job.state,
    done: job.done,
    total: job.total,
    ...(job.error === undefined ? {} : { error: job.error }),
  });
}

function decodeJob(bytes: Uint8Array): MemoryEmbeddingJob {
  const parsed = jobSchema.parse(JSON.parse(textDecoder.decode(bytes)));
  const strip = ({ embedderId, dimension, generation }: MemoryEmbeddingProfile) => ({
    embedderId,
    dimension,
    generation,
  });
  return {
    from: strip(parsed.from),
    target: strip(parsed.target),
    state: parsed.state,
    done: parsed.done,
    total: parsed.total,
    ...(parsed.error === undefined ? {} : { error: parsed.error }),
  };
}

function checkProfile(profile: MemoryEmbeddingProfile): void {
  profileSchema.parse({ schemaVersion: 1, ...profile });
}

function profileComponent(profile: MemoryEmbeddingProfile): string {
  return `${encodeStorageKeyComponent(profile.embedderId)}:${profile.dimension}:${profile.generation}`;
}

function scopeComponent(scope: MemoryRecordScope): string {
  if (scope.namespace.length === 0) throw new Error('namespace must be a non-empty string.');
  return `t:${encodeStorageKeyComponent(scope.tenantId ?? '')}:n:${encodeStorageKeyComponent(scope.namespace)}`;
}

/**
 * A {@link MemoryVectorStore} over a {@link Storage}, which may be the one the
 * records and the governance ledger use. Keys, under `keyPrefix`:
 *
 * - `active`: the active profile;
 * - `previous`: the profile the last completed switch replaced;
 * - `generation`: the last generation a switch was given;
 * - `job`: the switch record, while one runs or after one failed or was cancelled;
 * - `inline-vectors-copied`: present once the vectors records held inline
 *   before COR-1898 were copied into the profile they were made in;
 * - `p:<embedderId>:<dimension>:<generation>`: one marker per profile;
 * - `v:<embedderId>:<dimension>:<generation>:t:<tenantId>:n:<namespace>:r:<id>`:
 *   one record's vector, `{ schemaVersion: 1, version, vector }`.
 *
 * Every component a caller supplies is percent-encoded, so no id can forge a
 * delimiter. Values are JSON, checked against a schema when read. The active
 * profile is created with a compare-and-swap, so the storage must support
 * `conditionalBatch`.
 */
export function createMemoryVectorStore(
  storage: Storage,
  options: CreateMemoryVectorStoreOptions = {},
): MemoryVectorStore {
  const prefix = options.keyPrefix ?? DEFAULT_MEMORY_VECTOR_KEY_PREFIX;
  validateMemoryKeyPrefix(prefix);
  const activeKey = `${prefix}active`;
  const inlineCopiedKey = `${prefix}inline-vectors-copied`;
  const previousKey = `${prefix}previous`;
  const generationKey = `${prefix}generation`;
  const jobKey = `${prefix}job`;
  const profileKey = (profile: MemoryEmbeddingProfile): string =>
    `${prefix}p:${profileComponent(profile)}`;
  const recordComponent = (reference: MemoryVectorReference): string =>
    `${scopeComponent(reference.scope)}:r:${encodeStorageKeyComponent(reference.id)}`;
  const vectorKey = (profile: MemoryEmbeddingProfile, reference: MemoryVectorReference): string =>
    `${prefix}v:${profileComponent(profile)}:${recordComponent(reference)}`;

  async function listProfiles(): Promise<MemoryEmbeddingProfile[]> {
    const profiles: MemoryEmbeddingProfile[] = [];
    for await (const [, value] of storage.scan(`${prefix}p:`)) profiles.push(decodeProfile(value));
    return profiles;
  }

  return {
    async activeProfile(initial) {
      checkProfile(initial);
      for (;;) {
        const stored = await storage.get(activeKey);
        if (stored !== null) return decodeProfile(stored);
        const created = await storageConditionalBatch(
          storage,
          [{ key: activeKey, expectedValue: null }],
          [
            { type: 'put', key: activeKey, value: encodeProfile(initial) },
            { type: 'put', key: profileKey(initial), value: encodeProfile(initial) },
          ],
        );
        if (created) return initial;
      }
    },

    async getActiveProfile() {
      const stored = await storage.get(activeKey);
      return stored === null ? undefined : decodeProfile(stored);
    },

    listProfiles,

    async createProfile(profile) {
      checkProfile(profile);
      const key = profileKey(profile);
      return storageConditionalBatch(
        storage,
        [{ key, expectedValue: null }],
        [{ type: 'put', key, value: encodeProfile(profile) }],
      );
    },

    async put(profile, reference, entry) {
      checkProfile(profile);
      const { vector } = entry;
      if (vector.length !== profile.dimension || !vector.every(Number.isFinite)) {
        throw new MemoryVectorDimensionError(profile, vector.length);
      }
      const stored = await storageConditionalBatch(
        storage,
        [{ key: profileKey(profile), expectedValue: encodeProfile(profile) }],
        [
          {
            type: 'put',
            key: vectorKey(profile, reference),
            value: encodeJson({
              schemaVersion: 1,
              version: entry.version,
              vector: Array.from(vector),
            }),
          },
        ],
      );
      if (!stored) throw new MemoryVectorProfileMissingError(profile);
    },

    async getMany(profile, scope, ids) {
      const found = new Map<string, StoredMemoryVector>();
      for (const id of new Set(ids)) {
        const bytes = await storage.get(vectorKey(profile, { id, scope }));
        if (bytes === null) continue;
        const stored = vectorSchema.parse(JSON.parse(textDecoder.decode(bytes)));
        found.set(id, { version: stored.version, vector: new Float32Array(stored.vector) });
      }
      return found;
    },

    async deleteMany(references) {
      if (references.length === 0) return;
      // Encoded before the first await, so a caller that reuses its array cannot change the deletion.
      const records = references.map(recordComponent);
      const operations: BatchOperation[] = [];
      for (const profile of await listProfiles()) {
        for (const record of records) {
          operations.push({
            type: 'delete',
            key: `${prefix}v:${profileComponent(profile)}:${record}`,
          });
        }
      }
      // Each chunk stays under the backend's batch cap. The chunks need not commit together: a
      // vector a failed chunk leaves belongs to a record already deleted, which recall never reads.
      for (let start = 0; start < operations.length; start += MAX_BATCH_OPERATIONS) {
        await storageBatch(storage, operations.slice(start, start + MAX_BATCH_OPERATIONS));
      }
    },

    async inlineVectorsCopied() {
      return (await storage.get(inlineCopiedKey)) !== null;
    },

    async markInlineVectorsCopied() {
      await storage.put(inlineCopiedKey, encodeJson({ schemaVersion: 1 }));
    },

    async getPreviousProfile() {
      const stored = await storage.get(previousKey);
      return stored === null ? undefined : decodeProfile(stored);
    },

    async nextGeneration() {
      for (;;) {
        const stored = await storage.get(generationKey);
        // Before the first switch only the initial profiles exist; the counter starts above them.
        const profiles = stored === null ? await listProfiles() : [];
        const last =
          stored === null
            ? Math.max(0, ...profiles.map((profile) => profile.generation))
            : generationSchema.parse(JSON.parse(textDecoder.decode(stored))).generation;
        const next = last + 1;
        const taken = await storageConditionalBatch(
          storage,
          [{ key: generationKey, expectedValue: stored }],
          [
            {
              type: 'put',
              key: generationKey,
              value: encodeJson({ schemaVersion: 1, generation: next }),
            },
          ],
        );
        if (taken) return next;
      }
    },

    async deleteProfile(profile) {
      checkProfile(profile);
      await storage.delete(profileKey(profile));
      await storageDeletePrefix(storage, `${prefix}v:${profileComponent(profile)}:`);
    },

    async delete(profile, reference) {
      await storage.delete(vectorKey(profile, reference));
    },

    async getJob() {
      const stored = await storage.get(jobKey);
      return stored === null ? undefined : decodeJob(stored);
    },

    async replaceJob(expected, next) {
      if (next !== undefined) jobSchema.parse(JSON.parse(textDecoder.decode(encodeJob(next))));
      return storageConditionalBatch(
        storage,
        [{ key: jobKey, expectedValue: expected === undefined ? null : encodeJob(expected) }],
        [
          next === undefined
            ? { type: 'delete', key: jobKey }
            : { type: 'put', key: jobKey, value: encodeJob(next) },
        ],
      );
    },

    async completeJob(expected) {
      return storageConditionalBatch(
        storage,
        [
          { key: jobKey, expectedValue: encodeJob(expected) },
          { key: activeKey, expectedValue: encodeProfile(expected.from) },
          { key: profileKey(expected.target), expectedValue: encodeProfile(expected.target) },
        ],
        [
          { type: 'put', key: activeKey, value: encodeProfile(expected.target) },
          { type: 'put', key: previousKey, value: encodeProfile(expected.from) },
          { type: 'delete', key: jobKey },
        ],
      );
    },
  };
}
