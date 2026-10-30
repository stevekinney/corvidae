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
    detail: 'The engine has not reported in a while. What you see may be out of date.',
  },
};

/** What the store tells the Bureau about the notifications it holds. */
export interface NotificationRemote {
  /** The Bureau's notifications with these identifiers were read here. */
  readonly markRead: (notificationIds: readonly string[]) => void;
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

  constructor(options: NotificationStoreOptions = {}) {
    this.#storage = options.storage;
    this.#readIds = options.storage === undefined ? loadReadIds() : loadReadIds(options.storage);
  }

  readonly #items: NotificationItem[] = $derived.by(() => {
    const read = new Set(this.#readIds);
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
      href: '/engine',
      emittedAtMs: nowMs,
      ...problem,
    };
  }

  /**
   * Reads everything listed. The ids go in oldest first, because the buffer of read ids keeps the
   * newest ones when it is over its cap: with more items than the cap, it is the oldest that are
   * forgotten, never the ones just read.
   */
  markAllRead(): void {
    const oldestFirst = [...this.items].sort((left, right) => left.emittedAtMs - right.emittedAtMs);
    this.#markRead(oldestFirst.map((item) => item.id));
  }

  markRead(id: string): void {
    this.#markRead([id]);
  }

  /** Opening a chat reads what is about it: its approval, its question, its answer. */
  markSessionRead(sessionId: string): void {
    this.#markRead(
      this.items.filter((item) => item.sessionId === sessionId).map((item) => item.id),
    );
  }

  /** Dismisses one item from the critical strip; it stays, read, in the bell. */
  dismissCritical(id: string): void {
    if (this.items.some((item) => item.id === id && item.tier === 'critical')) this.markRead(id);
  }

  #markRead(ids: readonly string[]): void {
    const unread = ids.filter((id) => !this.#readIds.includes(id));
    this.#tellRemote(unread);
    if (unread.length === 0) return;
    this.#readIds = [...this.#readIds, ...unread].slice(-READ_ID_LIMIT);
    saveReadIds(this.#readIds, this.#storage);
  }

  /** Tells the Bureau which of these items are its notifications, and that they were read. */
  #tellRemote(ids: readonly string[]): void {
    if (this.#remote === undefined) return;
    const wanted = new Set(ids);
    const notificationIds = this.items.flatMap((item) =>
      wanted.has(item.id) && !item.read && item.notificationId !== undefined
        ? [item.notificationId]
        : [],
    );
    if (notificationIds.length > 0) this.#remote.markRead(notificationIds);
  }

  #forget(id: string): void {
    if (!this.#readIds.includes(id)) return;
    this.#readIds = this.#readIds.filter((read) => read !== id);
    saveReadIds(this.#readIds, this.#storage);
  }
}
