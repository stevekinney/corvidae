/**
 * Recent-activity feed batcher (plan §5's UI treatment: "incoming events
 * batched into ≤100ms frames"; this track's brief: "'+N events' pause-to-
 * read affordance"). `Feed`/`FeedEvent` (Cinder) is a live-region list
 * container — it has no batching or pause-to-read concept of its own, so
 * this small rune-based class owns both, decoupled from any DOM/component
 * so it can be unit-tested without one (PROJECT-BRIEF).
 *
 * Rows reuse `classifyFleetEvent`'s output shape (`../../app/
 * fleet-event-classification.ts`) rather than re-deriving the 31-kind → icon/
 * text/href mapping.
 */
import type { FleetEventTier } from '../../app/fleet-event-classification.ts';

export interface ActivityFeedRow {
  readonly id: string;
  readonly tier: FleetEventTier;
  readonly icon: string;
  readonly title: string;
  readonly body: string;
  readonly href: string;
  readonly emittedAtMs: number;
}

/** One line of the window: a row, and how many in a row of the same kind it stands for. */
export interface ActivityFeedItem extends ActivityFeedRow {
  /** How many consecutive rows of this kind collapsed into this line; the line shows the newest. */
  readonly count: number;
}

/**
 * What makes two neighbouring rows repeats of one another: the same severity, the same headline and
 * the same subject. Headlines are generic ("Workflow failed"), so the link names the workflow the
 * row is about: failures of two workflows stay two lines, each linking to its own, while repeats of
 * one workflow still collapse. Some kinds link to a fixed page (reviews, alerts, workers), so the
 * link says nothing about their subject; the body does, so it is part of the key too.
 */
function collapseKey(row: ActivityFeedRow): string {
  return `${row.tier}\u0000${row.title}\u0000${row.href}\u0000${row.body}`;
}

/** Folds each run of repeats in a newest-first list into its newest row, carrying the run's count. */
function collapse(rows: readonly ActivityFeedItem[]): ActivityFeedItem[] {
  const folded: ActivityFeedItem[] = [];
  for (const row of rows) {
    const last = folded.at(-1);
    if (last !== undefined && collapseKey(last) === collapseKey(row)) {
      folded[folded.length - 1] = { ...last, count: last.count + row.count };
    } else {
      folded.push(row);
    }
  }
  return folded;
}

function asItem(row: ActivityFeedRow): ActivityFeedItem {
  return { ...row, count: 1 };
}

export interface ActivityFeedBatcherOptions {
  /** Batch flush window in ms. Defaults to 100 (plan §5). Overridable for deterministic tests. */
  readonly batchWindowMs?: number;
  /** How many lines the window holds. Defaults to 6: a fixed window of the latest, never a growing list. */
  readonly visibleCap?: number;
  /** Held-while-paused row cap, to bound memory during a long read pause. Defaults to 200. */
  readonly heldCap?: number;
}

const DEFAULT_BATCH_WINDOW_MS = 100;
const DEFAULT_VISIBLE_CAP = 6;
const DEFAULT_HELD_CAP = 200;

/**
 * Batches ingested rows into ≤`batchWindowMs` flushes. While `paused`, newly
 * ingested rows accumulate in a held buffer (surfaced as `pendingCount`)
 * instead of appending to `items` — `resume()` flushes the held buffer into
 * view. Callers wire `pause()`/`resume()` to a hover (or similar
 * read-in-progress) interaction on the feed's DOM container.
 */
export class ActivityFeedBatcher {
  items: ActivityFeedItem[] = $state([]);
  pendingCount: number = $state(0);

  #paused = $state(false);

  get paused(): boolean {
    return this.#paused;
  }

  readonly #batchWindowMs: number;
  readonly #visibleCap: number;
  readonly #heldCap: number;

  #pending: ActivityFeedRow[] = [];
  #held: ActivityFeedRow[] = [];
  #flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ActivityFeedBatcherOptions = {}) {
    this.#batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
    this.#visibleCap = options.visibleCap ?? DEFAULT_VISIBLE_CAP;
    this.#heldCap = options.heldCap ?? DEFAULT_HELD_CAP;
  }

  /**
   * Starts the window from rows that already happened, oldest first, so a page opened after the
   * feed began does not start empty. Only an empty window is seeded: live rows are never replaced.
   */
  seed(rows: readonly ActivityFeedRow[]): void {
    if (this.items.length > 0) return;
    this.items = collapse(rows.toReversed().map(asItem)).slice(0, this.#visibleCap);
  }

  /** Queues a row for the next batch flush. */
  ingest(row: ActivityFeedRow): void {
    this.#pending.push(row);
    this.#scheduleFlush();
  }

  /** Stops new rows from appending to `items`; they accumulate as `pendingCount` instead. */
  pause(): void {
    this.#paused = true;
  }

  /** Resumes live appending and flushes anything held while paused. */
  resume(): void {
    this.#paused = false;
    if (this.#held.length === 0) return;
    this.items = collapse([...this.#held.map(asItem), ...this.items]).slice(0, this.#visibleCap);
    this.#held = [];
    this.pendingCount = 0;
  }

  /** Clears the pending flush timer. Call on unmount so no flush fires after teardown. */
  dispose(): void {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== null) return;
    // poll-reason: timer
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#flushNow();
    }, this.#batchWindowMs);
  }

  #flushNow(): void {
    if (this.#pending.length === 0) return;
    // Newest-first: a batch is ingested oldest-to-newest, so reverse it
    // before prepending onto the (already newest-first) existing list.
    const batch = this.#pending.toReversed();
    this.#pending = [];

    if (this.#paused) {
      this.#held = [...batch, ...this.#held].slice(0, this.#heldCap);
      this.pendingCount = this.#held.length;
      return;
    }

    this.items = collapse([...batch.map(asItem), ...this.items]).slice(0, this.#visibleCap);
  }
}
