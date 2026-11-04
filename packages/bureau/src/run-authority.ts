import {
  principalFromApiKey,
  principalFromUnauthenticatedLocal,
  type AuthenticatedPrincipal,
} from '@lostgradient/weft';

import { BUREAU_SCOPES, type BureauScope } from './http/bureau-scopes.ts';
import { mayAccessOwnedResource } from './http/owner-predicate.ts';
import { ANONYMOUS_LOCAL_OWNER } from './owner-of-record.ts';

/** Builds the transport principal represented by a Bureau run's owner record. */
export function createRunPrincipal(owner: string | undefined): AuthenticatedPrincipal {
  if (owner === ANONYMOUS_LOCAL_OWNER) {
    const local = principalFromUnauthenticatedLocal();
    const scopes = new Set([...local.scopes, ...BUREAU_SCOPES]);
    return Object.freeze({
      ...local,
      scopes,
      hasScope: (scope: Parameters<typeof local.hasScope>[0]) => scopes.has(scope),
      owner: ANONYMOUS_LOCAL_OWNER,
    });
  }
  if (owner?.startsWith('api-key:')) {
    const principal = principalFromApiKey({ subject: owner.slice('api-key:'.length), scopes: [] });
    return Object.freeze({ ...principal, owner });
  }
  const principal = principalFromApiKey({ subject: owner ?? '', scopes: [] });
  return Object.freeze({ ...principal, owner });
}

/** Answers a run's scope or owner-equality authorization request. */
export function mayRunAccess(
  owner: string | undefined,
  operationScope: BureauScope,
  resourceOwner?: string,
): boolean {
  const principal = createRunPrincipal(owner);
  return mayAccessOwnedResource({ principal, resourceOwner, operatorScope: operationScope });
}
