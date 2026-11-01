/**
 * The notification bell's store. What it holds is about the person, not the engine: a tool waiting
 * for an approval, a question an agent asked, a run that failed, and an answer that arrived
 * (`./notification-items.ts` builds them from the Bureau's reviews, tasks and notifications, the
 * last of which the Bureau keeps and marks read for every browser). The host's own problem is the one other thing it holds: an unreachable or stale engine
 * (`reportEngineStatus`). The engine's event feed (a run started, a signal arrived) is not here;
 * the Engine view's activity feed shows it.
 *
 * The badge counts the items that need the person: approvals, questions, failures, and the host's
 * problem. An answer is listed but never counts. Which items were read is the person's, so it is
 * kept apart from the derived items and survives each refresh, and a reload.
 */
import type { LiveSourceStatus } from '../lib/live-source/index.ts';
import { NAVIGATION_COPY } from './copy.ts';
import type { NotificationEntry } from './notification-items.ts';
import {
  loadReadIds,
  READ_ID_LIMIT,
  saveReadIds,
  type ReadIdStorage,
} from './notification-read-state.ts';

export type {
  NotificationEntry,
  NotificationKind,
  NotificationTier,
} from './notification-items.ts';

export interface NotificationItem extends NotificationEntry {
  read: boolean;
}

/** The one item the host's own problem lives in (`NotificationStore.reportEngineStatus`). */
export const ENGINE_STATUS_ITEM_ID = 'engine-status';

/** What the bell says for each state of the live feed that is a problem; a state with no entry is not one. */
const ENGINE_PROBLEMS: Readonly<
  Partial<Record<LiveSourceStatus, Pick<NotificationEntry, 'tier' | 'icon' | 'title' | 'detail'>>>
> = {
  closed: {
    tier: 'critical',
    icon: 'plug-zap',
    title: NAVIGATION_COPY.engineStatus.closed,
    detail: 'The host did not answer. Check that it is running.',
  },
  stale: {
    tier: 'warning',
    icon: 'triangle-alert',
    title: NAVIGATION_COPY.engineStatus.stale,
    detail: 'The server has not reported in a while. What you see may be out of date.',
  },
};

/** What the store tells the Bureau about the notifications it holds. */
export interface NotificationRemote {
  /**
   * The Bureau's notifications with these identifiers were read here. It settles when the Bureau
   * has them as read; a rejection means it does not, and the store holds them as unread again.
   */
  readonly markRead: (
    notificationIds: readonly string[],
    options?: { readonly all?: boolean },
  ) => void | Promise<void>;
  /** Reads what the bell lists again, for a list that could not be loaded. */
  readonly reload?: () => void;
}

export interface NotificationStoreOptions {
  /** Where read ids are kept; the browser's local storage by default. */
  readonly storage?: ReadIdStorage;
}

export class NotificationStore {
  readonly #storage: ReadIdStorage | undefined;
  #remote: NotificationRemote | undefined;
  #readIds: string[] = $state([]);
  #activity: NotificationEntry[] = $state([]);
  #engineProblem: NotificationEntry | undefined = $state();
  #loadFailed = $state(false);
  /** Items read here whose Bureau has not yet said it holds them as read. Memory only: a closed tab must not leave them read for good. */
  #awaiting: string[] = $state([]);
  /** Items the Bureau refused to hold as read, which are unread until they are read again. */
  #refused: string[] = $state([]);

  constructor(options: NotificationStoreOptions = {}) {
    this.#storage = options.storage;
    this.#readIds = options.storage === undefined ? loadReadIds() : loadReadIds(options.storage);
  }

  readonly #items: NotificationItem[] = $derived.by(() => {
    const read = new Set([...this.#readIds, ...this.#awaiting]);
    const entries = this.#engineProblem === undefined ? [] : [this.#engineProblem];
    return [...entries, ...this.#activity].map((entry) => ({
      ...entry,
      read: read.has(entry.id) || entry.serverRead === true,
    }));
  });

  /** Every item, the host's problem first, then what needs the person, then what only finished. */
  get items(): readonly NotificationItem[] {
    return this.#items;
  }

  /** How many unread items need the person; an answer never counts. */
  get unreadCount(): number {
    return this.items.filter((item) => !item.read && item.tier !== 'info').length;
  }

  /** Unread critical items only: what the dismissible strip below the header shows. */
  get criticalUnread(): NotificationItem[] {
    return this.items.filter((item) => item.tier === 'critical' && !item.read);
  }

  /**
   * Whether what the Bureau lists could not be read. The list is then what was read last, which
   * may be nothing, so it must not be taken for "nothing needs you".
   */
  get loadFailed(): boolean {
    return this.#loadFailed;
  }

  /** Whether the Bureau refused to hold an item as read that is still unread, so it is unread everywhere. */
  get readFailed(): boolean {
    return this.#refused.some((id) => this.items.some((item) => item.id === id && !item.read));
  }

  /** Says whether what the Bureau lists could not be read. */
  setLoadFailed(failed: boolean): void {
    this.#loadFailed = failed;
  }

  /** Reads what the bell lists again. */
  reload(): void {
    this.#remote?.reload?.();
  }

  /** Connects the store to the Bureau, so reading an item it holds a notification for is told to it. */
  setRemote(remote: NotificationRemote | undefined): void {
    this.#remote = remote;
  }

  /** Replaces the items derived from the Bureau's reviews, tasks and notifications. */
  setActivity(entries: readonly NotificationEntry[]): void {
    this.#activity = [...entries];
  }

  /**
   * Keeps the host's own problem in the list: an unreachable or stale engine is one item under a
   * fixed id, so a connection that flaps between states replaces it rather than stacking a new
   * one for each drop, and a recovery removes it. The same state again leaves the item, and
   * whether it has been read, as it was.
   */
  reportEngineStatus(status: LiveSourceStatus, nowMs: number): void {
    const problem = ENGINE_PROBLEMS[status];
    const current = this.#engineProblem;
    if (problem === undefined) {
      if (current !== undefined) this.#forget(ENGINE_STATUS_ITEM_ID);
      this.#engineProblem = undefined;
      return;
    }
    if (current?.title === problem.title) return;
    this.#forget(ENGINE_STATUS_ITEM_ID);
    this.#engineProblem = {
      id: ENGINE_STATUS_ITEM_ID,
      kind: 'engine',
      identifiers: [],
      joiner: ': ',
      href: '/health',
      emittedAtMs: nowMs,
      ...problem,
    };
  }

  /**
   * Reads everything listed, and tells the Bureau to read every notification it holds for the
   * person, not only the newest it lists. The ids go in oldest first, because the buffer of read ids keeps the
   * newest ones when it is over its cap: with more items than the cap, it is the oldest that are
   * forgotten, never the ones just read.
   */
  markAllRead(): void {
    const oldestFirst = [...this.items].sort((left, right) => left.emittedAtMs - right.emittedAtMs);
    this.#markRead(
      oldestFirst.map((item) => item.id),
      true,
    );
  }

  markRead(id: string): void {
    this.#markRead([id]);
  }

  /**
   * Opening a chat reads what is about it: its approval, its question, its answer. An item the
   * Bureau refused is left alone: this runs from an effect that tracks the items, so trying it
   * again would loop; only an explicit read ({@link markRead}, {@link markAllRead}) tries again.
   */
  markSessionRead(sessionId: string): void {
    this.#markRead(
      this.items
        .filter((item) => item.sessionId === sessionId && !this.#refused.includes(item.id))
        .map((item) => item.id),
    );
  }

  /** Dismisses one item from the critical strip; it stays, read, in the bell. */
  dismissCritical(id: string): void {
    if (this.items.some((item) => item.id === id && item.tier === 'critical')) this.markRead(id);
  }

  #markRead(ids: readonly string[], all = false): void {
    const unread = ids.filter((id) => !this.#readIds.includes(id) && !this.#awaiting.includes(id));
    // Another browser reads the Bureau's copy, so a notification is read here only for as long as
    // the Bureau has not refused it, and is kept in this browser once the Bureau has taken it.
    const told = this.#remote === undefined ? [] : this.#toTell(unread);
    const waitingOn = new Set(told.map((item) => item.id));
    const kept = unread.filter((id) => !waitingOn.has(id));
    if (kept.length > 0) this.#keep(kept);
    if (waitingOn.size > 0) this.#awaiting = [...this.#awaiting, ...waitingOn];
    this.#tellRemote(told, all);
  }

  /** Keeps these items read in this browser, across a reload. */
  #keep(ids: readonly string[]): void {
    this.#readIds = [...this.#readIds, ...ids].slice(-READ_ID_LIMIT);
    saveReadIds(this.#readIds, this.#storage);
  }

  /** The unread items among `ids` that are the Bureau's notifications, so another browser reads them too. */
  #toTell(ids: readonly string[]): NotificationItem[] {
    const wanted = new Set(ids);
    return this.items.filter(
      (item) => wanted.has(item.id) && !item.read && item.notificationId !== undefined,
    );
  }

  /**
   * Tells the Bureau that these items were read. They are read here at once, in memory, and kept
   * once the Bureau holds them as read. An item the Bureau does not accept is unread again, so it
   * never reads as delivered in this browser and new in the other.
   */
  #tellRemote(told: readonly NotificationItem[], all: boolean): void {
    if (this.#remote === undefined || told.length === 0) return;
    const ids = new Set(told.map((item) => item.id));
    const notificationIds = told.flatMap((item) =>
      item.notificationId === undefined ? [] : [item.notificationId],
    );
    const settled = (): void => {
      this.#awaiting = this.#awaiting.filter((id) => !ids.has(id));
    };
    const accepted = (): void => {
      settled();
      this.#refused = this.#refused.filter((id) => !ids.has(id));
      this.#keep([...ids]);
    };
    const refused = (): void => {
      settled();
      this.#refused = [...this.#refused.filter((id) => !ids.has(id)), ...ids];
    };
    try {
      Promise.resolve(this.#remote.markRead(notificationIds, all ? { all: true } : undefined)).then(
        () => {
          accepted();
          return undefined;
        },
        () => {
          refused();
          return undefined;
        },
      );
    } catch {
      refused();
    }
  }

  #forget(id: string): void {
    if (!this.#readIds.includes(id)) return;
    this.#readIds = this.#readIds.filter((read) => read !== id);
    saveReadIds(this.#readIds, this.#storage);
  }
}
