import type { JSONValue } from '../types';

/**
 * The session metadata key holding what started the session (COR-1645). Written once, when the
 * session is created, by whatever creates it: a goal writes `goal` and a schedule's fire writes
 * `schedule`. A person's chat writes nothing, so the absence of the key is the chat. Like the
 * owner key, the summary index carries it in the metadata it copies, so a listing can filter by it
 * before it pages.
 */
export const SESSION_ORIGIN_METADATA_KEY = 'sessionOrigin';

/** What can start a session. */
export const SESSION_ORIGINS = ['chat', 'goal', 'schedule'] as const;

/** What started a session: a person's chat, a goal, or a schedule's fire. */
export type SessionOrigin = (typeof SESSION_ORIGINS)[number];

/**
 * The origin of a session that records none: one a person started, and every session written
 * before origins existed. A read rule, not a migration.
 */
export const DEFAULT_SESSION_ORIGIN: SessionOrigin = 'chat';

/**
 * The origin a session's metadata records. A key that is absent, or holds anything that is not one
 * of {@link SESSION_ORIGINS}, reads {@link DEFAULT_SESSION_ORIGIN}: a session written before
 * origins existed is a person's, and a malformed record shows a chat rather than hiding a session
 * from the person who owns it.
 */
export function sessionOriginOf(metadata: Readonly<Record<string, JSONValue>>): SessionOrigin {
  const stored = metadata[SESSION_ORIGIN_METADATA_KEY];
  return SESSION_ORIGINS.find((origin) => origin === stored) ?? DEFAULT_SESSION_ORIGIN;
}
