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
  // Not `??`: a caller's `null` is a defect to refuse, not an absent principal.
  return principal === undefined ? ANONYMOUS_LOCAL_OWNER : principal;
}

/**
 * Why `principal`, as a caller supplied it, cannot become an owner, or `undefined`
 * when it can: a principal is text, or absent, and it is not one of Bureau's own.
 * The `system:` namespace is reserved for the service principals, which are only
 * ever actors, and `anonymous:` for callers with no credential; the one value a
 * caller may state there is the exact {@link ANONYMOUS_LOCAL_OWNER}, which the
 * local handler flow states for every uncredentialed caller. Anything else in
 * either namespace would let a caller share a service identity, the scheduler's
 * memory principal included. This is the one definition of that rule. Every
 * entry point that derives an owner from a caller-supplied principal applies it
 * before it persists anything, either through {@link ownerFromPrincipal} or,
 * where the entry point answers with an outcome instead of throwing
 * (`bureau.goals.create`), by reporting this reason.
 */
export function principalDefect(principal: unknown, name = 'principal'): string | undefined {
  if (principal === undefined) return undefined;
  if (typeof principal !== 'string') return `"${name}" must be a string`;
  if (principal !== ANONYMOUS_LOCAL_OWNER && isReservedOwnerSubject(principal)) {
    return `"${name}" is in a namespace reserved for Bureau's own principals`;
  }
  return undefined;
}

/**
 * The owner a caller-supplied principal stands for: the principal itself, or
 * `anonymous:local` when it is absent. Anything else is refused through `refuse`
 * (the entry point's own `BAD_REQUEST` thrower), so a persisted owner is always text.
 * An entry point takes its owner from here and never from {@link ownerOrLocal},
 * which only supplies the read-side default for a record that has none.
 */
export function ownerFromPrincipal(
  principal: unknown,
  refuse: (message: string) => never,
  name = 'principal',
): string {
  const defect = principalDefect(principal, name);
  if (defect !== undefined) refuse(defect);
  return ownerOrLocal(principal as string | undefined);
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
