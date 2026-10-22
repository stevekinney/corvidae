/**
 * The seed read of each schedule fire's review history (COR-1613, COR-1622).
 *
 * A process that replays a fire's step finds, in the fire's durable history, the requests a dead
 * process made, which its own memory cannot hold: it reads them once per fire, before it announces
 * the fire's first review, so a replayed request is not announced twice. The read is a promise kept
 * per fire, so a writer of a close, which must come after the request it closes in the history, can
 * wait for a read that is still under way instead of racing the announcement that waits on it. An
 * entry leaves with the fire's final reconciliation, so the map holds the fires in flight and no
 * more.
 *
 * @module fire-review-seeds
 */

import type { DiagnosticSink } from './types';
import { serializeUnknownError } from './serialization';

/** What the seeds need of the Bureau that owns them. */
export interface FireReviewSeedsDependencies {
  /** Reads the fire's history and records what it says, once per call. Rejects on a failed read. */
  readonly read: (runId: string) => Promise<void>;
  readonly diagnose: DiagnosticSink;
}

/** The seed reads of the fires in flight. */
export interface FireReviewSeeds {
  /**
   * The fire's seed read: started by the first call and shared by every later one. Resolves when
   * the read has finished, whether it succeeded or not: a failed read is diagnosed and forgotten,
   * so the next call reads again.
   */
  ensure(runId: string): Promise<void>;
  /** Resolves once the fire's seed read, if one is under way or done, has finished. */
  pending(runId: string): Promise<void>;
  /** Forgets the fire: it is over, and a later announcement reads its history afresh. */
  release(runId: string): void;
  /** Whether the fire has a seed read, under way or done. */
  has(runId: string): boolean;
  /** How many fires hold one. */
  size(): number;
}

export function createFireReviewSeeds(dependencies: FireReviewSeedsDependencies): FireReviewSeeds {
  const seeds = new Map<string, Promise<void>>();
  return {
    ensure(runId) {
      const existing = seeds.get(runId);
      if (existing !== undefined) return existing;
      const seed = dependencies.read(runId).catch((error: unknown) => {
        // Only this read's own entry is dropped: a later read that replaced it is kept.
        if (seeds.get(runId) === seed) seeds.delete(runId);
        dependencies.diagnose({
          level: 'error',
          scope: 'durable-event-history',
          message: `[bureau] Could not read the review history of schedule fire "${runId}", so a replayed request may be announced again: ${serializeUnknownError(error)}`,
          cause: error,
        });
      });
      seeds.set(runId, seed);
      return seed;
    },
    pending: (runId) => seeds.get(runId) ?? Promise.resolve(),
    release(runId) {
      seeds.delete(runId);
    },
    has: (runId) => seeds.has(runId),
    size: () => seeds.size,
  };
}

const seedsOfBureau = new WeakMap<object, FireReviewSeeds>();

/** Remembers a Bureau's seeds so a test can read them; nothing in production reads them. */
export function trackFireReviewSeeds(bureau: object, seeds: FireReviewSeeds): void {
  seedsOfBureau.set(bureau, seeds);
}

/** The seeds of a Bureau that {@link trackFireReviewSeeds} was given. */
export function fireReviewSeedsOf(bureau: object): FireReviewSeeds {
  const seeds = seedsOfBureau.get(bureau);
  if (seeds === undefined) throw new Error('This Bureau has no tracked fire review seeds.');
  return seeds;
}
