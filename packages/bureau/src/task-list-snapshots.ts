/**
 * The snapshots `bureau.tasks.list` pages through (COR-1304).
 *
 * The first page of a listing that has a next page records the ordered listing as it matched at
 * that moment, and the page token names that record. Every later page reads the record, so a task
 * that changes, or leaves, between pages neither moves nor appears twice. All authority comes from
 * the stored record: a token is only a pointer, and a forged one re-reads the caller's own record
 * or is rejected.
 *
 * A record holds at most {@link TASK_LISTING_MAXIMUM_ENTRIES} entries and
 * {@link TASK_LISTING_MAXIMUM_BYTES} bytes of serialized text. A longer listing is a chain of
 * windows: each window is its own record, built fresh, strictly after the key of the previous
 * window's last entry, and all windows of one listing share one expiry.
 *
 * Keys are `bureau-task-listing:v2:<principal>:<expiry>:<listing>:<window>`, so the sweep that
 * deletes expired records and the per-principal cap read keys alone, never a record.
 *
 * @module task-list-snapshots
 */

import { type ConditionalTextValueStore, encodeStorageKeyComponent } from '@lostgradient/storage';

/**
 * The key prefix of a task-listing snapshot. A snapshot stores whole task views, so the version
 * moves with the view's shape: `v2` (COR-1689) added `kind`, and a `v1` snapshot is never read as a
 * view that lacks it. A `v1` record left in storage is not read, and is not swept.
 */
export const TASK_LISTING_KEY_PREFIX = 'bureau-task-listing:v2:';

/** How long a listing's tokens work, counted from the moment its first page was served. */
export const TASK_LISTING_LIFETIME_MILLISECONDS = 15 * 60 * 1000;

/** The most entries one snapshot record holds. */
export const TASK_LISTING_MAXIMUM_ENTRIES = 1000;

/** The most serialized UTF-8 bytes one snapshot record holds. */
export const TASK_LISTING_MAXIMUM_BYTES = 4 * 1024 * 1024;

/** The most live listings one principal holds; starting another deletes its oldest. */
export const TASK_LISTING_MAXIMUM_PER_PRINCIPAL = 16;

/** Room kept inside the byte bound for the record's own fields around its entries. */
const RECORD_ENVELOPE_BYTES = 16 * 1024;

/** Why a page token was refused. */
export type TaskListingTokenFailure =
  'malformed' | 'not-found' | 'expired' | 'reach' | 'projection' | 'filters' | 'context-changed';

/**
 * A page token `bureau.tasks.list` refuses: it is not a token, names no live snapshot (a token of
 * another principal names none, because a snapshot is keyed by its principal), was issued for
 * another reach or other filters, or names a context that was deleted
 * and recreated since. The management operation answers it as `InvalidParams`.
 */
export class TaskListingTokenError extends Error {
  readonly reason: TaskListingTokenFailure;

  constructor(reason: TaskListingTokenFailure) {
    super(`The page token is not valid for this request (${reason}); list again without it.`);
    this.name = 'TaskListingTokenError';
    this.reason = reason;
  }
}

/** The filters a listing was started with. Absent filters are `null`; the timestamp is epoch ms. */
export interface TaskListingFilters {
  readonly contextId: string | null;
  readonly agentName: string | null;
  readonly status: string | null;
  readonly statusTimestampAfter: number | null;
}

/** Who a listing belongs to, and how far its reach goes. */
export interface TaskListingScope {
  readonly principal: string;
  readonly reach: 'own' | 'every-owner';
  /**
   * The wire projection the entries are in (`'task-view'` for a native listing, `'a2a'` for an A2A
   * `ListTasks`). A token replayed to another projection would serve entries of the wrong shape.
   */
  readonly projection: string;
  readonly filters: TaskListingFilters;
}

/** A position in the listing order: later in the order means older, then larger by id. */
export interface TaskListingKey {
  readonly at: number;
  readonly id: string;
}

/** One entry of a snapshot: its position key, and what the page returns for it. */
export interface TaskListingEntry<T> extends TaskListingKey {
  readonly value: T;
}

/** A stored snapshot window. */
export interface TaskListingRecord<T> extends TaskListingScope {
  readonly listingId: string;
  readonly window: number;
  /** The incarnation `filters.contextId` resolved to (`''` for none), or `null` with no context. */
  readonly incarnation: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly entries: readonly TaskListingEntry<T>[];
  /** The key the next window starts strictly after, or `null` when this window ends the listing. */
  readonly continuation: TaskListingKey | null;
  /** How many tasks the listing matched when its first page was read, across every window. */
  readonly total: number;
}

/** The decoded page token. */
export interface TaskListingToken {
  readonly listingId: string;
  readonly window: number;
  readonly expiresAt: number;
  /** How many entries of the window earlier pages consumed. */
  readonly position: number;
}

/**
 * Orders keys the way a listing does: most recent status change first, then id ascending, as A2A's
 * reference orders tasks that share a status timestamp.
 */
export function compareListingKeys(left: TaskListingKey, right: TaskListingKey): number {
  if (left.at !== right.at) return left.at < right.at ? 1 : -1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/** Whether `key` comes strictly after `after` in listing order. */
export function isAfterListingKey(key: TaskListingKey, after: TaskListingKey): boolean {
  return compareListingKeys(key, after) > 0;
}

/** Encodes a token as opaque base64url text. */
export function encodeListingToken(token: TaskListingToken): string {
  const text = JSON.stringify([token.listingId, token.window, token.expiresAt, token.position]);
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Decodes a token, or throws a `malformed` {@link TaskListingTokenError}. */
export function decodeListingToken(text: string): TaskListingToken {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 4) {
      const [listingId, window, expiresAt, position] = parsed as unknown[];
      if (
        typeof listingId === 'string' &&
        listingId !== '' &&
        Number.isSafeInteger(window) &&
        Number.isSafeInteger(expiresAt) &&
        Number.isSafeInteger(position) &&
        (window as number) >= 0 &&
        (position as number) >= 0
      ) {
        return {
          listingId,
          window: window as number,
          expiresAt: expiresAt as number,
          position: position as number,
        };
      }
    }
  } catch {
    // Falls through: not base64url JSON.
  }
  throw new TaskListingTokenError('malformed');
}

/** The serialized UTF-8 size of one entry, counting its separator. */
export function listingEntryBytes(entry: TaskListingEntry<unknown>): number {
  return new TextEncoder().encode(JSON.stringify(entry)).byteLength + 1;
}

/**
 * Whether another entry of `entryBytes` still fits a window that holds `count` entries in
 * `bytes`. A window always takes its first entry, so a listing always advances.
 */
export function fitsListingWindow(count: number, bytes: number, entryBytes: number): boolean {
  if (count === 0) return true;
  return (
    count < TASK_LISTING_MAXIMUM_ENTRIES &&
    bytes + entryBytes <= TASK_LISTING_MAXIMUM_BYTES - RECORD_ENVELOPE_BYTES
  );
}

function pad(value: number): string {
  return String(value).padStart(16, '0');
}

function principalPrefix(principal: string): string {
  return `${TASK_LISTING_KEY_PREFIX}${encodeStorageKeyComponent(principal)}:`;
}

/** The key of one window of a listing. */
export function listingKey(
  principal: string,
  expiresAt: number,
  listingId: string,
  window: number,
): string {
  return `${principalPrefix(principal)}${pad(expiresAt)}:${encodeStorageKeyComponent(listingId)}:${window}`;
}

type ParsedKey = { readonly key: string; readonly expiresAt: number; readonly listing: string };

function parseListingKey(key: string, prefix: string): ParsedKey | undefined {
  const parts = key.slice(prefix.length).split(':');
  const expiresAt = Number(parts.at(-3));
  if (parts.length < 3 || !Number.isSafeInteger(expiresAt)) return undefined;
  return { key, expiresAt, listing: parts.at(-2) ?? '' };
}

function sameFilters(left: TaskListingFilters, right: TaskListingFilters): boolean {
  return (
    left.contextId === right.contextId &&
    left.agentName === right.agentName &&
    left.status === right.status &&
    left.statusTimestampAfter === right.statusTimestampAfter
  );
}

/** What {@link createTaskListingStore} needs. */
export interface TaskListingStoreOptions {
  readonly kv: ConditionalTextValueStore;
  /** Epoch milliseconds now. */
  readonly now: () => number;
}

/** The persistence of task-listing snapshots. */
export interface TaskListingStore {
  /** Reads a window by token and checks it belongs to `scope`, or throws a typed refusal. */
  load<T>(token: TaskListingToken, scope: TaskListingScope): Promise<TaskListingRecord<T>>;
  /** Reads a window if it is stored, for building the next window idempotently. */
  find<T>(
    scope: TaskListingScope,
    listingId: string,
    expiresAt: number,
    window: number,
  ): Promise<TaskListingRecord<T> | undefined>;
  /** Writes a window. A first window then trims its principal's listings to the cap. */
  save<T>(record: TaskListingRecord<T>): Promise<void>;
  /** Deletes every window whose listing has expired, reading no record. Resolves the count. */
  expire(): Promise<number>;
}

/** Builds the snapshot store over `options.kv`. */
export function createTaskListingStore(options: TaskListingStoreOptions): TaskListingStore {
  const { kv, now } = options;

  async function read<T>(key: string): Promise<TaskListingRecord<T> | undefined> {
    const raw = await kv.get(key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as TaskListingRecord<T>;
    } catch {
      return undefined;
    }
  }

  function check(record: TaskListingRecord<unknown>, scope: TaskListingScope): void {
    if (record.reach !== scope.reach) throw new TaskListingTokenError('reach');
    if (record.projection !== scope.projection) throw new TaskListingTokenError('projection');
    if (!sameFilters(record.filters, scope.filters)) throw new TaskListingTokenError('filters');
  }

  /**
   * Deletes a principal's oldest listings beyond the cap. It runs after a first window is
   * written, so concurrent starts that each write before any of them trims still end within the
   * cap: whichever trim runs last sees every listing.
   */
  async function trimToCap(principal: string): Promise<void> {
    const prefix = principalPrefix(principal);
    const listings = new Map<string, { expiresAt: number; keys: string[] }>();
    for (const key of await kv.list(prefix)) {
      const parsed = parseListingKey(key, prefix);
      if (parsed === undefined) continue;
      const held = listings.get(parsed.listing) ?? { expiresAt: parsed.expiresAt, keys: [] };
      held.keys.push(key);
      listings.set(parsed.listing, held);
    }
    const oldestFirst = [...listings.entries()].toSorted(
      ([leftId, left], [rightId, right]) =>
        left.expiresAt - right.expiresAt || (leftId < rightId ? -1 : 1),
    );
    let live = oldestFirst.length;
    for (const [, listing] of oldestFirst) {
      if (live <= TASK_LISTING_MAXIMUM_PER_PRINCIPAL) break;
      for (const key of listing.keys) await kv.delete(key);
      live -= 1;
    }
  }

  return {
    async load<T>(token: TaskListingToken, scope: TaskListingScope) {
      const key = listingKey(scope.principal, token.expiresAt, token.listingId, token.window);
      const record = await read<T>(key);
      if (record === undefined) throw new TaskListingTokenError('not-found');
      if (now() >= record.expiresAt) throw new TaskListingTokenError('expired');
      check(record, scope);
      return record;
    },

    async find<T>(scope: TaskListingScope, listingId: string, expiresAt: number, window: number) {
      return read<T>(listingKey(scope.principal, expiresAt, listingId, window));
    },

    async save<T>(record: TaskListingRecord<T>) {
      await kv.set(
        listingKey(record.principal, record.expiresAt, record.listingId, record.window),
        JSON.stringify(record),
      );
      if (record.window === 0) await trimToCap(record.principal);
    },

    async expire() {
      let removed = 0;
      const current = now();
      for (const key of await kv.list(TASK_LISTING_KEY_PREFIX)) {
        const parsed = parseListingKey(key, TASK_LISTING_KEY_PREFIX);
        // The principal component comes first, so the expiry sits third from the end.
        if (parsed === undefined || parsed.expiresAt > current) continue;
        await kv.delete(key);
        removed += 1;
      }
      return removed;
    },
  };
}
