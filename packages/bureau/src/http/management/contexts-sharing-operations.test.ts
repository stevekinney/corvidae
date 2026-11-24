import { describe, expect, test } from 'bun:test';

import { startTaskFrom } from '../../test/task-start-request.ts';
import {
  openWorkspacePrivacyBureau,
  workspacePrivacyCall,
  WORKSPACE_PRIVACY_ACTORS,
} from '../workspace-privacy-fixtures.test-support.ts';

async function chat(opened: Awaited<ReturnType<typeof openWorkspacePrivacyBureau>>) {
  const run = await startTaskFrom(opened.bureau, {
    agentName: 'default',
    input: 'private chat',
    principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
  });
  return run.contextId;
}

describe('chat sharing access requests', () => {
  test('a former workspace reader creates one receipt and only its owner can resolve it', async () => {
    const opened = await openWorkspacePrivacyBureau();
    try {
      const contextId = await chat(opened);
      const granteeOwnerId = WORKSPACE_PRIVACY_ACTORS.peer.owner;
      expect((await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.share', { contextId, granteeOwnerId })).body?.result).toMatchObject({ changed: true });
      expect((await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.share.revoke', { contextId, granteeOwnerId })).body?.result).toMatchObject({ changed: true });
      expect((await workspacePrivacyCall(opened, 'peer', 'bureau.contexts.share.request', { contextId, granteeOwnerId })).body?.result).toMatchObject({ changed: true });
      expect((await workspacePrivacyCall(opened, 'peer', 'bureau.contexts.share.request', { contextId, granteeOwnerId })).body?.result).toMatchObject({ changed: false });
      expect((await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.share.requests.list', {})).body?.result).toMatchObject({ requests: [{ contextId, granteeOwnerId }] });
      expect((await workspacePrivacyCall(opened, 'peer', 'bureau.contexts.share.requests.list', {})).body?.result).toEqual({ requests: [] });
      expect((await workspacePrivacyCall(opened, 'peer', 'bureau.contexts.share.request.resolve', { contextId, granteeOwnerId, decision: 'grant' })).body?.error?.data?.httpStatus).toBe(404);
      expect((await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.share.request.resolve', { contextId, granteeOwnerId, decision: 'grant' })).body?.result).toMatchObject({ changed: true });
      expect((await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.share.request.resolve', { contextId, granteeOwnerId, decision: 'grant' })).body?.result).toMatchObject({ changed: false });
    } finally {
      await opened.dispose();
    }
  });

  test('unrelated and foreign callers cannot create a receipt or learn the queue', async () => {
    const opened = await openWorkspacePrivacyBureau();
    try {
      const contextId = await chat(opened);
      for (const actor of ['grantee', 'foreign'] as const) {
        const response = await workspacePrivacyCall(opened, actor, 'bureau.contexts.share.request', { contextId, granteeOwnerId: WORKSPACE_PRIVACY_ACTORS[actor].owner });
        expect(response.body?.error?.data?.httpStatus ?? response.status).toBe(actor === 'foreign' ? 403 : 404);
      }
      expect((await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.share.requests.list', {})).body?.result).toEqual({ requests: [] });
    } finally {
      await opened.dispose();
    }
  });
});
