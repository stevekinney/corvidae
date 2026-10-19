import type { JSONValue } from '../types';

/**
 * The session metadata key holding the session's owner of record. Written once,
 * when the session is created, with the owner of the run that created it. It is a
 * key of its own, not derived from any per-run record, because those are pruned
 * once a run's history falls below a retention floor, and a session must not
 * change owner when they are.
 *
 * The session store reads it when it builds a summary, so the owner is part of
 * the summary index and a listing can filter by it before it pages.
 */
export const SESSION_OWNER_METADATA_KEY = 'sessionOwner';

/**
 * The owner of a session whose metadata records none: a session written before
 * owners existed, or by a host that states no principal. A read rule, not a
 * migration. Bureau's `ANONYMOUS_LOCAL_OWNER` is the same string, and a Bureau test
 * keeps the two equal.
 */
export const LOCAL_SESSION_OWNER = 'anonymous:local';

/**
 * The owner of record a session's metadata names: the stored owner, or
 * {@link LOCAL_SESSION_OWNER} when it names none. `null` means the key is present
 * but not text, which no principal can match: a corrupted record fails closed
 * rather than reading as the local owner's.
 */
export function sessionOwnerOf(metadata: Readonly<Record<string, JSONValue>>): string | null {
  const stored = metadata[SESSION_OWNER_METADATA_KEY];
  if (stored === undefined) return LOCAL_SESSION_OWNER;
  return typeof stored === 'string' ? stored : null;
}
