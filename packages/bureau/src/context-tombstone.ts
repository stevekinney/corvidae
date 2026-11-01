/**
 * COR-1986 — the fence that keeps a deleted chat deleted.
 *
 * A start on the AG-UI mount sends every row of the conversation, and a thread id that names no
 * session creates one. So a client still open on a chat that was deleted would write the chat
 * back under the same id, with the deleted messages stored again, undoing the purge. Deleting a
 * chat therefore writes one tombstone for its id BEFORE anything is removed, and an AG-UI start
 * or resume on that id is refused with `THREAD_DELETED`.
 *
 * A tombstone holds the context id, the owner of record, and when the delete began, nothing else:
 * no title, no message, no agent. It is permanent, because a client may come back to the id at
 * any later time and nothing else records that the id was ever used; it holds no content, so
 * keeping it keeps nothing the purge removed. The first tombstone stands: a retried delete (after
 * a crash between the tombstone and the removal) leaves the first `deletedAt` alone.
 *
 * Persisted shape (new, versioned; the prefix is disjoint from every other family):
 *
 * - key: `context-tombstone:v1:<encodeStorageKeyComponent(contextId)>`, in the Bureau's
 *   `ConditionalTextValueStore`, the durable view the session store also writes;
 * - value: JSON `{ "version": 1, "contextId": string, "owner": string | null, "deletedAt": number }`,
 *   `deletedAt` in epoch milliseconds on the injected runtime clock, `owner` null for a session
 *   that names none.
 */
import { type ConditionalTextValueStore, encodeStorageKeyComponent } from '@lostgradient/storage';

/** The reserved key prefix of the context tombstones. */
export const CONTEXT_TOMBSTONE_PREFIX = 'context-tombstone:v1:';

/** What a context tombstone records, and all it records. */
export interface ContextTombstone {
  /** The persisted shape's version. */
  readonly version: 1;
  /** The id of the deleted context (the AG-UI thread id). */
  readonly contextId: string;
  /** The owner of record of the deleted context, or `null` when it named none. */
  readonly owner: string | null;
  /** Epoch milliseconds the delete began. */
  readonly deletedAt: number;
}

/** The tombstone key of one context. */
export function contextTombstoneKey(contextId: string): string {
  return `${CONTEXT_TOMBSTONE_PREFIX}${encodeStorageKeyComponent(contextId)}`;
}

/** Reads a stored tombstone, or `undefined` for text this module did not write (another version included). */
export function parseContextTombstone(text: string): ContextTombstone | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;
    const { version, contextId, owner, deletedAt } = value as Record<string, unknown>;
    if (
      version !== 1 ||
      typeof contextId !== 'string' ||
      (owner !== null && typeof owner !== 'string') ||
      typeof deletedAt !== 'number' ||
      !Number.isFinite(deletedAt)
    ) {
      return undefined;
    }
    return { version, contextId, owner, deletedAt };
  } catch {
    return undefined;
  }
}

/**
 * Records that a context was deleted. A tombstone already there is left alone, so the first
 * `deletedAt` stands. Throws only when the store fails, and the caller then deletes nothing.
 */
export async function writeContextTombstone(
  kv: ConditionalTextValueStore,
  tombstone: ContextTombstone,
): Promise<void> {
  const key = contextTombstoneKey(tombstone.contextId);
  await kv.conditionalBatch(
    [{ key, expectedValue: null }],
    [
      {
        type: 'set',
        key,
        value: JSON.stringify({
          version: 1,
          contextId: tombstone.contextId,
          owner: tombstone.owner,
          deletedAt: tombstone.deletedAt,
        } satisfies ContextTombstone),
      },
    ],
  );
}

/**
 * The tombstone of a context: `undefined` when none was written, `'unreadable'` when a record is
 * there that this module cannot read (the id is then treated as deleted, to nobody), and it
 * throws when the store fails.
 */
export async function readContextTombstone(
  kv: ConditionalTextValueStore,
  contextId: string,
): Promise<ContextTombstone | 'unreadable' | undefined> {
  const stored = await kv.get(contextTombstoneKey(contextId));
  if (stored === null) return undefined;
  return parseContextTombstone(stored) ?? 'unreadable';
}
