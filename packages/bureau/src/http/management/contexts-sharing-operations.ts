/** Explicit, owner-controlled, read-only context sharing. */

import {
  sessionReadGrantOf,
  sessionReadGrantHistoryOf,
  sessionOwnerOf,
  sessionReadRequestsOf,
  summarizeSession,
  withSessionReadGrant,
  withSessionReadGrantAttempt,
  withSessionReadRequest,
  withSessionReadRequestResolution,
  withSessionReadRevocation,
} from '@lostgradient/operative';
import type { SessionReadGrant, SessionReadRequest } from '@lostgradient/operative';
import { defineOperation, type OperationFault, type Principal } from '@lostgradient/backchannel';
import { z } from 'zod';

import type { BureauInternals } from '../../bureau-types/facade.ts';
import { isOwnerOfResource, type BureauOwnershipHost } from '../owner-predicate.ts';
import { type BureauWorkspaceHost } from '../workspace-principal.ts';
import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';
import { noSessions } from './contexts-operations.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

export type BureauContextsSharingOperationHost = BureauOwnershipHost &
  BureauWorkspaceHost & {
    readonly contexts: {
      readonly get: (
        id: string,
      ) => Promise<import('@lostgradient/operative').AgentSession | undefined>;
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
// A requester cannot name an owner. The authenticated workspace directory supplies it.
const requestShareInput = sharingInput.pick({ contextId: true });
const shareStatusInput = sharingInput.pick({ contextId: true });

const sharingOutput = z.object({
  contextId: z.string(),
  granteeOwnerId: z.string(),
  changed: z.boolean(),
});
const requestResolutionInput = sharingInput.extend({ decision: z.enum(['grant', 'deny']) });
const requestQueueOutput = z.object({
  requests: z.array(
    z.object({
      contextId: z.string(),
      granteeOwnerId: z.string(),
      requestedAt: z.string(),
    }),
  ),
});
const shareStatusOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('active'),
    title: z.string().nullable(),
    agentName: z.string(),
    grantor: z.string().nullable(),
  }),
  z.object({ status: z.literal('requestable') }),
  z.object({ status: z.literal('pending') }),
]);

function missing(contextId: string): OperationFault {
  return resourceNotFound('context', contextId);
}

async function currentWorkspacePeer(
  host: BureauContextsSharingOperationHost,
  principal: Principal,
  owner: string,
): Promise<boolean> {
  const workspace = 'workspace' in principal ? principal.workspace : undefined;
  if (workspace === undefined || workspace.actorKind === 'local' || workspace.owner === owner)
    return false;
  const authority = host.workspaceAuthority?.(principal);
  return authority === undefined ? false : authority(owner);
}

function sameGrant(left: SessionReadGrant | undefined, right: SessionReadGrant | undefined) {
  return (
    left?.owner === right?.owner &&
    left?.workspaceId === right?.workspaceId &&
    left?.actorId === right?.actorId &&
    left?.sessionIncarnation === right?.sessionIncarnation &&
    left?.grantedBy === right?.grantedBy &&
    left?.grantedAt === right?.grantedAt &&
    left?.revokedAt === right?.revokedAt &&
    left?.revokedBy === right?.revokedBy
  );
}

function sameRequest(left: SessionReadRequest | undefined, right: SessionReadRequest | undefined) {
  return (
    left?.owner === right?.owner &&
    left?.workspaceId === right?.workspaceId &&
    left?.actorId === right?.actorId &&
    left?.requestedAt === right?.requestedAt &&
    left?.resolvedAt === right?.resolvedAt &&
    left?.resolvedBy === right?.resolvedBy &&
    left?.decision === right?.decision
  );
}

function changedGrantEventCount(
  metadata: Readonly<Record<string, import('@lostgradient/operative').JSONValue>>,
  owner: string,
) {
  return sessionReadGrantHistoryOf(metadata).filter(
    (event) => event.owner === owner && event.changed,
  ).length;
}

function requestCount(
  metadata: Readonly<Record<string, import('@lostgradient/operative').JSONValue>>,
  owner: string,
) {
  return sessionReadRequestsOf(metadata).filter((request) => request.owner === owner).length;
}

function isActiveGrant(
  grant: SessionReadGrant | undefined,
  workspaceId: string,
  actorId: string,
  incarnation: string,
) {
  return (
    grant !== undefined &&
    grant.revokedAt === undefined &&
    grant.workspaceId === workspaceId &&
    grant.actorId === actorId &&
    grant.sessionIncarnation === incarnation
  );
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
  if (
    target === undefined ||
    target.workspaceId !== workspace!.workspaceId ||
    target.actorKind !== 'user'
  )
    throw missing(input.contextId);
  const originalGrant = sessionReadGrantOf(loaded.metadata, input.granteeOwnerId);
  const originalGrantEvents = changedGrantEventCount(loaded.metadata, input.granteeOwnerId);
  let committed = false;
  await store.update(
    input.contextId,
    (current) => {
      if (current === undefined || current.incarnation !== loaded.incarnation) return undefined;
      const currentGrant = sessionReadGrantOf(current.metadata, input.granteeOwnerId);
      const currentlyGranted = isActiveGrant(
        currentGrant,
        workspace!.workspaceId,
        target.actorId,
        current.incarnation,
      );
      // A revoke is bound to the exact active grant the owner saw. It cannot revoke a
      // replacement grant restored while the owner command was awaiting the directory.
      if (
        kind === 'revoke' &&
        (!sameGrant(currentGrant, originalGrant) ||
          changedGrantEventCount(current.metadata, input.granteeOwnerId) !== originalGrantEvents)
      )
        return undefined;
      if ((kind === 'grant' && currentlyGranted) || (kind === 'revoke' && !currentlyGranted)) {
        if (currentGrant === undefined) return undefined;
        const pending = sessionReadRequestsOf(current.metadata).some(
          (request) => request.owner === input.granteeOwnerId && request.resolvedAt === undefined,
        );
        committed ||= kind === 'grant' && pending;
        const at = new Date().toISOString();
        const attempted = withSessionReadGrantAttempt(
          current.metadata,
          input.granteeOwnerId,
          kind === 'grant' ? 'granted' : 'revoked',
          grantedBy,
          at,
        );
        return {
          ...current,
          metadata:
            kind === 'grant' && pending
              ? withSessionReadRequestResolution(
                  attempted,
                  input.granteeOwnerId,
                  'granted',
                  grantedBy,
                  at,
                )
              : attempted,
        };
      }
      committed = true;
      const at = new Date().toISOString();
      const next =
        kind === 'grant'
          ? withSessionReadGrant(current.metadata, {
              owner: input.granteeOwnerId,
              workspaceId: workspace!.workspaceId,
              actorId: target.actorId,
              sessionIncarnation: current.incarnation,
              grantedBy,
              grantedAt: at,
            })
          : withSessionReadRevocation(current.metadata, input.granteeOwnerId, grantedBy, at);
      const pending = sessionReadRequestsOf(next).some(
        (request) => request.owner === input.granteeOwnerId && request.resolvedAt === undefined,
      );
      return {
        ...current,
        metadata:
          kind === 'grant' && pending
            ? withSessionReadRequestResolution(next, input.granteeOwnerId, 'granted', grantedBy, at)
            : next,
      };
    },
    { refreshActivity: false },
  );
  return {
    contextId: input.contextId,
    granteeOwnerId: input.granteeOwnerId,
    changed: committed,
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

export const contextsRequestShareOperation = defineOperation<
  typeof requestShareInput,
  typeof sharingOutput,
  BureauContextsSharingOperationHost
>({
  name: 'bureau.contexts.share.request',
  authorize: authorizeWorkspaceOperation('bureau.contexts.share.request'),
  mcpExposable: false,
  summary: 'Request restored context access',
  description:
    'Lets only a formerly granted workspace member create one pending owner-visible request. It never restores access.',
  destructive: false,
  tags: ['Contexts'],
  inputSchema: requestShareInput,
  outputSchema: sharingOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const store = host.contexts.internals.sessionStore;
    if (store === undefined) throw noSessions();
    const workspace = 'workspace' in principal ? principal.workspace : undefined;
    const loaded = await host.contexts.get(input.contextId);
    const owner = loaded === undefined ? null : sessionOwnerOf(loaded.metadata);
    const formerGrant =
      loaded === undefined || workspace === undefined
        ? undefined
        : sessionReadGrantOf(loaded.metadata, workspace.owner);
    const priorRequests =
      loaded === undefined ? 0 : requestCount(loaded.metadata, workspace?.owner ?? '');
    if (
      loaded === undefined ||
      owner === null ||
      workspace === undefined ||
      !(await currentWorkspacePeer(host, principal, owner)) ||
      formerGrant === undefined ||
      formerGrant.revokedAt === undefined ||
      formerGrant.workspaceId !== workspace.workspaceId ||
      formerGrant.actorId !== workspace.actorId ||
      formerGrant.sessionIncarnation !== loaded.incarnation
    )
      throw missing(input.contextId);
    let changed = false;
    await store.update(
      input.contextId,
      (current) => {
        if (current === undefined || current.incarnation !== loaded.incarnation) return undefined;
        const currentGrant = sessionReadGrantOf(current.metadata, workspace.owner);
        if (
          !sameGrant(currentGrant, formerGrant) ||
          requestCount(current.metadata, workspace.owner) !== priorRequests
        )
          return undefined;
        const before = sessionReadRequestsOf(current.metadata).some(
          (request) => request.owner === workspace.owner && request.resolvedAt === undefined,
        );
        if (before) return undefined;
        changed = true;
        return {
          ...current,
          metadata: withSessionReadRequest(current.metadata, {
            owner: workspace.owner,
            workspaceId: workspace.workspaceId,
            actorId: workspace.actorId,
            requestedAt: new Date().toISOString(),
          }),
        };
      },
      { refreshActivity: false },
    );
    return { contextId: input.contextId, granteeOwnerId: workspace.owner, changed };
  },
});

export const contextsResolveShareRequestOperation = defineOperation<
  typeof requestResolutionInput,
  typeof sharingOutput,
  BureauContextsSharingOperationHost
>({
  name: 'bureau.contexts.share.request.resolve',
  authorize: authorizeWorkspaceOperation('bureau.contexts.share.request.resolve'),
  mcpExposable: false,
  summary: 'Resolve a context access request',
  description: 'Lets only the chat owner grant or deny a pending former-reader request.',
  destructive: false,
  tags: ['Contexts'],
  inputSchema: requestResolutionInput,
  outputSchema: sharingOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const store = host.contexts.internals.sessionStore;
    if (store === undefined) throw noSessions();
    const workspace = 'workspace' in principal ? principal.workspace : undefined;
    const loaded = await host.contexts.get(input.contextId);
    const owner = loaded === undefined ? null : sessionOwnerOf(loaded.metadata);
    const target = await host.resolveWorkspaceOwner?.(input.granteeOwnerId);
    const pending =
      loaded === undefined
        ? undefined
        : sessionReadRequestsOf(loaded.metadata).find(
            (request) => request.owner === input.granteeOwnerId && request.resolvedAt === undefined,
          );
    const priorRequests =
      loaded === undefined ? 0 : requestCount(loaded.metadata, input.granteeOwnerId);
    if (
      loaded === undefined ||
      owner === null ||
      !isOwnerOfResource(principal, owner) ||
      workspace === undefined ||
      !(await currentWorkspacePeer(host, principal, input.granteeOwnerId)) ||
      target === undefined ||
      target.workspaceId !== workspace.workspaceId ||
      target.actorKind !== 'user'
    )
      throw missing(input.contextId);
    if (
      pending === undefined ||
      pending.workspaceId !== target.workspaceId ||
      pending.actorId !== target.actorId
    )
      return { contextId: input.contextId, granteeOwnerId: input.granteeOwnerId, changed: false };
    let changed = false;
    await store.update(
      input.contextId,
      (current) => {
        if (current === undefined || current.incarnation !== loaded.incarnation) return undefined;
        const currentPending = sessionReadRequestsOf(current.metadata).find(
          (request) => request.owner === input.granteeOwnerId && request.resolvedAt === undefined,
        );
        if (
          !sameRequest(currentPending, pending) ||
          requestCount(current.metadata, input.granteeOwnerId) !== priorRequests
        )
          return undefined;
        changed = true;
        const at = new Date().toISOString();
        const settled = withSessionReadRequestResolution(
          current.metadata,
          input.granteeOwnerId,
          input.decision === 'grant' ? 'granted' : 'denied',
          workspace.owner,
          at,
        );
        return {
          ...current,
          metadata:
            input.decision === 'grant'
              ? withSessionReadGrant(settled, {
                  owner: input.granteeOwnerId,
                  workspaceId: workspace.workspaceId,
                  actorId: pending.actorId,
                  sessionIncarnation: current.incarnation,
                  grantedBy: workspace.owner,
                  grantedAt: at,
                })
              : settled,
        };
      },
      { refreshActivity: false },
    );
    return { contextId: input.contextId, granteeOwnerId: input.granteeOwnerId, changed };
  },
});

export const contextsListShareRequestsOperation = defineOperation<
  z.ZodObject<Record<never, never>>,
  typeof requestQueueOutput,
  BureauContextsSharingOperationHost
>({
  name: 'bureau.contexts.share.requests.list',
  authorize: authorizeWorkspaceOperation('bureau.contexts.share.requests.list'),
  mcpExposable: false,
  summary: 'List pending chat access requests',
  description:
    'Lists only pending requests for contexts the caller owns. It never exposes another owner’s chat or request receipt.',
  destructive: false,
  tags: ['Contexts'],
  inputSchema: z.object({}),
  outputSchema: requestQueueOutput,
  producibleFaults: ['InvalidParams', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ host, principal }) => {
    const sessions = await host.contexts.list();
    const requests = sessions.flatMap((session) => {
      const owner = sessionOwnerOf(session.metadata);
      if (owner === null || !isOwnerOfResource(principal, owner)) return [];
      return sessionReadRequestsOf(session.metadata)
        .filter((request) => request.resolvedAt === undefined)
        .map((request) => ({
          contextId: session.id,
          granteeOwnerId: request.owner,
          requestedAt: request.requestedAt,
        }));
    });
    return { requests };
  },
});

/**
 * The only direct-link probe a former reader receives. It deliberately says no title, owner, or
 * other context metadata: an unknown or unrelated context remains the ordinary not-found result.
 */
export const contextsShareStatusOperation = defineOperation<
  typeof shareStatusInput,
  typeof shareStatusOutput,
  BureauContextsSharingOperationHost
>({
  name: 'bureau.contexts.share.status',
  authorize: authorizeWorkspaceOperation('bureau.contexts.share.status'),
  mcpExposable: false,
  summary: 'Read this caller’s shared-chat access state',
  description:
    'Returns active, requestable, or pending only to a current same-workspace reader or former reader of this exact context. All other callers receive NotFound without context metadata.',
  destructive: false,
  tags: ['Contexts'],
  inputSchema: shareStatusInput,
  outputSchema: shareStatusOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const workspace = 'workspace' in principal ? principal.workspace : undefined;
    const loaded = await host.contexts.get(input.contextId);
    const owner = loaded === undefined ? null : sessionOwnerOf(loaded.metadata);
    if (
      loaded === undefined ||
      owner === null ||
      workspace === undefined ||
      !(await currentWorkspacePeer(host, principal, owner))
    )
      throw missing(input.contextId);
    const grant = sessionReadGrantOf(loaded.metadata, workspace.owner);
    if (
      grant !== undefined &&
      grant.revokedAt === undefined &&
      grant.workspaceId === workspace.workspaceId &&
      grant.actorId === workspace.actorId &&
      grant.sessionIncarnation === loaded.incarnation
    ) {
      const summary = summarizeSession(loaded);
      const grantor = await host.resolveWorkspaceOwner?.(owner);
      return {
        status: 'active' as const,
        title: summary.title,
        agentName: summary.agentName,
        grantor: grantor?.displayName ?? null,
      };
    }
    if (
      grant === undefined ||
      grant.revokedAt === undefined ||
      grant.workspaceId !== workspace.workspaceId ||
      grant.actorId !== workspace.actorId ||
      grant.sessionIncarnation !== loaded.incarnation
    )
      throw missing(input.contextId);
    return {
      status: sessionReadRequestsOf(loaded.metadata).some(
        (request) => request.owner === workspace.owner && request.resolvedAt === undefined,
      )
        ? ('pending' as const)
        : ('requestable' as const),
    };
  },
});
