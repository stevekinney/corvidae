import { type EmbedderRegistry, EmbedderRegistryError } from '../embedder-registry';
import {
  type MemoryEmbeddingProfile,
  type MemoryVectorReference,
  type MemoryVectorStore,
  MemoryVectorDimensionError,
} from '../memory-vector-store';
import type { MemoryEmbedderAvailability, MemoryEmbeddingStatus } from './governed-memory-types';

/**
 * The active profile as one operation reads it, with the embedder that made its vectors. An
 * operation reads it once and uses it throughout, so a query and the vectors it is compared with
 * always come from one profile.
 */
export interface ActiveEmbedding {
  /** The profile every vector this operation reads or writes belongs to. */
  readonly profile: MemoryEmbeddingProfile;
  /**
   * Embeds `texts` with the profile's embedder. A vector of another length than the profile's
   * dimension throws {@link MemoryVectorDimensionError}, so nothing it made is ever stored.
   */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/** How governed memory reaches its embedders and the vectors they made. */
export interface GovernedEmbedding {
  /** The embedders memory can use, by id. */
  readonly registry: EmbedderRegistry;
  /** Where the vectors live. */
  readonly vectors: MemoryVectorStore;
  /** The active profile, read now, and its embedder. */
  active(): Promise<ActiveEmbedding>;
  /** What `memory.embedding.status()` reports. */
  status(): Promise<MemoryEmbeddingStatus>;
  /** Whether `id` names an embedder memory could embed with now. */
  availability(id: string): MemoryEmbedderAvailability;
  /**
   * Deletes the referenced records' vectors from every profile. Called after the records
   * themselves are deleted, so a vector never outlives a record a reader can still find.
   */
  forget(references: readonly MemoryVectorReference[]): Promise<void>;
}

/** What {@link createGovernedEmbedding} composes. */
export interface CreateGovernedEmbeddingInput {
  readonly registry: EmbedderRegistry;
  readonly vectors: MemoryVectorStore;
  /** The embedder a store with no active profile starts with. */
  readonly initialEmbedder: string;
}

/**
 * Binds the registry to the vector store. A store with no active profile yet starts with
 * `initialEmbedder`'s, at generation 1. An active profile whose embedder is not registered, or is
 * registered with another dimension than the profile's, throws: memory never embeds into a profile
 * with another model or dimension than the one that made its vectors.
 */
export function createGovernedEmbedding(input: CreateGovernedEmbeddingInput): GovernedEmbedding {
  const { registry, vectors } = input;
  const initial = registry.describe(input.initialEmbedder);
  if (initial === undefined) {
    throw new EmbedderRegistryError(
      `The initial embedder "${input.initialEmbedder}" is not registered. Registered: ${registry.ids.join(', ')}.`,
    );
  }
  const initialProfile: MemoryEmbeddingProfile = {
    embedderId: initial.id,
    dimension: initial.dimension,
    generation: 1,
  };

  async function active(): Promise<ActiveEmbedding> {
    const profile = await vectors.activeProfile(initialProfile);
    const registered = registry.describe(profile.embedderId);
    if (registered === undefined) {
      throw new EmbedderRegistryError(
        `The active embedder "${profile.embedderId}" is not registered. Registered: ${registry.ids.join(', ')}.`,
      );
    }
    if (registered.dimension !== profile.dimension) {
      throw new EmbedderRegistryError(
        `The embedder "${profile.embedderId}" is registered with ${registered.dimension} dimensions, but memory's active embedding has ${profile.dimension}.`,
      );
    }
    const embedder = registry.resolve(profile.embedderId);
    return {
      profile,
      async embed(texts) {
        const embedded = await embedder([...texts]);
        return embedded.map((vector) => {
          if (vector.length !== profile.dimension) {
            throw new MemoryVectorDimensionError(profile, vector.length);
          }
          return new Float32Array(vector);
        });
      },
    };
  }

  return {
    registry,
    vectors,
    active,
    async status() {
      const { embedderId, dimension } = await vectors.activeProfile(initialProfile);
      return { active: { embedder: embedderId, dimension } };
    },
    availability(id) {
      return registry.describe(id)?.availability ?? 'not-loaded';
    },
    forget: (references) => vectors.deleteMany(references),
  };
}
