import type { Embedder } from 'armorer';

import { createHashingEmbedder } from './hashing-embedder';

/** The id of the built-in hashing embedder, the default when no embedder is selected. */
export const HASHING_EMBEDDER_ID = 'hashing';

/** An embedder a plugin contributes, registered under the id a `memory.embedder` setting names. */
export interface ContributedEmbedder {
  /** Unique among contributions, and never {@link HASHING_EMBEDDER_ID}. */
  readonly id: string;
  /** The embedder resolved when a setting names `id`. */
  readonly embedder: Embedder;
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
}

/**
 * Registers contributed embedders by id beside the built-in hashing embedder (COR-1875). Selecting
 * one and re-embedding what is already stored are not done here: this resolves an id to an
 * embedder and nothing more. A blank id, a repeated id, and the hashing embedder's own id throw
 * {@link EmbedderRegistryError}, because a contribution may not shadow another or the default.
 */
export function createEmbedderRegistry(
  contributed: readonly ContributedEmbedder[] = [],
): EmbedderRegistry {
  const embedders = new Map<string, Embedder>([[HASHING_EMBEDDER_ID, createHashingEmbedder()]]);
  for (const { id, embedder } of contributed) {
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
    embedders.set(id, embedder);
  }
  const ids = [...embedders.keys()];
  return {
    ids,
    resolve(selected = HASHING_EMBEDDER_ID) {
      const embedder = embedders.get(selected);
      if (embedder === undefined) {
        throw new EmbedderRegistryError(
          `No embedder is registered under "${selected}". Registered: ${ids.join(', ')}.`,
        );
      }
      return embedder;
    },
  };
}
