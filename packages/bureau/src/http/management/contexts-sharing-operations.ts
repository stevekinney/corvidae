/** Explicit, owner-controlled, read-only context sharing. */

import {
  sessionHasReadGrant,
  sessionOwnerOf,
  sessionReadRequestsOf,
  sessionWasReadGrantedTo,
  withSessionReadGrant,
  withSessionReadRequest,
  withSessionReadRequestResolution,
  withSessionReadRevocation,
} from '@lostgradient/operative';
import { defineOperation, type OperationFault, type Principal } from '@lostgradient/backchannel';
import { z } from 'zod';

import type { BureauInternals } from '../../bureau-types/facade.ts';
import { isOwnerOfResource, type BureauOwnershipHost } from '../owner-predicate.ts';
import { type BureauWorkspaceHost } from '../workspace-principal.ts';
import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';
import { noSessions } from './contexts-operations.ts';
import { resourceNotFound, unaryTransports as transports, unknownKeyPolicy } from './management-schemas.ts';

export type BureauContextsSharingOperationHost = BureauOwnershipHost &
  BureauWorkspaceHost & {
    readonly contexts: {
      readonly get: (id: string) => Promise<import('@lostgradient/operative').AgentSession | undefined>;
      readonly list: (
        options?: import('@lostgradient/operative').SessionListOptions,
      ) => Promise<readonly import('@lostgradient/operative').SessionSummary[]>;
      readonly internals: Pick<BureauInternals, 'sessionStore'>;
    };
  };

const sharingInput = z.object({
  contextId: z.string().min(1),
  granteeOwnerId: z.string().min(1).max(256),
});

const sharingOutput = z.object({
  contextId: z.string(),
  granteeOwnerId: z.string(),
  changed: z.boolean(),
});
const requestResolutionInput = sharingInput.extend({ decision: z.enum(['grant', 'deny']) });
const requestQueueOutput = z.object({
  requests: z.array(z.object({
    contextId: z.string(),
    granteeOwnerId: z.string(),
    requestedAt: z.string(),
  })),
});

function missing(contextId: string): OperationFault {
  return resourceNotFound('context', contextId);
}

async function currentWorkspacePeer(
  host: BureauContextsSharingOperationHost,
  principal: Principal,
  owner: string,
): Promise<boolean> {
  const workspace = 'workspace' in principal ? principal.workspace : undefined;
  if (
    workspace === undefined ||
    workspace.actorKind === 'local' ||
    workspace.owner === owner
  )
    return false;
  const authority = host.workspaceAuthority?.(principal);
  return authority === undefined ? false : authority(owner);
}

async function change(
  host: BureauContextsSharingOperationHost,
  principal: Principal,
  input: z.infer<typeof sharingInput>,
  kind: 'grant' | 'revoke',
): Promise<z.infer<typeof sharingOutput>> {
  const store = host.contexts.internals.sessionStore;
  if (store === undefined) throw noSessions();
  const loaded = await host.contexts.get(input.contextId);
  const owner = loaded === undefined ? undefined : sessionOwnerOf(loaded.metadata);
  if (loaded === undefined || owner === null || !isOwnerOfResource(principal, owner)) {
    throw missing(input.contextId);
  }
  if (!(await currentWorkspacePeer(host, principal, input.granteeOwnerId))) {
    throw missing(input.contextId);
  }
  const workspace = 'workspace' in principal ? principal.workspace : undefined;
  const grantedBy = workspace?.owner;
  if (grantedBy === undefined) throw missing(input.contextId);
  const target = await host.resolveWorkspaceOwner?.(input.granteeOwnerId);
  if (target === undefined || target.workspaceId !== workspace!.workspaceId) throw missing(input.contextId);
  const originallyGranted = sessionHasReadGrant(
    loaded.metadata,
    input.granteeOwnerId,
    loaded.incarnation,
  );
  let committed = false;
  await store.update(
    input.contextId,
    (current) => {
      if (current === undefined || current.incarnation !== loaded.incarnation) return undefined;
      const currentlyGranted = sessionHasReadGrant(
        current.metadata,
        input.granteeOwnerId,
        current.incarnation,
      );
      if ((kind === 'grant' && currentlyGranted) || (kind === 'revoke' && !currentlyGranted)) {
        return undefined;
      }
      committed = true;
      const at = new Date().toISOString();
      return {
        ...current,
        metadata:
          kind === 'grant'
            ? withSessionReadGrant(current.metadata, {
                owner: input.granteeOwnerId,
                workspaceId: workspace!.workspaceId,
                actorId: target.actorId,
                sessionIncarnation: current.incarnation,
                grantedBy,
                grantedAt: at,
              })
            : withSessionReadRevocation(current.metadata, input.granteeOwnerId, grantedBy, at),
      };
    },
    { refreshActivity: false },
  );
  const intended = kind === 'grant';
  return {
    contextId: input.contextId,
    granteeOwnerId: input.granteeOwnerId,
    changed: committed || originallyGranted !== intended,
  };
}

export const contextsShareOperation = defineOperation<
  typeof sharingInput,
  typeof sharingOutput,
  BureauContextsSharingOperationHost
>({
  name: 'bureau.contexts.share',
  authorize: authorizeWorkspaceOperation('bureau.contexts.share'),
  mcpExposable: false,
  summary: 'Share a context read-only',
  description:
    'Lets a workspace chat owner grant read-only access to one current member of the same workspace. The grant is durable, records its grantor, and is idempotent. Missing contexts, another owner’s context, local callers, and people outside the workspace all answer NotFound.',
  destructive: false,
  tags: ['Contexts'],
  inputSchema: sharingInput,
  outputSchema: sharingOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: ({ input, host, principal }) => change(host, principal, input, 'grant'),
});

export const contextsRevokeShareOperation = defineOperation<
  typeof sharingInput,
  typeof sharingOutput,
  BureauContextsSharingOperationHost
>({
  name: 'bureau.contexts.share.revoke',
  authorize: authorizeWorkspaceOperation('bureau.contexts.share.revoke'),
  mcpExposable: false,
  summary: 'Revoke a context reader',
  description:
    'Lets a workspace chat owner revoke one reader’s current access. The former reader record remains durable so a direct-link access request can be admitted without making unrelated chats discoverable. Repeating a revocation is idempotent.',
  destructive: false,
  tags: ['Contexts'],
  inputSchema: sharingInput,
  outputSchema: sharingOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: ({ input, host, principal }) => change(host, principal, input, 'revoke'),
});

export const contextsRequestShareOperation = defineOperation<typeof sharingInput, typeof sharingOutput, BureauContextsSharingOperationHost>({
  name: 'bureau.contexts.share.request', authorize: authorizeWorkspaceOperation('bureau.contexts.share.request'), mcpExposable: false,
  summary: 'Request restored context access', description: 'Lets only a formerly granted workspace member create one pending owner-visible request. It never restores access.',
  destructive: false, tags: ['Contexts'], inputSchema: sharingInput, outputSchema: sharingOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'], access: { kind: 'authenticated' }, discoverable: true, transports, unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const store = host.contexts.internals.sessionStore;
    if (store === undefined) throw noSessions();
    const workspace = 'workspace' in principal ? principal.workspace : undefined;
    const loaded = await host.contexts.get(input.contextId);
    const owner = loaded === undefined ? null : sessionOwnerOf(loaded.metadata);
    if (loaded === undefined || owner === null || workspace === undefined || workspace.owner !== input.granteeOwnerId || !(await currentWorkspacePeer(host, principal, owner)) || !sessionWasReadGrantedTo(loaded.metadata, workspace.owner, loaded.incarnation)) throw missing(input.contextId);
    let changed = false;
    await store.update(input.contextId, (current) => {
      if (current === undefined || current.incarnation !== loaded.incarnation) return undefined;
      const before = sessionReadRequestsOf(current.metadata).some((request) => request.owner === workspace.owner && request.resolvedAt === undefined);
      if (before) return undefined;
      changed = true;
      return { ...current, metadata: withSessionReadRequest(current.metadata, { owner: workspace.owner, workspaceId: workspace.workspaceId, actorId: workspace.actorId, requestedAt: new Date().toISOString() }) };
    }, { refreshActivity: false });
    return { contextId: input.contextId, granteeOwnerId: workspace.owner, changed };
  },
});

export const contextsResolveShareRequestOperation = defineOperation<typeof requestResolutionInput, typeof sharingOutput, BureauContextsSharingOperationHost>({
  name: 'bureau.contexts.share.request.resolve', authorize: authorizeWorkspaceOperation('bureau.contexts.share.request.resolve'), mcpExposable: false,
  summary: 'Resolve a context access request', description: 'Lets only the chat owner grant or deny a pending former-reader request.',
  destructive: false, tags: ['Contexts'], inputSchema: requestResolutionInput, outputSchema: sharingOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'], access: { kind: 'authenticated' }, discoverable: true, transports, unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const store = host.contexts.internals.sessionStore;
    if (store === undefined) throw noSessions();
    const workspace = 'workspace' in principal ? principal.workspace : undefined;
    const loaded = await host.contexts.get(input.contextId);
    const owner = loaded === undefined ? null : sessionOwnerOf(loaded.metadata);
    if (loaded === undefined || owner === null || !isOwnerOfResource(principal, owner) || workspace === undefined || !(await currentWorkspacePeer(host, principal, input.granteeOwnerId))) throw missing(input.contextId);
    let changed = false;
    await store.update(input.contextId, (current) => {
      if (current === undefined || current.incarnation !== loaded.incarnation) return undefined;
      const pending = sessionReadRequestsOf(current.metadata).some((request) => request.owner === input.granteeOwnerId && request.resolvedAt === undefined);
      if (!pending) return undefined;
      changed = true;
      const at = new Date().toISOString();
      const settled = withSessionReadRequestResolution(current.metadata, input.granteeOwnerId, input.decision === 'grant' ? 'granted' : 'denied', workspace.owner, at);
      return { ...current, metadata: input.decision === 'grant' ? withSessionReadGrant(settled, { owner: input.granteeOwnerId, workspaceId: workspace.workspaceId, actorId: workspace.actorId, sessionIncarnation: current.incarnation, grantedBy: workspace.owner, grantedAt: at }) : settled };
    }, { refreshActivity: false });
    return { contextId: input.contextId, granteeOwnerId: input.granteeOwnerId, changed };
  },
});

export const contextsListShareRequestsOperation = defineOperation<z.ZodObject<Record<never, never>>, typeof requestQueueOutput, BureauContextsSharingOperationHost>({
  name: 'bureau.contexts.share.requests.list', authorize: authorizeWorkspaceOperation('bureau.contexts.share.requests.list'), mcpExposable: false,
  summary: 'List pending chat access requests', description: 'Lists only pending requests for contexts the caller owns. It never exposes another owner’s chat or request receipt.',
  destructive: false, tags: ['Contexts'], inputSchema: z.object({}), outputSchema: requestQueueOutput,
  producibleFaults: ['InvalidParams', 'UnsupportedCapability'], access: { kind: 'authenticated' }, discoverable: true, transports, unknownKeyPolicy,
  invoke: async ({ host, principal }) => {
    const requests = (await host.contexts.list()).flatMap((session) => {
      const owner = sessionOwnerOf(session.metadata);
      if (owner === null || !isOwnerOfResource(principal, owner)) return [];
      return sessionReadRequestsOf(session.metadata)
        .filter((request) => request.resolvedAt === undefined)
        .map((request) => ({ contextId: session.id, granteeOwnerId: request.owner, requestedAt: request.requestedAt }));
    });
    return { requests };
  },
});
