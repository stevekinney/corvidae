/** Explicit, owner-controlled, read-only context sharing. */

import {
  sessionHasReadGrant,
  sessionOwnerOf,
  withSessionReadGrant,
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
                actorId: workspace!.actorId,
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
