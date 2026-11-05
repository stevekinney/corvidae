import { principalFromApiKey, type AuthConfig } from '@lostgradient/weft';
import { BUREAU_SCOPES } from './bureau-scopes.ts';
import type { WorkspaceMembershipOptions } from './workspace-principal.ts';
import {
  as,
  openBureau,
  type OpenedBureau,
} from './management/management-fixtures.test-support.ts';

/** Six actors required by the workspace privacy contract; grants never change the actor's role. */
export const WORKSPACE_PRIVACY_ACTORS = {
  owner: { key: 'alice-key', subject: 'alice', owner: 'workspace-a:alice' },
  peer: { key: 'bob-key', subject: 'bob', owner: 'workspace-a:bob' },
  administrator: { key: 'operator-key', subject: 'operator', owner: 'workspace-a:administrator' },
  grantee: { key: 'assets-reader-key', subject: 'assets-reader', owner: 'workspace-a:grantee' },
  foreign: { key: 'contexts-writer-key', subject: 'contexts-writer', owner: 'workspace-b:alice' },
  removed: { key: 'tasks-reader-key', subject: 'tasks-reader', owner: 'workspace-a:removed' },
} as const;
export type WorkspacePrivacyActor = keyof typeof WORKSPACE_PRIVACY_ACTORS;

/** One directory instance is passed to the real runtime and handler, with no positive cache. */
export function workspacePrivacyDirectory(): WorkspaceMembershipOptions {
  const membership = (subject: string | undefined) => {
    const entry = Object.entries(WORKSPACE_PRIVACY_ACTORS).find(
      ([, actor]) => actor.subject === subject,
    );
    if (entry === undefined || entry[0] === 'removed') return null;
    const [role, actor] = entry;
    return {
      version: 1 as const,
      workspaceId: role === 'foreign' ? 'workspace-b' : 'workspace-a',
      actorId: role === 'foreign' ? 'alice' : actor.subject,
      actorKind: 'user' as const,
      owner: actor.owner,
      membershipRevision: 'membership-1',
      capabilities:
        role === 'administrator'
          ? ['workspace:use' as const, 'workspace:manage' as const]
          : ['workspace:use' as const],
    };
  };
  return {
    workspaceId: 'workspace-a',
    resolveMembership: async ({ subject }) => membership(subject),
    resolveOwnerMembership: async (owner) =>
      membership(
        Object.values(WORKSPACE_PRIVACY_ACTORS).find((actor) => actor.owner === owner)?.subject,
      ),
  };
}

/** Give each verified fixture credential all legacy scopes so role gates cannot hide behind scope refusal. */
export const workspacePrivacyAuthentication: AuthConfig = {
  resolveApiKeyPrincipal: async (key) => {
    const actor = Object.values(WORKSPACE_PRIVACY_ACTORS).find(
      (candidate) => candidate.key === key,
    );
    return actor === undefined
      ? null
      : principalFromApiKey({ subject: actor.subject, scopes: [...BUREAU_SCOPES] });
  },
};

/** Open the same fully composed Bureau used by the management operation suites. */
export function openWorkspacePrivacyBureau(
  options: Parameters<typeof openBureau>[0] = {},
): Promise<OpenedBureau> {
  const workspace = workspacePrivacyDirectory();
  return openBureau({
    ...options,
    authentication: workspacePrivacyAuthentication,
    bureauOptions: { ...options.bureauOptions, workspace },
    handlerOptions: { ...options.handlerOptions, workspace },
  });
}

/** Authentication refusal is HTTP; an admitted JSON-RPC request carries its own fault encoding. */
export async function workspacePrivacyCall(
  opened: Pick<OpenedBureau, 'handler'>,
  actor: WorkspacePrivacyActor,
  method: string,
  input: unknown,
) {
  const response = await opened.handler(
    new Request('http://localhost/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...as(WORKSPACE_PRIVACY_ACTORS[actor].key) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: input }),
    }),
  );
  const text = await response.text();
  const body = response.headers.get('content-type')?.includes('application/json')
    ? (JSON.parse(text) as {
        result?: Record<string, unknown>;
        error?: { code: number; message?: string; data?: { httpStatus?: number } };
      })
    : undefined;
  return { status: response.status, body, text };
}

/** Input and outcome inventory consumed by the authenticated resource-read tests. */
export const WORKSPACE_PRIVATE_READ_CASES = [
  { operation: 'bureau.tasks.get', field: 'taskId', collection: false },
  { operation: 'bureau.tasks.list', field: 'taskId', collection: true },
  { operation: 'bureau.contexts.get', field: 'contextId', collection: false },
  { operation: 'bureau.contexts.list', field: 'contextId', collection: true },
].map((row) => ({
  ...row,
  transport: 'jsonRpcHttp' as const,
  resourceClass: 'private-owned' as const,
  inputFixture: 'running task and its seeded context',
  sentinel: 'PRIVATE-WORKSPACE-CONTENT-8d5c',
  expected: {
    owner: 'success',
    peer: row.collection ? 'empty' : 'not-found',
    administrator: row.collection ? 'empty' : 'not-found',
    grantee: row.collection ? 'empty' : 'not-found',
    foreign: 'membership-denied',
    removed: 'membership-denied',
  },
}));

/** Legacy-scope fixtures resolve the same administrator by credential and durable owner. */
export function workspaceAdministratorDirectory(): WorkspaceMembershipOptions {
  const resolveMembership: WorkspaceMembershipOptions['resolveMembership'] = async ({
    subject,
    method,
  }) => ({
    version: 1,
    workspaceId: 'workspace-a',
    actorId: method === 'unauthenticated-local' ? 'local-owner' : (subject ?? 'unknown'),
    actorKind: method === 'unauthenticated-local' ? 'local' : 'user',
    owner:
      method === 'unauthenticated-local' ? 'anonymous:local' : `api-key:${subject ?? 'unknown'}`,
    membershipRevision: 'revision-1',
    capabilities:
      method === 'unauthenticated-local'
        ? ['workspace:use', 'workspace:manage', 'deployment:operate']
        : ['workspace:use', 'workspace:manage'],
  });
  return {
    workspaceId: 'workspace-a',
    resolveMembership,
    resolveOwnerMembership: async (owner) =>
      owner === 'anonymous:local'
        ? resolveMembership({ method: 'unauthenticated-local', subject: undefined })
        : owner.startsWith('api-key:')
          ? resolveMembership({ method: 'api-key', subject: owner.slice('api-key:'.length) })
          : null,
  };
}
