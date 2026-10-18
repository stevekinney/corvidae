import type { JSONValue } from '@lostgradient/operative';

import { ANONYMOUS_LOCAL_OWNER } from './owner-of-record';

/** Whether `value` is a plain object, the shape every persisted authority and owner map decodes as. */
export function isPlainAuthorityRecord(
  value: JSONValue | undefined,
): value is Record<string, JSONValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The session metadata key holding the session's owner of record. Written once,
 * when the session is created, with the owner of the run that created it. It is
 * a key of its own, not derived from `lastRunOwningPrincipals`, because that map
 * is pruned once a run's history falls below the retention floor, and a session
 * must not change owner when it is.
 */
export const SESSION_OWNER_METADATA_KEY = 'sessionOwner';

/**
 * The owner of record a session's metadata names: the stored owner, or
 * {@link ANONYMOUS_LOCAL_OWNER} for a session written before owners existed (a
 * read rule, not a migration). `undefined` means the key is present but not a
 * string, which no principal can match: a corrupted record fails closed rather
 * than reading as the local owner's.
 */
export function resolveSessionOwner(metadata: Record<string, JSONValue>): string | undefined {
  const stored = metadata[SESSION_OWNER_METADATA_KEY];
  if (stored === undefined) return ANONYMOUS_LOCAL_OWNER;
  return typeof stored === 'string' ? stored : undefined;
}

/**
 * Thrown from inside a session's atomic update when the save names an owner other
 * than the one the stored session already has. The preflight ownership check reads
 * the session before the save, so two principals racing to create one new session
 * can both pass it; this is the check that holds when the stored session is
 * decided, and it refuses the later save before its messages are appended.
 */
export class SessionOwnerConflictError extends Error {
  constructor(sessionId: string) {
    super(`Session "${sessionId}" not found`);
    this.name = 'SessionOwnerConflictError';
  }
}

/**
 * Whether `principal` is the owner of a session recording the given metadata.
 * Every resource has an owner, so a session with nothing recorded belongs to
 * {@link ANONYMOUS_LOCAL_OWNER} and admits no one else; AB-42's "open session"
 * rule is gone. A principal that is not the owner gets the verdict a session that
 * does not exist gets, so a caller cannot tell the two apart.
 *
 * `targetRunId` no longer changes the verdict. Authority used to be recorded per
 * run, so which run a request targeted decided whose entry it was checked
 * against; the owner is now the session's, and a run started on the session by
 * anyone else is refused, so every run on a session shares it. The parameter
 * stays so the session verbs' call sites do not change.
 */
export function isSessionAuthorityAuthorized(
  metadata: Record<string, JSONValue>,
  principal: string,
  _targetRunId?: string,
): boolean {
  return resolveSessionOwner(metadata) === principal;
}

/**
 * Whether `principal` may read a session-scoped durable event history
 * (`Bureau.eventHistory({ kind: 'session', id })`, COR-1382). Only the session's
 * owner may: the same comparison {@link isSessionAuthorityAuthorized} makes.
 */
export function isSessionHistoryReadAuthorized(
  metadata: Record<string, JSONValue>,
  principal: string,
): boolean {
  return isSessionAuthorityAuthorized(metadata, principal);
}

/**
 * The owning principal persisted for `runId` in a session's
 * `lastRunOwningPrincipals` map (AB-359), or `undefined` when nothing was
 * recorded, the map itself is malformed, or the recorded entry for this
 * `runId` isn't a string. Every one of those cases decodes to `undefined`
 * on purpose: an older record written before this field existed has no
 * `lastRunOwningPrincipals` key at all, and must decode with ownership
 * absent rather than throw or be treated as corrupt — exactly the same
 * schema-version-tolerant contract {@link UnsupportedDurableEventSchemaVersionError}
 * enforces for a durable event record's own payload wrapper. `undefined`
 * here is consumed by `reattachRecoveredRun`, which then leaves
 * `runAttribution` for this run unset — reproducing AB-313's existing
 * fail-closed behavior for "no principal recorded" after a restart, the
 * same as it already does live.
 */
export function resolvePersistedRunOwningPrincipal(
  metadata: Record<string, JSONValue>,
  runId: string,
): string | undefined {
  const owners = metadata['lastRunOwningPrincipals'];
  if (!isPlainAuthorityRecord(owners)) return undefined;
  const principal = owners[runId];
  return typeof principal === 'string' ? principal : undefined;
}

/**
 * Whether a session has no run in progress: its most recently persisted run
 * (`metadata['lastRunStatus']`, the field {@link requireSessionRunId} and
 * {@link hasRecoverableTransportAuthority} also read) is not `'running'`, AND
 * `liveRunIds`, the session's runs that the caller's live-run registry
 * still holds as running, is empty. `lastRunStatus` is last-write-wins across
 * concurrent runs, so the run that went terminal last can overwrite it while
 * an older run on the same session is still running; the live-run set is
 * what keeps that session from reading as terminal (COR-301). With the
 * default empty set this reads `lastRunStatus` alone.
 */
export function isSessionRunTerminal(
  metadata: Record<string, JSONValue>,
  liveRunIds: readonly string[] = [],
): boolean {
  return metadata['lastRunStatus'] !== 'running' && liveRunIds.length === 0;
}

/**
 * The pre-admission verdict both session verbs (`submitSessionInput`,
 * `submitSteeringCommand`) share, in AB-42's fixed order: authorization
 * first (`'not-found'`), then session lifecycle (`'session-terminal'`), else
 * `'proceed'` to the verb's own capability and admission checks.
 *
 * `liveRunIds` is the session's still-running runs as the caller's live-run
 * registry reports them (COR-301). Authorization compares `principal` with the
 * session's owner ({@link isSessionAuthorityAuthorized}), which does not depend
 * on the run a request targets; `explicitRunId` is accepted so the verbs'
 * call sites are unchanged. The session is terminal only when its last persisted
 * run is not running and no run is live ({@link isSessionRunTerminal}).
 */
export function resolveSessionPreAdmission(
  metadata: Record<string, JSONValue>,
  principal: string,
  liveRunIds: readonly string[],
  explicitRunId?: string,
): 'not-found' | 'session-terminal' | 'proceed' {
  if (!isSessionAuthorityAuthorized(metadata, principal, explicitRunId)) return 'not-found';
  if (isSessionRunTerminal(metadata, liveRunIds)) return 'session-terminal';
  return 'proceed';
}
