/* oxlint-disable unicorn/no-await-expression-member -- transport assertions intentionally inspect receipts inline. */
import { describe, expect, test } from 'bun:test';
import {
  createAgentSession,
  sessionReadGrantHistoryOf,
  sessionReadGrantOf,
  sessionReadRequestsOf,
  withSessionReadGrant,
  withSessionReadRevocation,
} from '@lostgradient/operative';
import { createConversationHistory } from 'conversationalist';

import { startTaskFrom } from '../../test/task-start-request.ts';
import {
  openWorkspacePrivacyBureau,
  workspacePrivacyCall,
  WORKSPACE_PRIVACY_ACTORS,
  type WorkspacePrivacyActor,
} from '../workspace-privacy-fixtures.test-support.ts';
import { workspaceConformanceLedger } from '../workspace-conformance-ledger.test-support.ts';
import {
  contextsRequestShareOperation,
  contextsRevokeShareOperation,
  contextsShareStatusOperation,
} from './contexts-sharing-operations.ts';

async function chat(opened: Awaited<ReturnType<typeof openWorkspacePrivacyBureau>>) {
  const run = await startTaskFrom(opened.bureau, {
    agentName: 'default',
    input: 'private chat',
    principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
  });
  return run.contextId;
}

function sharedSession(metadata: Record<string, import('@lostgradient/operative').JSONValue>) {
  return {
    ...createAgentSession({
      id: 'shared-context',
      agentName: 'default',
      conversationHistory: createConversationHistory(),
      metadata: { sessionOwner: WORKSPACE_PRIVACY_ACTORS.owner.owner, ...metadata },
      runs: [],
    }),
    incarnation: 'shared-incarnation',
  };
}

function sharingHost(
  initial: ReturnType<typeof sharedSession>,
  replaceBeforeUpdate: (
    session: ReturnType<typeof sharedSession>,
  ) => ReturnType<typeof sharedSession>,
) {
  let current = initial;
  return {
    host: {
      ownership: {
        mayAccess: ({ resourceOwner }: { resourceOwner?: string }) =>
          resourceOwner === WORKSPACE_PRIVACY_ACTORS.owner.owner,
        runOwner: async () => undefined,
      },
      workspaceAuthority: () => async () => true,
      resolveWorkspaceOwner: async (owner: string) =>
        owner === WORKSPACE_PRIVACY_ACTORS.peer.owner
          ? {
              version: 1 as const,
              workspaceId: 'workspace-a',
              actorId: 'bob',
              actorKind: 'user' as const,
              owner,
              membershipRevision: 'one',
              capabilities: ['workspace:use' as const],
            }
          : undefined,
      contexts: {
        get: async () => current,
        list: async () => [],
        internals: {
          sessionStore: {
            update: async (_id: string, mutation: (session: typeof current) => typeof current) => {
              current = replaceBeforeUpdate(current);
              const next = mutation(current);
              if (next !== undefined) current = next;
              return current;
            },
          },
        },
      },
    },
    current: () => current,
  };
}

const workspacePrincipal = (actor: 'owner' | 'peer') => ({
  method: 'api-key',
  subject: WORKSPACE_PRIVACY_ACTORS[actor].subject,
  scopes: new Set<string>(),
  workspace: {
    workspaceId: 'workspace-a',
    actorId: actor === 'owner' ? 'alice' : 'bob',
    actorKind: 'user' as const,
    owner: WORKSPACE_PRIVACY_ACTORS[actor].owner,
    membershipRevision: 'one',
    capabilities: ['workspace:use' as const],
  },
});

describe('chat sharing access requests', () => {
  test('returns metadata-free requestable when a grantor lookup races a revocation', async () => {
    const initial = sharedSession(
      withSessionReadGrant(
        {},
        {
          owner: WORKSPACE_PRIVACY_ACTORS.peer.owner,
          workspaceId: 'workspace-a',
          actorId: 'bob',
          sessionIncarnation: 'shared-incarnation',
          grantedBy: WORKSPACE_PRIVACY_ACTORS.owner.owner,
          grantedAt: '2026-11-24T00:00:00.000Z',
        },
      ),
    );
    const { host, current } = sharingHost(initial, (session) => session);
    host.resolveWorkspaceOwner = async (owner: string) => {
      if (owner !== WORKSPACE_PRIVACY_ACTORS.owner.owner) return undefined;
      const session = current();
      await host.contexts.internals.sessionStore.update(session.id, () => ({
        ...session,
        metadata: withSessionReadRevocation(
          session.metadata,
          WORKSPACE_PRIVACY_ACTORS.peer.owner,
          WORKSPACE_PRIVACY_ACTORS.owner.owner,
          '2026-11-24T00:01:00.000Z',
        ),
      }));
      return { ...workspacePrincipal('owner').workspace, displayName: 'Avery Owner' };
    };

    await expect(
      contextsShareStatusOperation.invoke({
        input: { contextId: initial.id },
        host,
        principal: workspacePrincipal('peer'),
      } as never),
    ).resolves.toEqual({ status: 'requestable' });
  });

  test('executes all six actor witnesses for sharing operations', async () => {
    const opened = await openWorkspacePrivacyBureau();
    const witnesses = workspaceConformanceLedger('management/contexts-sharing-operations.test.ts');
    try {
      const contextId = await chat(opened);
      const actors = Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[];
      for (const actor of actors) {
        witnesses.observeWire(
          'bureau.contexts.share',
          actor,
          await workspacePrivacyCall(opened, actor, 'bureau.contexts.share', {
            contextId,
            granteeOwnerId: WORKSPACE_PRIVACY_ACTORS.peer.owner,
          }),
        );
      }
      for (const actor of actors) {
        witnesses.observeWire(
          'bureau.contexts.share.status',
          actor,
          await workspacePrivacyCall(opened, actor, 'bureau.contexts.share.status', { contextId }),
        );
      }
      for (const actor of actors) {
        witnesses.observeWire(
          'bureau.contexts.share.revoke',
          actor,
          await workspacePrivacyCall(opened, actor, 'bureau.contexts.share.revoke', {
            contextId,
            granteeOwnerId: WORKSPACE_PRIVACY_ACTORS.peer.owner,
          }),
        );
      }
      for (const actor of actors) {
        witnesses.observeWire(
          'bureau.contexts.share.request',
          actor,
          await workspacePrivacyCall(opened, actor, 'bureau.contexts.share.request', { contextId }),
        );
      }
      for (const actor of actors) {
        witnesses.observeCollection(
          'bureau.contexts.share.requests.list',
          actor,
          await workspacePrivacyCall(opened, actor, 'bureau.contexts.share.requests.list', {}),
          contextId,
        );
      }
      for (const actor of actors) {
        witnesses.observeWire(
          'bureau.contexts.share.request.resolve',
          actor,
          await workspacePrivacyCall(opened, actor, 'bureau.contexts.share.request.resolve', {
            contextId,
            granteeOwnerId: WORKSPACE_PRIVACY_ACTORS.peer.owner,
            decision: 'grant',
          }),
        );
      }
      witnesses.verify();
    } finally {
      await opened.dispose();
    }
  });
  test('does not append a request after an owner restores the former grant in the update fence', async () => {
    const initial = sharedSession(
      withSessionReadRevocation(
        withSessionReadGrant(
          {},
          {
            owner: WORKSPACE_PRIVACY_ACTORS.peer.owner,
            workspaceId: 'workspace-a',
            actorId: 'bob',
            sessionIncarnation: 'shared-incarnation',
            grantedBy: WORKSPACE_PRIVACY_ACTORS.owner.owner,
            grantedAt: '2026-11-23T00:00:00.000Z',
          },
        ),
        WORKSPACE_PRIVACY_ACTORS.peer.owner,
        WORKSPACE_PRIVACY_ACTORS.owner.owner,
        '2026-11-23T00:01:00.000Z',
      ),
    );
    const { host, current } = sharingHost(initial, (session) => ({
      ...session,
      metadata: withSessionReadGrant(session.metadata, {
        owner: WORKSPACE_PRIVACY_ACTORS.peer.owner,
        workspaceId: 'workspace-a',
        actorId: 'bob',
        sessionIncarnation: session.incarnation,
        grantedBy: WORKSPACE_PRIVACY_ACTORS.owner.owner,
        grantedAt: '2026-11-23T00:00:00.000Z',
      }),
    }));

    const receipt = await contextsRequestShareOperation.invoke({
      input: { contextId: initial.id },
      host,
      principal: workspacePrincipal('peer'),
    } as never);

    expect(receipt).toMatchObject({ changed: false });
    expect(sessionReadRequestsOf(current().metadata)).toEqual([]);
    expect(
      sessionReadGrantOf(current().metadata, WORKSPACE_PRIVACY_ACTORS.peer.owner),
    ).toMatchObject({
      grantedAt: '2026-11-23T00:00:00.000Z',
    });
  });

  test('does not revoke a replacement grant restored in the update fence', async () => {
    const initial = sharedSession(
      withSessionReadGrant(
        {},
        {
          owner: WORKSPACE_PRIVACY_ACTORS.peer.owner,
          workspaceId: 'workspace-a',
          actorId: 'bob',
          sessionIncarnation: 'shared-incarnation',
          grantedBy: WORKSPACE_PRIVACY_ACTORS.owner.owner,
          grantedAt: '2026-11-23T00:00:00.000Z',
        },
      ),
    );
    const { host, current } = sharingHost(initial, (session) => ({
      ...session,
      metadata: withSessionReadGrant(session.metadata, {
        owner: WORKSPACE_PRIVACY_ACTORS.peer.owner,
        workspaceId: 'workspace-a',
        actorId: 'bob',
        sessionIncarnation: session.incarnation,
        grantedBy: WORKSPACE_PRIVACY_ACTORS.owner.owner,
        grantedAt: '2026-11-23T00:02:00.000Z',
      }),
    }));

    const receipt = await contextsRevokeShareOperation.invoke({
      input: { contextId: initial.id, granteeOwnerId: WORKSPACE_PRIVACY_ACTORS.peer.owner },
      host,
      principal: workspacePrincipal('owner'),
    } as never);

    expect(receipt).toMatchObject({ changed: false });
    expect(
      sessionReadGrantOf(current().metadata, WORKSPACE_PRIVACY_ACTORS.peer.owner),
    ).toMatchObject({
      grantedAt: '2026-11-23T00:02:00.000Z',
    });
  });

  test('a former workspace reader creates one receipt and only its owner can resolve it', async () => {
    const opened = await openWorkspacePrivacyBureau();
    try {
      const contextId = await chat(opened);
      const granteeOwnerId = WORKSPACE_PRIVACY_ACTORS.peer.owner;
      expect(
        (
          await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.share', {
            contextId,
            granteeOwnerId,
          })
        ).body?.result,
      ).toMatchObject({ changed: true });
      expect(
        (await workspacePrivacyCall(opened, 'peer', 'bureau.contexts.share.status', { contextId }))
          .body?.result,
      ).toMatchObject({ status: 'active', title: 'private chat', agentName: 'default' });
      expect(
        (await workspacePrivacyCall(opened, 'peer', 'bureau.contexts.list', {})).body?.result,
      ).toMatchObject({
        contexts: [
          expect.objectContaining({
            id: contextId,
            owner: null,
            lastMessagePreview: null,
            parentContextId: null,
            forkedFromMessageId: null,
          }),
        ],
      });
      const repeatedGrant = await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.share', {
        contextId,
        granteeOwnerId,
      });
      expect(repeatedGrant.body).toMatchObject({ result: { changed: false } });
      expect(
        (
          await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.share.revoke', {
            contextId,
            granteeOwnerId,
          })
        ).body?.result,
      ).toMatchObject({ changed: true });
      expect(
        (await workspacePrivacyCall(opened, 'peer', 'bureau.contexts.share.status', { contextId }))
          .body?.result,
      ).toEqual({ status: 'requestable' });
      expect(
        (await workspacePrivacyCall(opened, 'peer', 'bureau.contexts.list', {})).body?.result,
      ).toMatchObject({ contexts: [] });
      expect(
        (
          await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.share.revoke', {
            contextId,
            granteeOwnerId,
          })
        ).body?.result,
      ).toMatchObject({ changed: false });
      expect(
        sessionReadGrantHistoryOf((await opened.bureau.contexts.get(contextId))!.metadata).map(
          (entry) => entry.changed,
        ),
      ).toEqual([true, false, true, false]);
      expect(
        (
          await workspacePrivacyCall(opened, 'peer', 'bureau.contexts.share.request', {
            contextId,
          })
        ).body?.result,
      ).toMatchObject({ changed: true });
      expect(
        (await workspacePrivacyCall(opened, 'peer', 'bureau.contexts.share.status', { contextId }))
          .body?.result,
      ).toEqual({ status: 'pending' });
      expect(
        (
          await workspacePrivacyCall(opened, 'peer', 'bureau.contexts.share.request', {
            contextId,
          })
        ).body?.result,
      ).toMatchObject({ changed: false });
      expect(
        (await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.share.requests.list', {}))
          .body?.result,
      ).toMatchObject({ requests: [{ contextId, granteeOwnerId }] });
      expect(
        (await workspacePrivacyCall(opened, 'peer', 'bureau.contexts.share.requests.list', {})).body
          ?.result,
      ).toEqual({ requests: [] });
      expect(
        (
          await workspacePrivacyCall(opened, 'peer', 'bureau.contexts.share.request.resolve', {
            contextId,
            granteeOwnerId,
            decision: 'grant',
          })
        ).body?.error?.data?.httpStatus,
      ).toBe(404);
      expect(
        (
          await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.share.request.resolve', {
            contextId,
            granteeOwnerId,
            decision: 'grant',
          })
        ).body?.result,
      ).toMatchObject({ changed: true });
      expect(
        (await workspacePrivacyCall(opened, 'peer', 'bureau.contexts.share.status', { contextId }))
          .body?.result,
      ).toMatchObject({ status: 'active', title: 'private chat', agentName: 'default' });
      expect(
        (
          await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.share.request.resolve', {
            contextId,
            granteeOwnerId,
            decision: 'grant',
          })
        ).body?.result,
      ).toMatchObject({ changed: false });
    } finally {
      await opened.dispose();
    }
  });

  test('unrelated and foreign callers cannot create a receipt or learn the queue', async () => {
    const opened = await openWorkspacePrivacyBureau();
    try {
      const contextId = await chat(opened);
      for (const actor of ['grantee', 'foreign'] as const) {
        const response = await workspacePrivacyCall(
          opened,
          actor,
          'bureau.contexts.share.request',
          { contextId },
        );
        expect(response.body?.error?.data?.httpStatus ?? response.status).toBe(
          actor === 'foreign' ? 403 : 404,
        );
      }
      expect(
        (await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.share.requests.list', {}))
          .body?.result,
      ).toEqual({ requests: [] });
      for (const actor of ['grantee', 'foreign'] as const) {
        const response = await workspacePrivacyCall(opened, actor, 'bureau.contexts.share.status', {
          contextId,
        });
        expect(response.body?.error?.data?.httpStatus ?? response.status).toBe(
          actor === 'foreign' ? 403 : 404,
        );
      }
    } finally {
      await opened.dispose();
    }
  });
});
