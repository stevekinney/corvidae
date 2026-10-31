import type { Embedder } from 'armorer';

import { createHashingEmbedder, HASHING_EMBEDDER_DIMENSION } from './hashing-embedder';

/** The id of the built-in hashing embedder, the default when no embedder is selected. */
export const HASHING_EMBEDDER_ID = 'hashing';

/**
 * Whether a registered embedder can embed now: `needs-setup` when its plugin is loaded but lacks
 * what it needs to run, such as a secret (COR-1879 reports it from the plugin's status).
 */
export type EmbedderAvailability = 'available' | 'needs-setup';

/** An embedder a plugin contributes, registered under the id a `memory.embedder` setting names. */
export interface ContributedEmbedder {
  /** Unique among contributions, and never {@link HASHING_EMBEDDER_ID}. */
  readonly id: string;
  /** The embedder resolved when a setting names `id`. */
  readonly embedder: Embedder;
  /** How many entries each vector it returns has; memory refuses a vector of any other length. */
  readonly dimension: number;
  /**
   * Read each time memory asks, so an embedder whose plugin is set up later becomes available
   * without a restart. Omitted, the embedder is always `available`.
   */
  readonly availability?: () => EmbedderAvailability;
}

/** What the registry knows of one id, without resolving its embedder. */
export interface RegisteredEmbedder {
  /** The registered id. */
  readonly id: string;
  /** The dimension its vectors have. */
  readonly dimension: number;
  /** Whether it can embed now. */
  readonly availability: EmbedderAvailability;
}

/** A registration or selection the {@link EmbedderRegistry} refused. */
export class EmbedderRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedderRegistryError';
  }
}

/** The embedders memory can use, by id. */
export interface EmbedderRegistry {
  /** Every registered id: the hashing embedder's first, then the contributions in the order given. */
  readonly ids: readonly string[];
  /**
   * The embedder named by `selected`. With no selection it is the hashing embedder, however many
   * embedders were contributed: a contribution is used only when a setting names it. An id nothing
   * registered throws {@link EmbedderRegistryError}, naming the ids that are registered.
   */
  resolve(selected?: string): Embedder;
  /** What is registered under `id`, with its availability as it is now, or `undefined` when nothing is. */
  describe(id: string): RegisteredEmbedder | undefined;
}

/**
 * Registers contributed embedders by id beside the built-in hashing embedder (COR-1875). Selecting
 * one and re-embedding what is already stored are not done here: this resolves an id to an
 * embedder, and describes its dimension and availability (COR-1898), and nothing more. A blank id, a repeated id, the hashing embedder's own id, and a dimension that is not a positive
 * integer throw
 * {@link EmbedderRegistryError}, because a contribution may not shadow another or the default.
 */
export function createEmbedderRegistry(
  contributed: readonly ContributedEmbedder[] = [],
): EmbedderRegistry {
  const embedders = new Map<string, Omit<ContributedEmbedder, 'id'>>([
    [
      HASHING_EMBEDDER_ID,
      { embedder: createHashingEmbedder(), dimension: HASHING_EMBEDDER_DIMENSION },
    ],
  ]);
  for (const { id, embedder, dimension, availability } of contributed) {
    if (id.trim() === '') {
      throw new EmbedderRegistryError('A contributed embedder needs a non-blank id.');
    }
    if (embedders.has(id)) {
      throw new EmbedderRegistryError(
        id === HASHING_EMBEDDER_ID
          ? `The id "${id}" belongs to the built-in hashing embedder.`
          : `Two embedders were contributed under the id "${id}".`,
      );
    }
    if (!Number.isSafeInteger(dimension) || dimension <= 0) {
      throw new EmbedderRegistryError(
        `The embedder "${id}" needs a positive integer dimension, not ${dimension}.`,
      );
    }
    embedders.set(id, {
      embedder,
      dimension,
      ...(availability === undefined ? {} : { availability }),
    });
  }
  const ids = [...embedders.keys()];
  return {
    ids,
    resolve(selected = HASHING_EMBEDDER_ID) {
      const entry = embedders.get(selected);
      if (entry === undefined) {
        throw new EmbedderRegistryError(
          `No embedder is registered under "${selected}". Registered: ${ids.join(', ')}.`,
        );
      }
      return entry.embedder;
    },
    describe(id) {
      const entry = embedders.get(id);
      if (entry === undefined) return undefined;
      return {
        id,
        dimension: entry.dimension,
        availability: entry.availability?.() ?? 'available',
      };
    },
  };
}
