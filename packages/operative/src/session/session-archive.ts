import type { JSONValue } from '../types';

/**
 * The session metadata key holding when a person archived the session, as an ISO 8601 timestamp
 * (COR-2285). Written by an archive and removed by an unarchive, so a session that was never
 * archived records nothing and every session written before archiving existed reads as not
 * archived: no stored session needs migrating. The summary index keeps each session's metadata,
 * so a listing filters on it before it pages.
 */
export const SESSION_ARCHIVED_AT_METADATA_KEY = 'sessionArchivedAt';

/**
 * Which sessions a listing keeps by whether they are archived: `include` (every session, what a
 * listing that does not say does), `exclude` (only the sessions that are not archived), or `only`
 * (only the archived ones).
 */
export type SessionArchivedFilter = 'include' | 'exclude' | 'only';

/**
 * When the session whose metadata is `metadata` was archived, or `null` when it is not archived. A
 * value that is not text naming a valid instant reads as not archived, so a malformed record never
 * hides a session or refuses work in it.
 */
export function sessionArchivedAtOf(metadata: Readonly<Record<string, JSONValue>>): string | null {
  if (!Object.hasOwn(metadata, SESSION_ARCHIVED_AT_METADATA_KEY)) return null;
  const stored = metadata[SESSION_ARCHIVED_AT_METADATA_KEY];
  return typeof stored === 'string' && stored.trim() !== '' && !Number.isNaN(Date.parse(stored))
    ? stored
    : null;
}

/** Whether a session whose metadata is `metadata` is kept by the archived filter `filter`. */
export function matchesArchivedFilter(
  metadata: Readonly<Record<string, JSONValue>>,
  filter: SessionArchivedFilter | undefined,
): boolean {
  if (filter === undefined || filter === 'include') return true;
  const archived = sessionArchivedAtOf(metadata) !== null;
  return filter === 'only' ? archived : !archived;
}
