import type { JSONValue } from '../types';

/**
 * The session metadata key holding a title a person gave the session (COR-1909). Written by a
 * rename and removed by clearing it, so a session that was never renamed records nothing and every
 * session written before renames existed reads as it always did: the summary's title is the derived
 * one. The session store reads it when it builds a summary, so a renamed title is part of the
 * summary index and a listing can filter by it before it pages.
 */
export const SESSION_TITLE_METADATA_KEY = 'sessionTitle';

/** The most characters a title a person gives a session may hold. */
export const SESSION_TITLE_OVERRIDE_LIMIT = 200;

/**
 * The title a session's metadata records, or `null` when it records none. A value that is not
 * non-empty text reads as none, so a malformed record falls back to the derived title instead of
 * showing a blank one.
 */
export function sessionTitleOverrideOf(
  metadata: Readonly<Record<string, JSONValue>>,
): string | null {
  const stored = metadata[SESSION_TITLE_METADATA_KEY];
  return typeof stored === 'string' && stored.trim() !== '' ? stored : null;
}
