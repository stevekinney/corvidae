import {
  principalFromApiKey,
  principalFromUnauthenticatedLocal,
  type AuthenticatedPrincipal,
} from '@lostgradient/weft';

import { BUREAU_SCOPES, type BureauScope } from './http/bureau-scopes.ts';
import { mayAccessOwnedResource } from './http/owner-predicate.ts';
import {
  resolveWorkspaceOwner,
  type WorkspaceRuntimeAuthority,
} from './http/workspace-principal.ts';
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

/** Whether a run may use an operation against a resource. */
export type RunAccessOptions = {
  /** Whether the operation's scope may authorize access to a foreign owner. */
  readonly allowOperatorScope?: boolean;
};

/** Answers a run's scope or owner-equality authorization request. */
export function mayRunAccess(
  owner: string | undefined,
  operationScope: BureauScope,
  resourceOwner?: string,
  options: RunAccessOptions = {},
): boolean {
  if (options.allowOperatorScope === false) return owner !== undefined && owner === resourceOwner;
  const principal = createRunPrincipal(owner);
  return mayAccessOwnedResource({ principal, resourceOwner, operatorScope: operationScope });
}

/** Run tools use current directory roles; the agent's tool catalog remains the action grant. */
export async function mayRunUseSharedConfiguration(
  workspace: WorkspaceRuntimeAuthority | undefined,
  owner: string | undefined,
  operationScope: BureauScope,
  administrator: boolean,
  resourceOwner?: string,
  options: RunAccessOptions = {},
): Promise<boolean> {
  if (workspace === undefined) return mayRunAccess(owner, operationScope, resourceOwner, options);
  if (owner === undefined) return false;
  const membership = await resolveWorkspaceOwner(workspace, owner);
  return (
    membership !== undefined &&
    membership.actorKind !== 'service' &&
    (!administrator || membership.capabilities.includes('workspace:manage'))
  );
}
