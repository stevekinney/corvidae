import type { JSONValue } from '../types';

/** Durable metadata for explicit read-only access to a session. */
export const SESSION_READ_GRANTS_METADATA_KEY = 'sessionReadGrants';
/** Append-only grant and revocation facts for audit and former-reader admission. */
export const SESSION_READ_GRANT_HISTORY_METADATA_KEY = 'sessionReadGrantHistory';
export const SESSION_READ_REQUESTS_METADATA_KEY = 'sessionReadRequests';

export type SessionReadRequest = Readonly<{
  requestId: string;
  owner: string;
  workspaceId: string;
  actorId: string;
  requestedAt: string;
  resolvedAt?: string | undefined;
  resolvedBy?: string | undefined;
  decision?: 'granted' | 'denied' | undefined;
}>;

/** One current or former reader, recorded in session metadata with its grant state. */
export type SessionReadGrant = Readonly<{
  owner: string;
  workspaceId: string;
  actorId: string;
  sessionIncarnation: string;
  grantedBy: string;
  grantedAt: string;
  revokedAt?: string | undefined;
  revokedBy?: string | undefined;
}>;

export type SessionReadGrantEvent = Readonly<{
  owner: string;
  workspaceId: string;
  actorId: string;
  kind: 'granted' | 'revoked';
  actor: string;
  at: string;
  changed: boolean;
}>;

function isRecord(value: JSONValue | undefined): value is Record<string, JSONValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function grantOf(value: JSONValue): SessionReadGrant | undefined {
  if (!isRecord(value)) return undefined;
  const {
    owner,
    workspaceId,
    actorId,
    sessionIncarnation,
    grantedBy,
    grantedAt,
    revokedAt,
    revokedBy,
  } = value;
  if (typeof owner !== 'string' || owner === '') return undefined;
  if (typeof workspaceId !== 'string' || workspaceId === '') return undefined;
  if (typeof actorId !== 'string' || actorId === '') return undefined;
  if (typeof sessionIncarnation !== 'string' || sessionIncarnation === '') return undefined;
  if (typeof grantedBy !== 'string' || grantedBy === '') return undefined;
  if (typeof grantedAt !== 'string' || grantedAt === '') return undefined;
  if (revokedAt !== undefined && (typeof revokedAt !== 'string' || revokedAt === ''))
    return undefined;
  if (revokedBy !== undefined && (typeof revokedBy !== 'string' || revokedBy === ''))
    return undefined;
  if ((revokedAt === undefined) !== (revokedBy === undefined)) return undefined;
  return {
    owner,
    workspaceId,
    actorId,
    sessionIncarnation,
    grantedBy,
    grantedAt,
    ...(revokedAt === undefined ? {} : { revokedAt }),
    ...(revokedBy === undefined ? {} : { revokedBy }),
  };
}

function eventOf(value: JSONValue): SessionReadGrantEvent | undefined {
  if (!isRecord(value)) return undefined;
  const { owner, workspaceId, actorId, kind, actor, at, changed } = value;
  if (
    typeof owner !== 'string' ||
    owner === '' ||
    typeof workspaceId !== 'string' ||
    workspaceId === '' ||
    typeof actorId !== 'string' ||
    actorId === '' ||
    (kind !== 'granted' && kind !== 'revoked') ||
    typeof actor !== 'string' ||
    actor === '' ||
    typeof at !== 'string' ||
    at === '' ||
    typeof changed !== 'boolean'
  )
    return undefined;
  return { owner, workspaceId, actorId, kind, actor, at, changed };
}

function jsonGrant(grant: SessionReadGrant): JSONValue {
  return {
    owner: grant.owner,
    workspaceId: grant.workspaceId,
    actorId: grant.actorId,
    sessionIncarnation: grant.sessionIncarnation,
    grantedBy: grant.grantedBy,
    grantedAt: grant.grantedAt,
    ...(grant.revokedAt === undefined ? {} : { revokedAt: grant.revokedAt }),
    ...(grant.revokedBy === undefined ? {} : { revokedBy: grant.revokedBy }),
  };
}

function jsonEvent(event: SessionReadGrantEvent): JSONValue {
  return {
    owner: event.owner,
    workspaceId: event.workspaceId,
    actorId: event.actorId,
    kind: event.kind,
    actor: event.actor,
    at: event.at,
    changed: event.changed,
  };
}

function requestOf(value: JSONValue): SessionReadRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { requestId, owner, workspaceId, actorId, requestedAt, resolvedAt, resolvedBy, decision } =
    value;
  if (
    [requestId, owner, workspaceId, actorId, requestedAt].some(
      (field) => typeof field !== 'string' || field === '',
    )
  )
    return undefined;
  if (
    (resolvedAt === undefined) !== (resolvedBy === undefined) ||
    (resolvedAt === undefined) !== (decision === undefined)
  )
    return undefined;
  if (
    resolvedAt !== undefined &&
    (typeof resolvedAt !== 'string' ||
      resolvedAt === '' ||
      typeof resolvedBy !== 'string' ||
      resolvedBy === '' ||
      (decision !== 'granted' && decision !== 'denied'))
  )
    return undefined;
  return {
    requestId: requestId as string,
    owner: owner as string,
    workspaceId: workspaceId as string,
    actorId: actorId as string,
    requestedAt: requestedAt as string,
    ...(resolvedAt === undefined
      ? {}
      : {
          resolvedAt,
          resolvedBy: typeof resolvedBy === 'string' ? resolvedBy : '',
          decision: decision as 'granted' | 'denied',
        }),
  };
}

export function sessionReadRequestsOf(
  metadata: Readonly<Record<string, JSONValue>>,
): readonly SessionReadRequest[] {
  const stored = metadata[SESSION_READ_REQUESTS_METADATA_KEY];
  if (!Array.isArray(stored)) return [];
  const requests = stored.map(requestOf);
  return requests.some((request) => request === undefined)
    ? []
    : (requests as SessionReadRequest[]);
}

/** Adds a single pending request for a former reader; retries retain its original receipt. */
export function withSessionReadRequest(
  metadata: Readonly<Record<string, JSONValue>>,
  request: SessionReadRequest,
): Record<string, JSONValue> {
  const requests = sessionReadRequestsOf(metadata);
  if (
    requests.some(
      (candidate) => candidate.owner === request.owner && candidate.resolvedAt === undefined,
    )
  )
    return { ...metadata };
  return {
    ...metadata,
    [SESSION_READ_REQUESTS_METADATA_KEY]: [...requests, request].map((candidate) => ({
      requestId: candidate.requestId,
      owner: candidate.owner,
      workspaceId: candidate.workspaceId,
      actorId: candidate.actorId,
      requestedAt: candidate.requestedAt,
      ...(candidate.resolvedAt === undefined
        ? {}
        : {
            resolvedAt: candidate.resolvedAt,
            resolvedBy: candidate.resolvedBy!,
            decision: candidate.decision!,
          }),
    })),
  };
}

/** Settles the one pending request for a reader without changing access itself. */
export function withSessionReadRequestResolution(
  metadata: Readonly<Record<string, JSONValue>>,
  owner: string,
  requestId: string,
  decision: 'granted' | 'denied',
  resolvedBy: string,
  resolvedAt: string,
): Record<string, JSONValue> {
  const requests = sessionReadRequestsOf(metadata);
  let changed = false;
  const settled = requests.map((request) => {
    if (
      request.owner !== owner ||
      request.requestId !== requestId ||
      request.resolvedAt !== undefined
    )
      return request;
    changed = true;
    return { ...request, decision, resolvedBy, resolvedAt };
  });
  return changed ? withSessionReadRequestRecords(metadata, settled) : { ...metadata };
}

function withSessionReadRequestRecords(
  metadata: Readonly<Record<string, JSONValue>>,
  requests: readonly SessionReadRequest[],
): Record<string, JSONValue> {
  return {
    ...metadata,
    [SESSION_READ_REQUESTS_METADATA_KEY]: requests.map((candidate) => ({
      owner: candidate.owner,
      workspaceId: candidate.workspaceId,
      actorId: candidate.actorId,
      requestedAt: candidate.requestedAt,
      ...(candidate.resolvedAt === undefined
        ? {}
        : {
            resolvedAt: candidate.resolvedAt,
            resolvedBy: candidate.resolvedBy!,
            decision: candidate.decision!,
          }),
    })),
  };
}

/** Read valid grants only. Malformed persisted metadata fails closed. */
export function sessionReadGrantsOf(
  metadata: Readonly<Record<string, JSONValue>>,
): readonly SessionReadGrant[] {
  const stored = metadata[SESSION_READ_GRANTS_METADATA_KEY];
  if (!Array.isArray(stored)) return [];
  const byOwner = new Map<string, SessionReadGrant>();
  for (const value of stored) {
    const grant = grantOf(value);
    // A partial or duplicate durable record is ambiguous. Do not let a valid
    // earlier row turn a malformed replacement into an active authorization.
    if (grant === undefined || byOwner.has(grant.owner)) return [];
    byOwner.set(grant.owner, grant);
  }
  return [...byOwner.values()];
}

/** The grant record for one former or current reader. */
export function sessionReadGrantOf(
  metadata: Readonly<Record<string, JSONValue>>,
  owner: string,
): SessionReadGrant | undefined {
  return sessionReadGrantsOf(metadata).find((grant) => grant.owner === owner);
}

/** Valid durable audit facts, in commit order. */
export function sessionReadGrantHistoryOf(
  metadata: Readonly<Record<string, JSONValue>>,
): readonly SessionReadGrantEvent[] {
  const stored = metadata[SESSION_READ_GRANT_HISTORY_METADATA_KEY];
  return Array.isArray(stored)
    ? stored.flatMap((value) => {
        const event = eventOf(value);
        return event === undefined ? [] : [event];
      })
    : [];
}

/** Whether a session presently admits `owner` as a reader. */
export function sessionHasReadGrant(
  metadata: Readonly<Record<string, JSONValue>>,
  owner: string,
  sessionIncarnation?: string,
): boolean {
  const grant = sessionReadGrantOf(metadata, owner);
  return (
    grant !== undefined &&
    grant.revokedAt === undefined &&
    (sessionIncarnation === undefined || grant.sessionIncarnation === sessionIncarnation)
  );
}

/** Whether the durable record proves this owner once had a grant. */
export function sessionWasReadGrantedTo(
  metadata: Readonly<Record<string, JSONValue>>,
  owner: string,
  sessionIncarnation?: string,
): boolean {
  const grant = sessionReadGrantOf(metadata, owner);
  return (
    grant !== undefined &&
    (sessionIncarnation === undefined || grant.sessionIncarnation === sessionIncarnation)
  );
}

/** Add or restore a reader grant, retaining any prior revocation as audit history. */
export function withSessionReadGrant(
  metadata: Readonly<Record<string, JSONValue>>,
  grant: Omit<SessionReadGrant, 'revokedAt' | 'revokedBy'>,
): Record<string, JSONValue> {
  const grants = sessionReadGrantsOf(metadata).filter(
    (candidate) => candidate.owner !== grant.owner,
  );
  const history = sessionReadGrantHistoryOf(metadata);
  return {
    ...metadata,
    [SESSION_READ_GRANTS_METADATA_KEY]: [...grants, grant].map(jsonGrant),
    [SESSION_READ_GRANT_HISTORY_METADATA_KEY]: [
      ...history,
      {
        ...grant,
        kind: 'granted' as const,
        actor: grant.grantedBy,
        at: grant.grantedAt,
        changed: true,
      },
    ].map(jsonEvent),
  };
}

/** Revoke a current reader grant while retaining the durable former-reader record. */
export function withSessionReadRevocation(
  metadata: Readonly<Record<string, JSONValue>>,
  owner: string,
  revokedBy: string,
  revokedAt: string,
): Record<string, JSONValue> {
  const current = sessionReadGrantOf(metadata, owner);
  if (current === undefined || current.revokedAt !== undefined) return { ...metadata };
  const grants = sessionReadGrantsOf(metadata).map((grant) =>
    grant.owner === owner ? { ...grant, revokedBy, revokedAt } : grant,
  );
  const history = sessionReadGrantHistoryOf(metadata);
  return {
    ...metadata,
    [SESSION_READ_GRANTS_METADATA_KEY]: grants.map(jsonGrant),
    [SESSION_READ_GRANT_HISTORY_METADATA_KEY]: [
      ...history,
      {
        owner: current.owner,
        workspaceId: current.workspaceId,
        actorId: current.actorId,
        kind: 'revoked' as const,
        actor: revokedBy,
        at: revokedAt,
        changed: true,
      },
    ].map(jsonEvent),
  };
}

/** Appends the outcome of an idempotent owner command without changing access. */
export function withSessionReadGrantAttempt(
  metadata: Readonly<Record<string, JSONValue>>,
  owner: string,
  kind: 'granted' | 'revoked',
  actor: string,
  at: string,
): Record<string, JSONValue> {
  const grant = sessionReadGrantOf(metadata, owner);
  if (grant === undefined) return { ...metadata };
  const history = sessionReadGrantHistoryOf(metadata);
  return {
    ...metadata,
    [SESSION_READ_GRANT_HISTORY_METADATA_KEY]: [
      ...history,
      {
        owner: grant.owner,
        workspaceId: grant.workspaceId,
        actorId: grant.actorId,
        kind,
        actor,
        at,
        changed: false,
      },
    ].map(jsonEvent),
  };
}
