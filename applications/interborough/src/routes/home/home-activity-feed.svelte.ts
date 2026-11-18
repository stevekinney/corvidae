/**
 * What one of Home's activity bands shows, and how it follows its feed (COR-2227).
 *
 * **The window.** A band reads its recent window from what its feed source retains: the fleet
 * source's `recent()` and the Bureau source's `recent()`, which holds the replay the Bureau source
 * held back. It reads the window when the band opens on a source that has caught up, each time the
 * source catches up again after a reconnect, and on the Bureau feed's `feed.resync`, `feed.gap` and
 * `frames.dropped`, and replaces its rows with the window's newest in one step. Replayed envelopes
 * are never added one at a time: the fleet band ignores frames until its source has caught up, and
 * the Bureau source never dispatches them. Live events after that are added at the top.
 *
 * **The hold.** While keyboard focus is inside the band's list, a pointer that can hover is over it,
 * or a press that began in it is still down, arrivals and the window's replacement wait, and no row
 * moves, enters or leaves; they are applied in one step once all three have ended. The hold has no
 * time limit, by design: a timeout would move rows under a resting pointer. Side by side each band
 * holds only its own rows. Stacked, Workflow activity sits over Agent activity, so a change in its
 * height moves the other band: there the hold of either band holds both (`ActivityRegion`, F7-39).
 */
import { getContext, hasContext, setContext, untrack } from 'svelte';

import { formatBureauEvents, type FormattedBureauEvent } from '../../lib/bureau-event-format.ts';
import {
  BUREAU_RESYNC_KIND,
  isRecoveryKind,
  type BureauEventFrame,
} from '../../lib/live-source/bureau-event-frame.ts';
import type { BureauEventSource } from '../../lib/live-source/bureau-event-source.svelte.ts';
import type { FleetEventSource } from '../../lib/live-source/fleet-event-source.svelte.ts';
import { createSerialQueue } from '../../lib/serial-queue.ts';
import {
  ACTIVITY_ROW_LIMIT,
  ACTIVITY_WINDOW_LIMIT,
  bureauEntry,
  fleetEntry,
  listsFleetKind,
  newestFirst,
  type ActivityEntry,
} from './home-activity-rows.ts';

/**
 * Home's activity region, which both bands sit in: whether its bands are stacked, read from the
 * layout itself (the region's container query lays the bands out as a grid side by side), and the
 * bands' feeds, so that stacked the hold of either band holds both.
 */
export class ActivityRegion {
  #feeds = new Set<ActivityFeed>();
  #lists = new Set<HTMLElement>();
  #bands: HTMLElement | undefined;

  /** Attach to the element the bands are laid out in. */
  readonly attach = (bands: HTMLElement): (() => void) => {
    this.#bands = bands;
    return () => {
      if (this.#bands === bands) this.#bands = undefined;
    };
  };

  /**
   * Whether the bands are stacked, one over the other, so one band's height moves the other. A
   * region that has left the page lays nothing out, so its bands are not stacked.
   */
  get stacked(): boolean {
    return this.#bands?.isConnected === true && getComputedStyle(this.#bands).display !== 'grid';
  }

  /** Adds a band's feed to the region; returns what takes it out. */
  join(feed: ActivityFeed): () => void {
    this.#feeds.add(feed);
    return () => {
      this.#feeds.delete(feed);
      this.release();
    };
  }

  /** Adds a band's list, which a hold is attached to; returns what takes it out. */
  addList(list: HTMLElement): () => void {
    this.#lists.add(list);
    return () => {
      this.#lists.delete(list);
    };
  }

  /** Whether `node` is inside one of the bands' lists. */
  inList(node: Node): boolean {
    for (const list of this.#lists) if (list.contains(node)) return true;
    return false;
  }

  /** Whether a band other than `feed`'s holds `feed`'s rows: only while the bands are stacked. */
  holdsBeyond(feed: ActivityFeed): boolean {
    if (!this.stacked) return false;
    for (const other of this.#feeds) if (other !== feed && other.holding) return true;
    return false;
  }

  /**
   * A hold ended: stacked, each band but `drawn`, which drew already, draws what it held, if
   * nothing holds it still. Side by side a band's hold never held the other's rows.
   */
  release(drawn?: ActivityFeed): void {
    if (!this.stacked) return;
    for (const feed of this.#feeds) if (feed !== drawn) feed.draw();
  }
}

const ACTIVITY_REGION_CONTEXT_KEY = Symbol('interborough-home-activity-region');

/** Provides Home's activity region to the bands rendered in it. Call it while a component initializes. */
export function provideActivityRegion(region: ActivityRegion): void {
  setContext(ACTIVITY_REGION_CONTEXT_KEY, region);
}

/** The activity region a band is rendered in, or `undefined` outside one. */
export function useActivityRegion(): ActivityRegion | undefined {
  return hasContext(ACTIVITY_REGION_CONTEXT_KEY)
    ? getContext<ActivityRegion>(ACTIVITY_REGION_CONTEXT_KEY)
    : undefined;
}

/** The rows one band draws, newest first, held while a person is on the list. */
export class ActivityFeed {
  /** Whether the first window has been read; until then the band shows placeholders. */
  ready = $state(false);
  /** The rows drawn now, newest first, at most {@link ACTIVITY_ROW_LIMIT}. */
  shown: readonly ActivityEntry[] = $state([]);
  /** The keys of the rows drawn now that arrived live, which fade in. */
  arrived: ReadonlySet<string> = $state(new Set());

  /** Every event kept, newest first, at most {@link ACTIVITY_WINDOW_LIMIT}. */
  #entries: ActivityEntry[] = [];
  /** Keys that arrived live since the rows were last drawn. */
  #arrivedSinceDrawn = new Set<string>();
  /** Whether the window replaced the rows since they were last drawn, so nothing fades in. */
  #replacedSinceDrawn = false;
  #focusInside = false;
  #pointerOver = false;
  #pressInside = false;
  readonly #region: ActivityRegion | undefined;

  /** `region` is the activity region the band sits in, whose other band can hold this one's rows. */
  constructor(region?: ActivityRegion) {
    this.#region = region;
  }

  /**
   * Replaces every row with `entries` (oldest first), the newest shown, in one step. The first
   * window replaces the placeholders at once, even while the other band holds: the band becomes
   * `ready` with it, so holding it would show the band empty, and stacked the placeholders may
   * move the band under them (F7-08). Only arrivals and later windows are held (F7-39).
   */
  replace(entries: readonly ActivityEntry[]): void {
    const first = !this.ready;
    this.#entries = newestFirst(entries);
    this.#arrivedSinceDrawn.clear();
    this.#replacedSinceDrawn = true;
    this.ready = true;
    if (first) this.#paint();
    else this.draw();
  }

  /** Adds live `entries` (oldest first) at the top; one already kept is not added again. */
  add(entries: readonly ActivityEntry[]): void {
    if (!this.ready) return;
    const kept = new Set(this.#entries.map((entry) => entry.key));
    const fresh = entries.filter((entry) => !kept.has(entry.key));
    if (fresh.length === 0) return;
    this.#entries = newestFirst([...this.#entries.toReversed(), ...fresh]);
    for (const entry of fresh) this.#arrivedSinceDrawn.add(entry.key);
    this.draw();
  }

  /** Whether this band's own list holds: focus, a hovering pointer or a press is in it. */
  get holding(): boolean {
    return this.#focusInside || this.#pointerOver || this.#pressInside;
  }

  /** Whether arrivals wait: this band's list holds, or, stacked, the other band's does. */
  get held(): boolean {
    return this.holding || (this.#region?.holdsBeyond(this) ?? false);
  }

  /**
   * Draws what arrived since the rows were last drawn, unless the rows are held. With nothing
   * waiting it writes nothing.
   */
  draw(): void {
    if (this.#arrivedSinceDrawn.size === 0 && !this.#replacedSinceDrawn) return;
    if (!this.held) this.#paint();
  }

  #paint(): void {
    const shown = this.#entries.slice(0, ACTIVITY_ROW_LIMIT);
    const keys = new Set(shown.map((entry) => entry.key));
    const before = this.#replacedSinceDrawn ? [] : untrack(() => [...this.arrived]);
    this.arrived = new Set([...before, ...this.#arrivedSinceDrawn].filter((key) => keys.has(key)));
    this.#arrivedSinceDrawn.clear();
    this.#replacedSinceDrawn = false;
    this.shown = shown;
  }

  /**
   * Attach to the element around the list: focus inside it, a hovering pointer over it, or a press
   * that began in it holds the rows, and they are drawn once all three have ended. Stacked, it holds
   * the other band's rows too, and its end draws both.
   *
   * The end of a hold draws in a microtask, never in the event. Chromium fires `focusout`
   * synchronously as a focused link is removed, and following a link removes Home inside the
   * router's block effect, where Svelte forbids a state write (`state_unsafe_mutation`). By the
   * microtask the teardown has finished, and a list that has left draws nothing.
   */
  readonly hold = (node: HTMLElement): (() => void) => {
    const region = this.#region;
    const leaveRegion = region?.addList(node);
    let attached = true;
    const release = (): void => {
      queueMicrotask(() => {
        if (!attached) return;
        this.draw();
        region?.release(this);
      });
    };
    const onFocusIn = (): void => {
      this.#focusInside = true;
    };
    const onFocusOut = (event: FocusEvent): void => {
      const next = event.relatedTarget;
      this.#focusInside = next instanceof Node && node.contains(next);
      // Stacked, focus moving on into the other band's list keeps both held: its focusin follows,
      // and releasing in between would move that list under the focus arriving in it.
      if (next instanceof Node && region?.stacked === true && region.inList(next)) return;
      release();
    };
    const onPointerEnter = (event: PointerEvent): void => {
      if (event.pointerType !== 'touch') this.#pointerOver = true;
    };
    const onPointerLeave = (): void => {
      this.#pointerOver = false;
      release();
    };
    const onPressEnd = (): void => {
      window.removeEventListener('pointerup', onPressEnd);
      window.removeEventListener('pointercancel', onPressEnd);
      this.#pressInside = false;
      release();
    };
    const onPointerDown = (): void => {
      this.#pressInside = true;
      window.addEventListener('pointerup', onPressEnd);
      window.addEventListener('pointercancel', onPressEnd);
    };
    node.addEventListener('focusin', onFocusIn);
    node.addEventListener('focusout', onFocusOut);
    node.addEventListener('pointerenter', onPointerEnter);
    node.addEventListener('pointerleave', onPointerLeave);
    node.addEventListener('pointerdown', onPointerDown);
    return () => {
      attached = false;
      node.removeEventListener('focusin', onFocusIn);
      node.removeEventListener('focusout', onFocusOut);
      node.removeEventListener('pointerenter', onPointerEnter);
      node.removeEventListener('pointerleave', onPointerLeave);
      node.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPressEnd);
      window.removeEventListener('pointercancel', onPressEnd);
      leaveRegion?.();
      this.#focusInside = false;
      this.#pointerOver = false;
      this.#pressInside = false;
    };
  };
}

/** How a band follows its feed: read the window, and follow what arrives after it. */
export interface ActivityFollower {
  /** Reads the recent window from the source and replaces the rows with it. */
  readWindow(): void;
  /** Starts following live events; returns what stops it. */
  start(): () => void;
}

/** Workflow activity's follower: the fleet source's retained frames, worded by the band's rules. */
export function followFleetActivity(
  feed: ActivityFeed,
  source: FleetEventSource,
): ActivityFollower {
  return {
    readWindow() {
      feed.replace(
        source
          .recent()
          .filter((frame) => listsFleetKind(frame.kind))
          .map((frame) => fleetEntry(frame)),
      );
    },
    start() {
      return source.subscribe((frame) => {
        // A replayed frame is part of the window read when the replay ends, never a row of its own.
        if (!source.caughtUp || !listsFleetKind(frame.kind)) return;
        feed.add([fleetEntry(frame)]);
      });
    },
  };
}

/** How the Bureau band words envelopes: `formatBureauEvents`, which a test may stand in for. */
export type BureauFormatter = (
  envelopes: readonly BureauEventFrame[],
) => Promise<(FormattedBureauEvent | null)[]>;

/**
 * Agent activity's follower: the Bureau source's retained envelopes, worded through
 * `bureau.events.format`. Window reads and arrivals are worded one after another, in the order they
 * came, so an arrival is never drawn under a window read before it.
 */
export function followBureauActivity(
  feed: ActivityFeed,
  source: BureauEventSource,
  format: BureauFormatter = formatBureauEvents,
): ActivityFollower {
  const queue = createSerialQueue();
  // Each stop starts a new generation, so a call still being worded when the band stopped
  // following its feed draws nothing.
  let generation = 0;
  let arrivals: BureauEventFrame[] = [];
  let lastWindow: string | undefined;

  const readWindow = (): void => {
    const queuedIn = generation;
    void queue.run(async () => {
      const envelopes = source.recent(ACTIVITY_WINDOW_LIMIT);
      // The same window read twice (a catch-up and its resync) is worded once.
      const signature = `${String(envelopes.length)}:${envelopes[0]?.cursor ?? ''}:${envelopes.at(-1)?.cursor ?? ''}`;
      if (signature === lastWindow) return;
      lastWindow = signature;
      const answers = await format(envelopes);
      if (queuedIn !== generation) return;
      feed.replace(
        envelopes.map((envelope, index) => bureauEntry(envelope, answers[index] ?? null)),
      );
    });
  };

  const wordArrivals = (): void => {
    const queuedIn = generation;
    void queue.run(async () => {
      const batch = arrivals;
      arrivals = [];
      if (batch.length === 0) return;
      const answers = await format(batch);
      if (queuedIn !== generation) return;
      feed.add(batch.map((envelope, index) => bureauEntry(envelope, answers[index] ?? null)));
    });
  };

  return {
    readWindow,
    start() {
      const unsubscribe = source.subscribe((frame) => {
        if (frame.kind === BUREAU_RESYNC_KIND || isRecoveryKind(frame.kind)) {
          readWindow();
          return;
        }
        arrivals.push(frame);
        wordArrivals();
      });
      return () => {
        generation += 1;
        arrivals = [];
        lastWindow = undefined;
        unsubscribe();
      };
    },
  };
}
