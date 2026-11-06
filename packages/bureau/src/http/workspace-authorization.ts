import type { OperationHandlerMount, Principal } from '@lostgradient/weft';

import { OPERATION_MAP, type WorkspaceOperationClass } from './operation-map.ts';

/** Class gates supplement existing action scopes; record predicates still hide private IDs. */
export function authorizeWorkspaceClass(
  classification: WorkspaceOperationClass,
  principal: Principal,
): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
  const workspace = principal.method === 'unauthenticated' ? undefined : principal.workspace;
  if (workspace === undefined) return { allowed: true };
  if (principal.method === 'unauthenticated' || !workspace.capabilities.includes('workspace:use'))
    return { allowed: false, reason: 'Current workspace membership required' };
  if (classification === 'member-shared-read' && workspace.actorKind === 'service')
    return { allowed: false, reason: 'Shared workspace browsing is unavailable to service actors' };
  if (
    classification === 'administrator-shared' &&
    !workspace.capabilities.includes('workspace:manage')
  )
    return { allowed: false, reason: 'Workspace administration required' };
  if (
    classification === 'deployment-operator' &&
    (workspace.actorKind !== 'local' ||
      principal.method !== 'unauthenticated-local' ||
      !workspace.capabilities.includes('deployment:operate'))
  )
    return { allowed: false, reason: 'Trusted deployment operation required' };
  return { allowed: true };
}

/** Capture the same immutable table entry the executable inventory enumerates. */
export function authorizeWorkspaceOperation(name: keyof typeof OPERATION_MAP) {
  const classification = OPERATION_MAP[name].workspaceClass;
  return async ({
    principal,
  }: {
    readonly principal: Principal;
  }): Promise<ReturnType<typeof authorizeWorkspaceClass>> =>
    authorizeWorkspaceClass(classification, principal);
}

/** Trusted contributed mounts must declare their resource boundary before registration. */
export type WorkspaceClassifiedMount = OperationHandlerMount & {
  readonly workspaceClass?: WorkspaceOperationClass;
};

/** Apply a class gate without replacing a protocol adapter's own resource authorization. */
export function classifyWorkspaceMount(
  mount: OperationHandlerMount,
  classification: WorkspaceOperationClass,
): WorkspaceClassifiedMount {
  return {
    ...mount,
    workspaceClass: classification,
    fetch: async (request, context) => {
      const decision = authorizeWorkspaceClass(classification, context.principal);
      if (!decision.allowed) return new Response(decision.reason, { status: 403 });
      return mount.fetch(request, context);
    },
  };
}

/** Fail closed at composition, before any contributed route can run. */
export function registerWorkspaceMount(mount: WorkspaceClassifiedMount): WorkspaceClassifiedMount {
  const classification = mount.workspaceClass;
  if (
    classification === undefined ||
    ![
      'public-discovery',
      'member-shared-read',
      'administrator-shared',
      'private-owned',
      'explicit-share',
      'deployment-operator',
    ].includes(classification)
  )
    throw new TypeError(`Workspace mount ${mount.pathPrefix} requires a resource classification`);
  return classifyWorkspaceMount(mount, classification);
}
