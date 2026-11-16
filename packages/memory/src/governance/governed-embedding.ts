import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { Embedder } from 'armorer';

import { type EmbedderRegistry, EmbedderRegistryError } from '../embedder-registry';
import {
  type MemoryEmbeddingProfile,
  type MemoryVectorReference,
  type MemoryVectorStore,
  MemoryVectorDimensionError,
} from '../memory-vector-store';
import { raceAbort } from './abort-race';
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
   * dimension, or holding an entry that is not a finite number, throws
   * {@link MemoryVectorDimensionError}, so nothing it made is ever stored.
   *
   * Every embed is bounded (COR-2185): it gets its own signal, which aborts when
   * {@link CreateGovernedEmbeddingInput.embedTimeoutMilliseconds} has passed or when
   * `options.signal` aborts. The embedder is given that signal, and the embed rejects with the
   * signal's reason as soon as it aborts, even when the embedder ignores it. The bound's reason is
   * a `TimeoutError`; the caller's is the caller's own.
   *
   * `options.timeoutMilliseconds` shortens the bound for this one embed (the smaller of it and the
   * configured bound applies). It is a bound and not a signal on purpose: an aborted `signal` means
   * the caller gave up, and a bound that ran out only means the embedder did not answer.
   */
  embed(
    texts: readonly string[],
    options?: { readonly signal?: AbortSignal; readonly timeoutMilliseconds?: number },
  ): Promise<Float32Array[]>;
}

/** How long one embed may take before it is abandoned, in milliseconds, when no bound is given. */
export const DEFAULT_EMBED_TIMEOUT_MILLISECONDS = 120_000;

/**
 * An embedder whose cache can evict entries by the SHA-256 digest of the content they embedded,
 * such as `withEmbeddingCache()`. Only such an embedder lets the built-in `caches` deletion handler
 * claim eviction; any other cache needs a configured propagator or a `not-retained` declaration.
 */
export type ContentEvictingEmbedder = Embedder & {
  /** Evicts every entry whose embedded text has one of these digests; returns how many went. */
  evictContent(contentDigests: readonly string[]): number | Promise<number>;
};

function evictsContent(embedder: Embedder): embedder is ContentEvictingEmbedder {
  return 'evictContent' in embedder && typeof embedder.evictContent === 'function';
}

/**
 * Every registered embedder that caches content, so a deletion, or an embed that finds its record
 * deleted, evicts the content from each.
 */
export function cachingEmbedders(registry: EmbedderRegistry): ContentEvictingEmbedder[] {
  return registry.ids.map((id) => registry.resolve(id)).filter(evictsContent);
}

/** How governed memory reaches its embedders and the vectors they made. */
export interface GovernedEmbedding {
  /** The embedders memory can use, by id. */
  readonly registry: EmbedderRegistry;
  /** Where the vectors live. */
  readonly vectors: MemoryVectorStore;
  /** The profile a store with no active profile starts with: the initial embedder's, generation 1. */
  readonly initialProfile: MemoryEmbeddingProfile;
  /**
   * The active profile, read now, with its embedder, or with `embedding` left out while that
   * embedder is unavailable (see {@link GovernedEmbedding.canEmbed}). Recall then scores by text
   * alone, and an admission queues the record for the embedder.
   */
  activeIfAvailable(): Promise<{
    readonly profile: MemoryEmbeddingProfile;
    readonly embedding?: ActiveEmbedding;
  }>;
  /**
   * Whether `profile`'s embedder can embed now: it is registered, with the profile's dimension, and
   * needs no setup. A profile that fails this is never embedded into; its embeds wait in a queue.
   */
  canEmbed(profile: MemoryEmbeddingProfile): boolean;
  /**
   * `profile` with the embedder registered under its id. Throws {@link EmbedderRegistryError} when
   * nothing is registered under it, or it is registered with another dimension than the profile's.
   */
  bind(profile: MemoryEmbeddingProfile): ActiveEmbedding;
  /** What `memory.embedding.status()` reports. A read: it stores no active profile. */
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
  /** Where the bound on each embed gets its timer, so a test drives it by hand. */
  readonly runtime: RuntimeServices;
  /**
   * How long one embed may take before it is abandoned. Defaults to
   * {@link DEFAULT_EMBED_TIMEOUT_MILLISECONDS}. A positive, finite number.
   */
  readonly embedTimeoutMilliseconds?: number;
}

/**
 * Binds the registry to the vector store. A store with no active profile yet starts with
 * `initialEmbedder`'s, at generation 1. An active profile whose embedder is not registered, or is
 * registered with another dimension than the profile's, throws: memory never embeds into a profile
 * with another model or dimension than the one that made its vectors.
 */
export function createGovernedEmbedding(input: CreateGovernedEmbeddingInput): GovernedEmbedding {
  const { registry, vectors, runtime } = input;
  const embedTimeout = input.embedTimeoutMilliseconds ?? DEFAULT_EMBED_TIMEOUT_MILLISECONDS;
  if (!Number.isFinite(embedTimeout) || embedTimeout <= 0) {
    throw new RangeError(
      `embedTimeoutMilliseconds must be a positive, finite number of milliseconds, not ${String(embedTimeout)}.`,
    );
  }
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

  function bind(profile: MemoryEmbeddingProfile): ActiveEmbedding {
    const registered = registry.describe(profile.embedderId);
    if (registered === undefined) {
      throw new EmbedderRegistryError(
        `The embedder "${profile.embedderId}" is not registered. Registered: ${registry.ids.join(', ')}.`,
      );
    }
    if (registered.dimension !== profile.dimension) {
      throw new EmbedderRegistryError(
        `The embedder "${profile.embedderId}" is registered with ${registered.dimension} dimensions, but the embedding it is asked for has ${profile.dimension}.`,
      );
    }
    const embedder = registry.resolve(profile.embedderId);
    return {
      profile,
      async embed(texts, options) {
        const caller = options?.signal;
        caller?.throwIfAborted();
        // Read once, before the first await: the caller owns `options`.
        const requested = options?.timeoutMilliseconds;
        const limit = requested === undefined ? embedTimeout : Math.min(embedTimeout, requested);
        // Each embed has its own bound, so a hung embedder holds one embed and never the memory.
        const bound = new AbortController();
        const timer = runtime.timers.setTimeout(() => {
          bound.abort(
            new DOMException(
              `The embedder "${profile.embedderId}" did not answer within ${limit} milliseconds.`,
              'TimeoutError',
            ),
          );
        }, limit);
        const signal =
          caller === undefined ? bound.signal : AbortSignal.any([caller, bound.signal]);
        try {
          // Called inside the `try`: an embedder that throws before it returns a promise is a
          // failed embed, not an exception out of this one.
          const embedded = await raceAbort(
            Promise.resolve(embedder([...texts], { signal })),
            signal,
          );
          return embedded.map((vector) => {
            // Checked here, as the store checks a vector it is given, so a vector the store would
            // refuse fails the embed itself: an admission stores nothing, and a switch fails.
            if (vector.length !== profile.dimension || !vector.every(Number.isFinite)) {
              throw new MemoryVectorDimensionError(profile, vector.length);
            }
            return new Float32Array(vector);
          });
        } finally {
          runtime.timers.clearTimeout(timer);
        }
      },
    };
  }

  function canEmbed(profile: MemoryEmbeddingProfile): boolean {
    const registered = registry.describe(profile.embedderId);
    return (
      registered !== undefined &&
      registered.dimension === profile.dimension &&
      registered.availability === 'available'
    );
  }

  return {
    registry,
    vectors,
    initialProfile,
    async activeIfAvailable() {
      const profile = await vectors.activeProfile(initialProfile);
      return canEmbed(profile) ? { profile, embedding: bind(profile) } : { profile };
    },
    canEmbed,
    bind,
    async status() {
      // A store with no active profile yet reports the one its first write will store.
      const profile = (await vectors.getActiveProfile()) ?? initialProfile;
      const { embedderId, dimension } = profile;
      const job = await vectors.getJob();
      return {
        active: { embedder: embedderId, dimension },
        ...(canEmbed(profile) ? {} : { problem: 'embedder-unavailable' as const }),
        ...(job === undefined
          ? {}
          : {
              job: {
                target: job.target.embedderId,
                state: job.state,
                done: job.done,
                total: job.total,
                ...(job.error === undefined ? {} : { error: job.error }),
              },
            }),
      };
    },
    availability(id) {
      return registry.describe(id)?.availability ?? 'not-loaded';
    },
    forget: (references) => vectors.deleteMany(references),
  };
}
