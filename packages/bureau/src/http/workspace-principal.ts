import {
  type AuthenticatedPrincipal,
  type OperationHandlerAuthenticate,
  type WorkspaceIdentity,
  type Principal,
} from '@lostgradient/weft';
import { z } from 'zod';
import { ANONYMOUS_LOCAL_OWNER, isReservedOwnerSubject } from '../owner-of-record.ts';

/** The immutable workspace identity a trusted host directory resolves for a credential. */
export type WorkspaceMembership = WorkspaceIdentity;

/** Verified credential information; no request headers, input, or claims are directory authority. */
export type WorkspaceCredential = Readonly<Pick<AuthenticatedPrincipal, 'method' | 'subject'>>;

/** Resolve current membership in this one runtime's workspace on every authentication evaluation. */
export type WorkspaceMembershipOptions = {
  /** The configured runtime identity; a result for any other workspace is refused. */
  readonly workspaceId: string;
  /** Resolve another opaque owner for an explicit share; absent means self-only sharing. */
  readonly resolveOwnerMembership?:
    ((owner: string) => Promise<WorkspaceMembership | null>) | undefined;
  /** Resolve current membership after verification; null removes access and errors fail closed. */
  readonly resolveMembership: (
    credential: WorkspaceCredential,
  ) => Promise<WorkspaceMembership | null>;
};

const membershipSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().min(1),
    actorId: z.string().min(1),
    actorKind: z.enum(['user', 'service', 'local']),
    owner: z.string().min(1),
    membershipRevision: z.string().min(1),
    capabilities: z.array(z.enum(['workspace:use', 'workspace:manage', 'deployment:operate'])),
  })
  .strict();

function resolveSnapshot(
  value: unknown,
  workspaceId: string,
  credential: WorkspaceCredential,
): WorkspaceMembership | undefined {
  const parsed = membershipSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const identity = parsed.data;
  if (identity.workspaceId !== workspaceId || !identity.capabilities.includes('workspace:use'))
    return undefined;
  if (isReservedOwnerSubject(identity.actorId)) return undefined;
  if (credential.method === 'unauthenticated-local') {
    if (identity.actorKind !== 'local' || identity.owner !== ANONYMOUS_LOCAL_OWNER)
      return undefined;
  } else {
    if (credential.method !== 'api-key' || identity.actorKind === 'local') return undefined;
    if (
      isReservedOwnerSubject(identity.owner) ||
      identity.capabilities.includes('deployment:operate')
    )
      return undefined;
    if (
      identity.actorKind === 'service' &&
      identity.capabilities.some((capability) => capability !== 'workspace:use')
    )
      return undefined;
  }
  return Object.freeze({ ...identity, capabilities: Object.freeze([...identity.capabilities]) });
}

/** Attach only validated, server-resolved membership after the credential authenticator succeeds. */
export function withWorkspaceMembership(
  authenticate: OperationHandlerAuthenticate,
  options: WorkspaceMembershipOptions,
): OperationHandlerAuthenticate {
  const { workspaceId, resolveMembership } = options;
  if (
    typeof workspaceId !== 'string' ||
    workspaceId.length === 0 ||
    typeof resolveMembership !== 'function'
  )
    throw new TypeError('Workspace membership requires a workspace ID and resolver');
  return async (request) => {
    const authenticated = await authenticate(request);
    if (authenticated instanceof Response) return authenticated;
    const principal = authenticated.principal;
    if (principal === undefined)
      return new Response('Workspace membership required', { status: 403 });
    const credential = Object.freeze({ method: principal.method, subject: principal.subject });
    const scopes = new Set(principal.scopes);
    const contextSnapshot = { ...authenticated };
    const principalSnapshot: AuthenticatedPrincipal = {
      ...principal,
      ...credential,
      scopes,
      hasScope: (scope) => scopes.has(scope),
    };
    let resolved: unknown;
    try {
      resolved = await resolveMembership(credential);
    } catch {
      return new Response('Workspace membership unavailable', { status: 503 });
    }
    const workspace = resolveSnapshot(resolved, workspaceId, credential);
    if (workspace === undefined)
      return new Response('Workspace membership required', { status: 403 });
    return {
      ...contextSnapshot,
      principal: Object.freeze({
        ...principalSnapshot,
        workspace,
      }),
    };
  };
}

/** A trusted per-request directory capability, never part of the wire identity. */
export type WorkspaceOwnerAuthority = (owner: string) => Promise<boolean>;

export type BureauWorkspaceHost = {
  readonly workspaceAuthority?:
    ((principal: Principal) => WorkspaceOwnerAuthority | undefined) | undefined;
};

export function workspaceOwnerAuthority(
  options: WorkspaceMembershipOptions | undefined,
  principal: Principal,
): WorkspaceOwnerAuthority | undefined {
  if (principal.method === 'unauthenticated' || principal.workspace === undefined) return undefined;
  const workspace = principal.workspace;
  return async (owner) => {
    if (!workspace.capabilities.includes('workspace:use')) return false;
    if (owner === workspace.owner) return true;
    if (workspace.actorKind === 'service') return false;
    if (options === undefined || options.workspaceId !== workspace.workspaceId) return false;
    const target = await resolveWorkspaceOwner(options, owner);
    return target !== undefined && target.actorKind !== 'service';
  };
}

/** Runtime directory configuration shared by run/tool execution and request authentication. */
export type WorkspaceRuntimeAuthority = Readonly<
  Pick<WorkspaceMembershipOptions, 'workspaceId' | 'resolveOwnerMembership'>
>;

export async function resolveWorkspaceOwner(
  options: WorkspaceRuntimeAuthority,
  owner: string,
): Promise<WorkspaceMembership | undefined> {
  try {
    const value = await options.resolveOwnerMembership?.(owner);
    const parsed = membershipSchema.safeParse(value);
    if (!parsed.success || parsed.data.owner !== owner) return undefined;
    return resolveSnapshot(value, options.workspaceId, {
      method: parsed.data.actorKind === 'local' ? 'unauthenticated-local' : 'api-key',
      subject: undefined,
    });
  } catch {
    return undefined;
  }
}

/** A value capability for runtime asset use; every call resolves current directory membership. */
export function runtimeWorkspaceOwnerAuthority(
  options: WorkspaceRuntimeAuthority | undefined,
  owner: string,
): WorkspaceOwnerAuthority | undefined {
  if (options === undefined) return undefined;
  return async (otherOwner) => {
    const current = await resolveWorkspaceOwner(options, owner);
    if (current === undefined) return false;
    if (otherOwner === owner) return true;
    if (current.actorKind === 'service') return false;
    const target = await resolveWorkspaceOwner(options, otherOwner);
    return target !== undefined && target.actorKind !== 'service';
  };
}
