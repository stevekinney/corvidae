/**
 * The owner of record: the one principal that owns a resource, stored once
 * when the resource is created. See `documentation/external-control-plane.md`,
 * "Authorization".
 *
 * An owner is a string. An authenticated API-key caller owns as
 * `api-key:<encodeURIComponent(subject)>`; a host that states no principal, and
 * every caller of a handler served with `unauthenticatedAccess: 'allow'`, owns
 * as {@link ANONYMOUS_LOCAL_OWNER}. The `system:` namespace belongs to Bureau's
 * own service principals, which are only ever the *actor* on an audit entry:
 * work the scheduler, recovery, or expiry starts or changes keeps the owner of
 * the resource it acts on.
 *
 * @module owner-of-record
 */

/** The owner of a resource created with no stated principal, and of a record written before owners existed. */
export const ANONYMOUS_LOCAL_OWNER = 'anonymous:local';

/** The actor on a schedule's `schedule.fired` audit entry. */
export const SCHEDULER_ACTOR = 'system:scheduler';

/** The actor on a recovered run's `run.recovered` audit entry. */
export const RECOVERY_ACTOR = 'system:recovery';

/** The actor on an expired review's audit entry. */
export const EXPIRY_ACTOR = 'system:expiry';

const RESERVED_OWNER_PREFIXES = ['system:', 'anonymous:'] as const;

/**
 * The owner a resource has: the stated principal, or {@link ANONYMOUS_LOCAL_OWNER}
 * when there is none. This is the read rule for a record persisted before owners
 * existed, and the default for a host that passes no `principal`.
 */
export function ownerOrLocal(principal: string | undefined): string {
  return principal ?? ANONYMOUS_LOCAL_OWNER;
}

/**
 * The owner string for an API-key caller. The subject is percent-encoded
 * (which encodes `:`), so no two distinct subjects produce the same string.
 */
export function apiKeyOwner(subject: string): string {
  return `api-key:${encodeURIComponent(subject)}`;
}

/**
 * Whether a credential subject falls in a namespace Bureau reserves for itself:
 * `system:` for its service principals, `anonymous:` for callers with no
 * credential. A credential naming one is refused, so a credential can never
 * mint an owner that looks like Bureau's own.
 */
export function isReservedOwnerSubject(subject: string): boolean {
  return RESERVED_OWNER_PREFIXES.some((prefix) => subject.startsWith(prefix));
}
