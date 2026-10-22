import type { JSONValue } from '../types';

/**
 * The session metadata key holding the id of the session this one was branched from
 * (COR-1560). Written once, when the branch is created, so a listing shows where a session came
 * from before it has a run. Like the owner key, the summary index copies it.
 */
export const SESSION_PARENT_METADATA_KEY = 'sessionParent';

/**
 * The session metadata key holding the id of the message this session was branched at: the
 * parent's message whose history the branch shares up to and including.
 */
export const SESSION_FORKED_FROM_MESSAGE_METADATA_KEY = 'sessionForkedFromMessage';

/** Where a session came from: both `null` for a session that was not branched. */
export interface SessionLineage {
  /** The session this one was branched from, or `null`. */
  readonly parentContextId: string | null;
  /** The message of that session it was branched at, or `null`. */
  readonly forkedFromMessageId: string | null;
}

function textOrNull(value: JSONValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * The lineage a session's metadata records. A key that is absent, or is not text, reads `null`: a
 * session written before lineage existed has none, and a malformed record shows none rather than
 * a parent no one wrote.
 */
export function sessionLineageOf(metadata: Readonly<Record<string, JSONValue>>): SessionLineage {
  return {
    parentContextId: textOrNull(metadata[SESSION_PARENT_METADATA_KEY]),
    forkedFromMessageId: textOrNull(metadata[SESSION_FORKED_FROM_MESSAGE_METADATA_KEY]),
  };
}
