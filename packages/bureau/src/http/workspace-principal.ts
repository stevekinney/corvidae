import {
  type AuthenticatedPrincipal,
  type OperationHandlerAuthenticate,
  type WorkspaceIdentity,
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
