/**
 * The notification store (COR-1941): persisted, owner-scoped notifications.
 *
 * ## Keys
 *
 * Every key starts with {@link NOTIFICATION_KEY_PREFIX}, and every component after it is
 * percent-encoded, so no owner, id or dedupe key can be the prefix of another:
 *
 * - `bureau-notification:v1:r:<owner>:<id>` holds one {@link NotificationRecord} as JSON. The owner is
 *   in the key, so a read for an owner is one prefix scan and can never return another owner's
 *   record.
 * - `bureau-notification:v1:d:<dedupeKey>:<owner>` holds the id of the record written under that
 *   dedupe key. It is written in the same conditional batch as the record, so two writers with one
 *   key (a replayed event, a second process) produce one record. It is keyed by the dedupe key
 *   first so a review that closes can find its notification without knowing the owner.
 *
 * ## Reads and writes
 *
 * A record changes in place by compare-and-swap on the text it was read as, and a lost race rereads
 * and tries again. Dismissing keeps the record (and its dedupe key), so an event that is replayed
 * after the owner dismissed the notification does not bring it back; retention removes both.
 *
 * ## Bounds
 *
 * An owner keeps at most {@link NOTIFICATION_LIMIT_PER_OWNER} notifications; writing one past it
 * removes the oldest. `retention.notifications` removes records older than its window.
 *
 * @module notification-store
 */

import { sha256HexSync } from '@lostgradient/cryptography';
import {
  type ConditionalTextValueStore,
  type TextValueStoreBatchOperation,
  decodeStorageKeyComponent,
  encodeStorageKeyComponent,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/storage';
import type { RuntimeClock, RuntimeIdentifiers } from '@lostgradient/lifecycle';
import { z } from 'zod';

import { serializeUnknownError } from '../serialization.ts';
import type { DiagnosticSink } from '../types.ts';
import {
  type BureauNotification,
  type BureauNotifications,
  NOTIFICATION_FIELD_LIMITS,
  NOTIFICATION_KIND_PATTERN,
  NOTIFICATION_LIMIT_PER_OWNER,
  type NotificationInput,
  type NotificationListQuery,
  type NotificationPage,
  NotificationPageTokenError,
  type NotificationSelection,
  type NotificationSubject,
} from './notification-types.ts';

/** The prefix of every key the notification store writes. */
export const NOTIFICATION_KEY_PREFIX = 'bureau-notification:v1:';

/** How many notifications a page holds when the query names no limit. */
export const DEFAULT_NOTIFICATION_PAGE_LIMIT = 50;

/** The most notifications one page may hold. */
export const MAXIMUM_NOTIFICATION_PAGE_LIMIT = 100;

/** How many times a change that lost a compare-and-swap race is tried again. */
const CHANGE_ATTEMPTS = 4;

const boundedString = (limit: number) => z.string().min(1).max(limit);

const subjectSchema = z
  .object({
    runId: boundedString(NOTIFICATION_FIELD_LIMITS.subject).optional(),
    contextId: boundedString(NOTIFICATION_FIELD_LIMITS.subject).optional(),
    reviewId: boundedString(NOTIFICATION_FIELD_LIMITS.subject).optional(),
    reviewKind: z.enum(['tool-approval', 'human-wait']).optional(),
    agentName: boundedString(NOTIFICATION_FIELD_LIMITS.subject).optional(),
    scheduleId: boundedString(NOTIFICATION_FIELD_LIMITS.subject).optional(),
  })
  .strict();

/** The stored record. `owner` is on every one, so a later release can add users without migrating. */
const recordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  owner: z.string().min(1),
  kind: z.string().regex(NOTIFICATION_KIND_PATTERN).max(NOTIFICATION_FIELD_LIMITS.kind),
  title: boundedString(NOTIFICATION_FIELD_LIMITS.title),
  body: z.string().max(NOTIFICATION_FIELD_LIMITS.body).nullable(),
  link: z.string().max(NOTIFICATION_FIELD_LIMITS.link).nullable(),
  dedupeKey: z.string().max(NOTIFICATION_FIELD_LIMITS.dedupeKey).nullable(),
  subject: subjectSchema.nullable(),
  createdAt: z.string().min(1),
  readAt: z.string().nullable(),
  dismissedAt: z.string().nullable(),
});

/** One stored notification. */
export type NotificationRecord = z.infer<typeof recordSchema>;

/** What a held record is: its parsed value and the exact text it was read as. */
type HeldRecord = {
  readonly key: string;
  readonly raw: string;
  readonly record: NotificationRecord;
};

/** The store, with the operations the built-in notifications need beside the public surface. */
export interface NotificationStore extends BureauNotifications {
  /**
   * Dismisses the notification written under `dedupeKey`, for every owner that has one. Resolves
   * how many it changed. A review that closes dismisses its `review.waiting` notification this way.
   */
  dismissByDedupeKey(dedupeKey: string): Promise<number>;
  /** Removes every notification written before `cutoffMilliseconds` (epoch ms). Resolves how many. */
  prune(cutoffMilliseconds: number): Promise<number>;
}

/** Options for {@link createNotificationStore}. */
export interface CreateNotificationStoreOptions {
  /** The Bureau's key-value store. Absent, the notifications are kept in memory. */
  readonly kv?: ConditionalTextValueStore | undefined;
  readonly clock: Pick<RuntimeClock, 'nowISO'>;
  readonly identifiers: RuntimeIdentifiers;
  readonly diagnose: DiagnosticSink;
  /** Builds the error `create` rejects with for an input that does not meet its bounds. */
  readonly refusal: (message: string) => Error;
  /** How many notifications an owner keeps. Defaults to {@link NOTIFICATION_LIMIT_PER_OWNER}; a test lowers it. */
  readonly limitPerOwner?: number | undefined;
}

const recordPrefix = `${NOTIFICATION_KEY_PREFIX}r:`;
const dedupePrefix = `${NOTIFICATION_KEY_PREFIX}d:`;

function ownerPrefix(owner: string): string {
  return `${recordPrefix}${encodeStorageKeyComponent(owner)}:`;
}

function recordKey(owner: string, id: string): string {
  return `${ownerPrefix(owner)}${encodeStorageKeyComponent(id)}`;
}

function dedupeKeyPrefix(dedupeKey: string): string {
  return `${dedupePrefix}${encodeStorageKeyComponent(dedupeKey)}:`;
}

function dedupeIndexKey(owner: string, dedupeKey: string): string {
  return `${dedupeKeyPrefix(dedupeKey)}${encodeStorageKeyComponent(owner)}`;
}

function viewOf(record: NotificationRecord): BureauNotification {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    body: record.body,
    link: record.link,
    subject: record.subject === null ? null : { ...record.subject },
    createdAt: record.createdAt,
    readAt: record.readAt,
    dismissedAt: record.dismissedAt,
  };
}

/** Newest first; the id breaks a tie so the order does not move between reads. */
function newestFirst(left: NotificationRecord, right: NotificationRecord): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

function isLink(link: string): boolean {
  return /^\/(?!\/)/.test(link) || /^https?:\/\/\S+$/i.test(link);
}

/** The first thing wrong with `input`, or `undefined` when it meets its bounds. */
function inputDefect(input: NotificationInput): string | undefined {
  const text = (name: keyof typeof NOTIFICATION_FIELD_LIMITS, value: string | undefined) =>
    value !== undefined && (value.length === 0 || value.length > NOTIFICATION_FIELD_LIMITS[name])
      ? `"${name}" must be 1 to ${NOTIFICATION_FIELD_LIMITS[name]} characters`
      : undefined;
  if (typeof input.owner !== 'string' || input.owner === '') return '"owner" must not be empty';
  if (!NOTIFICATION_KIND_PATTERN.test(input.kind) || input.kind.length > 64) {
    return '"kind" must be lowercase words joined by "." or "-", at most 64 characters';
  }
  const defect =
    text('title', input.title) ??
    text('body', input.body) ??
    text('link', input.link) ??
    text('dedupeKey', input.dedupeKey);
  if (defect !== undefined) return defect;
  if (input.link !== undefined && !isLink(input.link)) {
    return '"link" must be an application path starting with one "/", or an http(s) URL';
  }
  if (input.subject !== undefined && !subjectSchema.safeParse(input.subject).success) {
    return '"subject" has an unknown key or a field that is empty, too long, or of the wrong kind';
  }
  return undefined;
}

function filtersDigest(query: NotificationListQuery): string {
  return sha256HexSync(
    JSON.stringify([
      query.owner,
      query.unread === true,
      query.kind ?? null,
      query.includeDismissed === true,
    ]),
  );
}

type PageToken = { readonly digest: string; readonly createdAt: string; readonly id: string };

function encodePageToken(token: PageToken): string {
  return Buffer.from(JSON.stringify([token.digest, token.createdAt, token.id]), 'utf8').toString(
    'base64url',
  );
}

function decodePageToken(text: string): PageToken {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 3) {
      const [digest, createdAt, id] = parsed as unknown[];
      if (
        typeof digest === 'string' &&
        typeof createdAt === 'string' &&
        typeof id === 'string' &&
        id !== ''
      ) {
        return { digest, createdAt, id };
      }
    }
  } catch {
    // Falls through: not base64url JSON.
  }
  throw new NotificationPageTokenError('malformed');
}

/** Whether `record` sorts after the position `token` names, in {@link newestFirst} order. */
function afterToken(record: NotificationRecord, token: PageToken): boolean {
  if (record.createdAt !== token.createdAt) return record.createdAt < token.createdAt;
  return record.id < token.id;
}

/** Creates the notification store. */
export function createNotificationStore(
  options: CreateNotificationStoreOptions,
): NotificationStore {
  const kv = options.kv ?? textValueStore(new MemoryStorage());

  function parse(key: string, raw: string): HeldRecord | undefined {
    try {
      const parsed = recordSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return { key, raw, record: parsed.data };
      throw new Error(parsed.error.message);
    } catch (error) {
      options.diagnose({
        level: 'error',
        scope: 'notifications',
        message: `[bureau] The notification record at "${key}" is not a version 1 record and is skipped: ${serializeUnknownError(error)}`,
        cause: error,
      });
      return undefined;
    }
  }

  async function readKeys(keys: readonly string[]): Promise<HeldRecord[]> {
    const held: HeldRecord[] = [];
    for (const key of keys) {
      const raw = await kv.get(key);
      if (raw === null) continue;
      const entry = parse(key, raw);
      if (entry !== undefined) held.push(entry);
    }
    return held;
  }

  async function ownerRecords(owner: string): Promise<HeldRecord[]> {
    return readKeys(await kv.list(ownerPrefix(owner)));
  }

  async function remove(entries: readonly HeldRecord[]): Promise<number> {
    let removed = 0;
    for (const { key, record } of entries) {
      await kv.delete(key);
      if (record.dedupeKey !== null) {
        await kv.delete(dedupeIndexKey(record.owner, record.dedupeKey));
      }
      removed += 1;
    }
    return removed;
  }

  /** Removes the oldest notifications of `owner` beyond the cap. */
  async function enforceLimit(owner: string): Promise<void> {
    const keys = await kv.list(ownerPrefix(owner));
    const limit = options.limitPerOwner ?? NOTIFICATION_LIMIT_PER_OWNER;
    if (keys.length <= limit) return;
    const read = await readKeys(keys);
    const held = read.toSorted((left, right) => newestFirst(right.record, left.record));
    await remove(held.slice(0, Math.max(0, held.length - limit)));
  }

  /** Applies `change` to a held record by compare-and-swap; resolves whether it changed one. */
  async function change(
    entry: HeldRecord,
    next: (record: NotificationRecord) => NotificationRecord | undefined,
  ): Promise<boolean> {
    let current: HeldRecord | undefined = entry;
    for (let attempt = 0; attempt < CHANGE_ATTEMPTS && current !== undefined; attempt += 1) {
      const updated = next(current.record);
      if (updated === undefined) return false;
      const swapped = await kv.conditionalBatch(
        [{ key: current.key, expectedValue: current.raw }],
        [{ type: 'set', key: current.key, value: JSON.stringify(updated) }],
      );
      if (swapped) return true;
      const raw = await kv.get(current.key);
      current = raw === null ? undefined : parse(current.key, raw);
    }
    return false;
  }

  async function selected(selection: NotificationSelection): Promise<HeldRecord[]> {
    if (selection.all === true) return ownerRecords(selection.owner);
    const ids = [...new Set(selection.ids ?? [])];
    return readKeys(ids.map((id) => recordKey(selection.owner, id)));
  }

  async function changeSelected(
    selection: NotificationSelection,
    next: (record: NotificationRecord, at: string) => NotificationRecord | undefined,
  ): Promise<number> {
    // Read before the first await: the caller owns `selection` and may reuse it.
    const owner = selection.owner;
    const at = options.clock.nowISO();
    let changed = 0;
    for (const entry of await selected(selection)) {
      if (entry.record.owner !== owner) continue;
      if (await change(entry, (record) => next(record, at))) changed += 1;
    }
    return changed;
  }

  const markReadChange = (record: NotificationRecord, at: string) =>
    record.readAt === null ? { ...record, readAt: at } : undefined;
  const dismissChange = (record: NotificationRecord, at: string) =>
    record.dismissedAt === null
      ? { ...record, dismissedAt: at, readAt: record.readAt ?? at }
      : undefined;

  /** Writes the record, or resolves `undefined` when its key or its dedupe key is already taken. */
  async function writeRecord(input: NotificationInput): Promise<BureauNotification | undefined> {
    // Read before the first await: the caller owns `input` and may reuse it.
    const owner = input.owner;
    const dedupeKey = input.dedupeKey ?? null;
    const record: NotificationRecord = {
      schemaVersion: 1,
      id: options.identifiers.next('notification'),
      owner,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
      dedupeKey,
      subject:
        input.subject === undefined ? null : subjectSchema.parse(stripUndefined(input.subject)),
      createdAt: options.clock.nowISO(),
      readAt: null,
      dismissedAt: null,
    };
    const key = recordKey(owner, record.id);
    const conditions = [{ key, expectedValue: null as string | null }];
    const writes: TextValueStoreBatchOperation[] = [
      { type: 'set', key, value: JSON.stringify(record) },
    ];
    if (dedupeKey !== null) {
      const indexKey = dedupeIndexKey(owner, dedupeKey);
      conditions.push({ key: indexKey, expectedValue: null });
      writes.push({ type: 'set', key: indexKey, value: record.id });
    }
    if (await kv.conditionalBatch(conditions, writes)) {
      // The record is committed: a failure trimming the owner's oldest is reported and repaired by
      // the next write, never turned into a failed create of a notification that exists.
      try {
        await enforceLimit(owner);
      } catch (error: unknown) {
        options.diagnose({
          level: 'error',
          scope: 'notifications',
          message: `[bureau] Could not trim the oldest notifications of "${owner}": ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
      return viewOf(record);
    }
    return undefined;
  }

  /** The notification already written under `dedupeKey` for `owner`, or `undefined`. */
  async function existingUnder(owner: string, dedupeKey: string): Promise<HeldRecord | undefined> {
    const id = await kv.get(dedupeIndexKey(owner, dedupeKey));
    if (id === null) return undefined;
    const [entry] = await readKeys([recordKey(owner, id)]);
    return entry;
  }

  return {
    async create(given) {
      // Snapshot before the first await: the caller owns `given` and may reuse it, and the retry
      // below must write the notification that was validated.
      const input: NotificationInput = {
        ...given,
        ...(given.subject === undefined ? {} : { subject: { ...given.subject } }),
      };
      const defect = inputDefect(input);
      if (defect !== undefined) throw options.refusal(`Cannot create the notification: ${defect}`);
      const { owner, dedupeKey } = input;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const written = await writeRecord(input);
        if (written !== undefined) return { notification: written, created: true };
        if (dedupeKey === undefined) break;
        const existing = await existingUnder(owner, dedupeKey);
        if (existing !== undefined)
          return { notification: viewOf(existing.record), created: false };
        // An index whose record is gone (a pruned record, a torn write) is repaired, then tried again.
        await kv.delete(dedupeIndexKey(owner, dedupeKey));
      }
      throw new Error('[bureau] Could not write the notification: its key was already taken.');
    },

    async list(given) {
      // Snapshot before the first await: the caller owns `given` and may reuse it.
      const query = { ...given };
      const digest = filtersDigest(query);
      const token = query.pageToken === undefined ? undefined : decodePageToken(query.pageToken);
      if (token !== undefined && token.digest !== digest) {
        throw new NotificationPageTokenError('mismatch');
      }
      const limit = Math.min(
        Math.max(1, Math.trunc(query.limit ?? DEFAULT_NOTIFICATION_PAGE_LIMIT)),
        MAXIMUM_NOTIFICATION_PAGE_LIMIT,
      );
      const owned = await ownerRecords(query.owner);
      const matching = owned
        .map((entry) => entry.record)
        .filter(
          (record) =>
            (query.includeDismissed === true || record.dismissedAt === null) &&
            (query.unread !== true || record.readAt === null) &&
            (query.kind === undefined || record.kind === query.kind) &&
            (token === undefined || afterToken(record, token)),
        )
        .toSorted(newestFirst);
      const page = matching.slice(0, limit);
      const last = page.at(-1);
      return {
        notifications: page.map(viewOf),
        nextPageToken:
          matching.length > limit && last !== undefined
            ? encodePageToken({ digest, createdAt: last.createdAt, id: last.id })
            : null,
      } satisfies NotificationPage;
    },

    markRead: (selection) => changeSelected(selection, markReadChange),

    dismiss: (selection) => changeSelected(selection, dismissChange),

    async dismissByDedupeKey(dedupeKey) {
      const at = options.clock.nowISO();
      let changed = 0;
      for (const indexKey of await kv.list(dedupeKeyPrefix(dedupeKey))) {
        const id = await kv.get(indexKey);
        if (id === null) continue;
        // The index key ends in the encoded owner, which the record key repeats.
        const owner = decodeStorageKeyComponent(indexKey.slice(dedupeKeyPrefix(dedupeKey).length));
        const [entry] = await readKeys([recordKey(owner, id)]);
        if (entry !== undefined && (await change(entry, (record) => dismissChange(record, at)))) {
          changed += 1;
        }
      }
      return changed;
    },

    async prune(cutoffMilliseconds) {
      const stale: HeldRecord[] = [];
      for (const entry of await readKeys(await kv.list(recordPrefix))) {
        if (Date.parse(entry.record.createdAt) < cutoffMilliseconds) stale.push(entry);
      }
      return remove(stale);
    },
  };
}

function stripUndefined(subject: NotificationSubject): Record<string, string> {
  return Object.fromEntries(Object.entries(subject).filter(([, value]) => value !== undefined));
}
