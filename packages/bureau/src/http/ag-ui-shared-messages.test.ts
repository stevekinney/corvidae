import { describe, expect, it } from 'bun:test';
import type { ConversationHistory } from 'conversationalist';

import { startTaskFrom } from '../test/task-start-request.ts';
import { sharedSnapshotMessages } from './ag-ui-messages.ts';
import { as, openBureau } from './management/management-fixtures.test-support.ts';
import {
  WORKSPACE_PRIVACY_ACTORS,
  workspacePrivacyAuthentication,
  workspacePrivacyCall,
  workspacePrivacyDirectory,
} from './workspace-privacy-fixtures.test-support.ts';
import type { WorkspaceMembershipOptions } from './workspace-principal.ts';

describe('shared thread message projection', () => {
  it('retains visible text while withholding tools, attachments, reasoning, and metadata', () => {
    const history = {
      id: 'shared',
      ids: ['user', 'tool', 'assistant'],
      messages: {
        user: {
          id: 'user',
          role: 'user',
          content: 'See [public](https://example.com). ![asset](/attachments/private.png)',
        },
        tool: { id: 'tool', role: 'tool-result', content: 'private tool result' },
        assistant: {
          id: 'assistant',
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'private reasoning' },
            { type: 'text', text: 'Answer with [citation](https://example.com/source).' },
          ],
          metadata: { approval: 'private' },
        },
      },
    } as unknown as ConversationHistory;

    expect(sharedSnapshotMessages(history)).toEqual([
      { id: 'user', role: 'user', content: 'See [public](https://example.com). ' },
      {
        id: 'assistant',
        role: 'assistant',
        content: 'Answer with [citation](https://example.com/source).',
      },
    ]);
  });
});

function deferred(): { readonly promise: Promise<void>; release(): void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** A real mounted AG-UI route whose owner-directory read can be held between its two session reads. */
async function withPausedSharedHistory<T>(
  change: (opened: Awaited<ReturnType<typeof openBureau>>, contextId: string) => Promise<void>,
  assert: (response: Response) => Promise<T>,
): Promise<T> {
  const directory = workspacePrivacyDirectory();
  const entered = deferred();
  const release = deferred();
  let pauseOwnerLookup = false;
  const workspace: WorkspaceMembershipOptions = {
    ...directory,
    resolveOwnerMembership: async (owner) => {
      if (pauseOwnerLookup && owner === WORKSPACE_PRIVACY_ACTORS.owner.owner) {
        entered.release();
        await release.promise;
      }
      return directory.resolveOwnerMembership?.(owner) ?? null;
    },
  };
  const opened = await openBureau({
    authentication: workspacePrivacyAuthentication,
    bureauOptions: { workspace },
    handlerOptions: { workspace, agUi: {} },
  });
  try {
    const task = await startTaskFrom(opened.bureau, {
      agentName: 'default',
      input: 'visible shared history sentinel',
      principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
    });
    const contextId = task.contextId;
    const grant = await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.share', {
      contextId,
      granteeOwnerId: WORKSPACE_PRIVACY_ACTORS.peer.owner,
    });
    expect(grant.body?.result).toMatchObject({ changed: true });

    const stable = await opened.handler(
      new Request(`http://localhost/ag-ui/threads/${contextId}/shared-messages`, {
        headers: as(WORKSPACE_PRIVACY_ACTORS.peer.key),
      }),
    );
    expect(stable.status).toBe(200);
    expect(await stable.text()).toContain('visible shared history sentinel');

    pauseOwnerLookup = true;
    const response = opened.handler(
      new Request(`http://localhost/ag-ui/threads/${contextId}/shared-messages`, {
        headers: as(WORKSPACE_PRIVACY_ACTORS.peer.key),
      }),
    );
    await entered.promise;
    await change(opened, contextId);
    release.release();
    return await assert(await response);
  } finally {
    release.release();
    await opened.dispose();
  }
}

describe('mounted shared thread history', () => {
  it('does not disclose a transcript when the grant is revoked during owner-directory authorization', async () => {
    await withPausedSharedHistory(
      async (opened, contextId) => {
        const revoked = await workspacePrivacyCall(
          opened,
          'owner',
          'bureau.contexts.share.revoke',
          {
            contextId,
            granteeOwnerId: WORKSPACE_PRIVACY_ACTORS.peer.owner,
          },
        );
        expect(revoked.body?.result).toMatchObject({ changed: true });
      },
      async (response) => {
        expect(response.status).toBe(404);
        const body = await response.text();
        expect(body).not.toContain('visible shared history sentinel');
      },
    );
  });

  it('does not disclose a transcript when its session is deleted during owner-directory authorization', async () => {
    await withPausedSharedHistory(
      async (opened, contextId) => {
        await opened.bureau.contexts.delete(contextId);
      },
      async (response) => {
        expect(response.status).toBe(404);
        const body = await response.text();
        expect(body).not.toContain('visible shared history sentinel');
      },
    );
  });
});
