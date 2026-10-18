/**
 * The one owner predicate every owner-scoped operation `createBureauHandler`
 * serves decides with, on every transport.
 *
 * `documentation/external-control-plane.md`, "The predicate per action": an
 * authenticated principal reaches a resource it owns without any Bureau scope,
 * and the kind's operator scope grants cross-owner access. A caller who fails
 * the predicate is answered exactly as a missing resource is, so an identifier
 * grants nothing, and the denial writes no audit entry.
 *
 * @module owner-predicate
 */

import type { Principal } from '@lostgradient/weft';

import { ANONYMOUS_LOCAL_OWNER, apiKeyOwner } from '../owner-of-record.ts';
import type { BureauScope } from './bureau-scopes.ts';

/**
 * The owner string a principal owns resources as, or `undefined` when it cannot
 * own any. A request served with `unauthenticatedAccess: 'allow'` is the one
 * local caller, `anonymous:local`; an API key owns as
 * `api-key:<encodeURIComponent(subject)>`. A credential type v1 does not accept
 * (JWT, mTLS), or one with no subject, names no owner.
 */
export function ownerOfPrincipal(principal: Principal): string | undefined {
  if (principal.method === 'unauthenticated-local') return ANONYMOUS_LOCAL_OWNER;
  if (principal.method === 'api-key' && principal.subject !== undefined) {
    return apiKeyOwner(principal.subject);
  }
  return undefined;
}

/** What {@link mayAccessOwnedResource} decides from. */
export type OwnerAccessRequest = {
  readonly principal: Principal;
  /** The resource's owner of record, or `undefined` when it has none or does not exist. */
  readonly resourceOwner: string | undefined;
  /** The scope that grants this action on this kind of resource to any owner. */
  readonly operatorScope: BureauScope;
};

/** The shape the operations take through their host, so a test can observe every call. */
export type OwnerAccessPredicate = (request: OwnerAccessRequest) => boolean;

/**
 * Whether `principal` may act on a resource owned by `resourceOwner`: it holds
 * the operator scope, or it is the owner. An unauthenticated principal, a
 * principal that owns nothing, and a resource with no owner pass only through
 * the operator scope.
 */
export const mayAccessOwnedResource: OwnerAccessPredicate = ({
  principal,
  resourceOwner,
  operatorScope,
}) => {
  if (principal.method === 'unauthenticated') return false;
  if (principal.hasScope(operatorScope)) return true;
  const caller = ownerOfPrincipal(principal);
  return caller !== undefined && resourceOwner !== undefined && caller === resourceOwner;
};

/** What the owner-scoped operations read from the handler's `host`. */
export type BureauOwnershipHost = {
  readonly ownership: {
    /** The owner of record of a run, or `undefined` for a run this Bureau does not know. */
    readonly runOwner: (runId: string) => Promise<string | undefined>;
    readonly mayAccess: OwnerAccessPredicate;
  };
};
