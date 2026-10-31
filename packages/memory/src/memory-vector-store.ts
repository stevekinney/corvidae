import {
  type BatchOperation,
  encodeStorageKeyComponent,
  MAX_BATCH_OPERATIONS,
  type Storage,
  storageBatch,
  storageConditionalBatch,
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
  return encodeJson({
    schemaVersion: 1,
    embedderId: profile.embedderId,
    dimension: profile.dimension,
    generation: profile.generation,
  });
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
  };
}
