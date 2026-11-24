import type { JSONValue } from '../types';

/** Durable metadata for explicit read-only access to a session. */
export const SESSION_READ_GRANTS_METADATA_KEY = 'sessionReadGrants';

/** One current or former reader, recorded in session metadata with its grant state. */
export type SessionReadGrant = Readonly<{
  owner: string;
  grantedBy: string;
  grantedAt: string;
  revokedAt?: string | undefined;
  revokedBy?: string | undefined;
}>;

function isRecord(value: JSONValue | undefined): value is Record<string, JSONValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function grantOf(value: JSONValue): SessionReadGrant | undefined {
  if (!isRecord(value)) return undefined;
  const { owner, grantedBy, grantedAt, revokedAt, revokedBy } = value;
  if (typeof owner !== 'string' || owner === '') return undefined;
  if (typeof grantedBy !== 'string' || grantedBy === '') return undefined;
  if (typeof grantedAt !== 'string' || grantedAt === '') return undefined;
  if (revokedAt !== undefined && (typeof revokedAt !== 'string' || revokedAt === '')) return undefined;
  if (revokedBy !== undefined && (typeof revokedBy !== 'string' || revokedBy === '')) return undefined;
  if ((revokedAt === undefined) !== (revokedBy === undefined)) return undefined;
  return {
    owner,
    grantedBy,
    grantedAt,
    ...(revokedAt === undefined ? {} : { revokedAt }),
    ...(revokedBy === undefined ? {} : { revokedBy }),
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
    if (grant !== undefined) byOwner.set(grant.owner, grant);
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

/** Whether a session presently admits `owner` as a reader. */
export function sessionHasReadGrant(
  metadata: Readonly<Record<string, JSONValue>>,
  owner: string,
): boolean {
  const grant = sessionReadGrantOf(metadata, owner);
  return grant !== undefined && grant.revokedAt === undefined;
}

/** Whether the durable record proves this owner once had a grant. */
export function sessionWasReadGrantedTo(
  metadata: Readonly<Record<string, JSONValue>>,
  owner: string,
): boolean {
  return sessionReadGrantOf(metadata, owner) !== undefined;
}

/** Add or restore a reader grant, retaining any prior revocation as audit history. */
export function withSessionReadGrant(
  metadata: Readonly<Record<string, JSONValue>>,
  grant: Omit<SessionReadGrant, 'revokedAt' | 'revokedBy'>,
): Record<string, JSONValue> {
  const grants = sessionReadGrantsOf(metadata).filter((candidate) => candidate.owner !== grant.owner);
  return {
    ...metadata,
    [SESSION_READ_GRANTS_METADATA_KEY]: [...grants, grant],
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
  return { ...metadata, [SESSION_READ_GRANTS_METADATA_KEY]: grants };
}
