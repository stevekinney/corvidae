/**
 * B06 (row 20c) — `bureau.contexts.forgetgrants` forgets the "Allow for the rest of this chat"
 * grant of the tools named, so Retry puts the interrupted tool back behind its approval. Every row
 * of the conversation stays, and another owner's context is answered as a missing one.
 */
import { createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { waitForTaskState } from '../../test';
import {
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';

const agent = createAgent({
  name: 'agent',
  generate: async () => ({ content: 'the answer', toolCalls: [] }),
});

async function withBureau<T>(body: (opened: OpenedBureau) => Promise<T>): Promise<T> {
  const opened = await openBureau({ agents: { agent } });
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

/** A finished chat of Alice's whose session holds `grants`. */
async function chatWithGrants(opened: OpenedBureau, grants: readonly string[]) {
  const run = await opened.bureau.tasks.start('agent', 'go', { principal: OWNER.alice });
  await waitForTaskState(opened.bureau, run.id);
  await opened.bureau.internals.sessionStore!.update(run.contextId, (session) =>
    session === undefined
      ? undefined
      : { ...session, metadata: { ...session.metadata, approvalGrants: [...grants] } },
  );
  return run;
}

const forget = (
  opened: OpenedBureau,
  contextId: string,
  key: string,
  tools: readonly string[],
): Promise<RpcBody> =>
  rpc(opened.handler, 'bureau.contexts.forgetgrants', { contextId, tools }, key);

describe('bureau.contexts.forgetgrants', () => {
  it('forgets the grant of each tool named, whatever its version, keeps the others, and removes no row', async () => {
    await withBureau(async (opened) => {
      const run = await chatWithGrants(opened, [
        'default:issue_refund@3',
        'issue_refund',
        'shop:lookup_order@1',
      ]);
      const before = await opened.bureau.contexts.get(run.contextId);

      const body = await forget(opened, run.contextId, 'alice-key', ['issue_refund']);

      expect(body.error).toBeUndefined();
      expect(body.result).toEqual({ forgotten: ['default:issue_refund@3', 'issue_refund'] });
      const after = await opened.bureau.contexts.get(run.contextId);
      expect(after?.metadata['approvalGrants']).toEqual(['shop:lookup_order@1']);
      expect(after?.conversationHistory.ids).toEqual(before?.conversationHistory.ids ?? []);
      expect(after?.conversationHistory.messages).toEqual(
        before?.conversationHistory.messages ?? {},
      );
      expect(after?.updatedAt).toBe(before?.updatedAt);
    });
  });

  it('forgets a namespaced tool’s grant by the provider’s name a stored call carries', async () => {
    await withBureau(async (opened) => {
      const run = await chatWithGrants(opened, ['shop:issue-refund@1.0.0', 'issue-refund']);

      const body = await forget(opened, run.contextId, 'alice-key', ['shop__issue-refund']);

      expect(body.result).toEqual({ forgotten: ['shop:issue-refund@1.0.0'] });
      const after = await opened.bureau.contexts.get(run.contextId);
      expect(after?.metadata['approvalGrants']).toEqual(['issue-refund']);
    });
  });

  it('drops the grants entry once every grant is forgotten, and answers an empty list when none matched', async () => {
    await withBureau(async (opened) => {
      const run = await chatWithGrants(opened, ['issue_refund']);

      const unmatched = await forget(opened, run.contextId, 'alice-key', ['lookup_order']);
      expect(unmatched.result).toEqual({ forgotten: [] });
      const kept = await opened.bureau.contexts.get(run.contextId);
      expect(kept?.metadata['approvalGrants']).toEqual(['issue_refund']);

      await forget(opened, run.contextId, 'alice-key', ['issue_refund']);
      const emptied = await opened.bureau.contexts.get(run.contextId);
      expect(emptied?.metadata['approvalGrants']).toBeUndefined();
    });
  });

  it('refuses a call that names no tool', async () => {
    await withBureau(async (opened) => {
      const run = await chatWithGrants(opened, ['issue_refund']);

      const body = await forget(opened, run.contextId, 'alice-key', []);

      expect(body.error?.data).toMatchObject({ weftCode: 'InvalidParams' });
      const session = await opened.bureau.contexts.get(run.contextId);
      expect(session?.metadata['approvalGrants']).toEqual(['issue_refund']);
    });
  });

  it('answers another owner’s context exactly as a missing one, and forgets nothing', async () => {
    await withBureau(async (opened) => {
      const run = await chatWithGrants(opened, ['issue_refund']);

      const stranger = await forget(opened, run.contextId, 'bob-key', ['issue_refund']);
      const missing = await forget(opened, 'no-such-context', 'bob-key', ['issue_refund']);

      expect(stranger.error?.data?.httpStatus).toBe(404);
      expect(JSON.stringify(stranger).replaceAll(run.contextId, '<id>')).toBe(
        JSON.stringify(missing).replaceAll('no-such-context', '<id>'),
      );
      const session = await opened.bureau.contexts.get(run.contextId);
      expect(session?.metadata['approvalGrants']).toEqual(['issue_refund']);
    });
  });
});
