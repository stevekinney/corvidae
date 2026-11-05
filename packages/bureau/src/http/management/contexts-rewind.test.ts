/**
 * B06 (rows 19r and 20c) — `bureau.contexts.rewind` takes a turn back out of a context, so Retry
 * sends it again over a thread that never held the failed attempt. The rows are gone from the
 * Bureau's own record (a thread read again does not bring them back), the grants of the tools named
 * are forgotten, and a refusal changes nothing.
 */
import { createAgent } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { waitForCondition, waitForTaskState } from '../../test';
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

async function finishedSession(opened: OpenedBureau) {
  const run = await opened.bureau.tasks.start('agent', 'go', { principal: OWNER.alice });
  await waitForTaskState(opened.bureau, run.id);
  return run;
}

const rewind = (
  opened: OpenedBureau,
  contextId: string,
  key: string,
  params: Record<string, unknown>,
): Promise<RpcBody> => rpc(opened.handler, 'bureau.contexts.rewind', { contextId, ...params }, key);

async function rowIds(opened: OpenedBureau, contextId: string): Promise<readonly string[]> {
  const session = await opened.bureau.contexts.get(contextId);
  return session?.conversationHistory.ids ?? [];
}

describe('bureau.contexts.rewind', () => {
  it('removes the row and every row after it, answers what it removed, and keeps them out of a thread read again', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      const before = await rowIds(opened, run.contextId);
      expect(before.length).toBeGreaterThan(1);
      const first = before[0]!;

      const body = await rewind(opened, run.contextId, 'alice-key', {
        fromMessageId: before[1],
      });

      expect(body.error).toBeUndefined();
      expect(body.result).toEqual({ removed: before.slice(1), forgotten: [] });
      expect(await rowIds(opened, run.contextId)).toEqual([first]);
      const read = await opened.bureau.contexts.get(run.contextId);
      expect(Object.keys(read?.conversationHistory.messages ?? {})).toEqual([first]);
    });
  });

  it('keeps the removed rows out of the thread a run started afterwards ends with', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      const before = await rowIds(opened, run.contextId);
      await rewind(opened, run.contextId, 'alice-key', { fromMessageId: before[0] });

      const again = await opened.bureau.tasks.start('agent', 'go again', {
        principal: OWNER.alice,
        contextId: run.contextId,
      });
      await waitForTaskState(opened.bureau, again.id);

      const after = await rowIds(opened, run.contextId);
      expect(after.length).toBeGreaterThan(1);
      for (const id of before) expect(after).not.toContain(id);
    });
  });

  it('forgets the "Allow for the rest of this chat" grant of each tool named, whatever its version, and keeps the others', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      await opened.bureau.internals.sessionStore!.update(run.contextId, (session) =>
        session === undefined
          ? undefined
          : {
              ...session,
              metadata: {
                ...session.metadata,
                approvalGrants: ['shop:issue_refund@3', 'issue_refund', 'shop:lookup_order@1'],
              },
            },
      );
      const ids = await rowIds(opened, run.contextId);

      const body = await rewind(opened, run.contextId, 'alice-key', {
        fromMessageId: ids[1],
        forgetGrantsFor: ['issue_refund'],
      });

      expect(body.result?.['forgotten']).toEqual(['shop:issue_refund@3', 'issue_refund']);
      const session = await opened.bureau.contexts.get(run.contextId);
      expect(session?.metadata['approvalGrants']).toEqual(['shop:lookup_order@1']);
    });
  });

  it('drops the grants entry when every grant is forgotten, and changes none when no tool is named', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      await opened.bureau.internals.sessionStore!.update(run.contextId, (session) =>
        session === undefined
          ? undefined
          : { ...session, metadata: { ...session.metadata, approvalGrants: ['issue_refund'] } },
      );
      const ids = await rowIds(opened, run.contextId);

      await rewind(opened, run.contextId, 'alice-key', { fromMessageId: ids[1] });
      const unchanged = await opened.bureau.contexts.get(run.contextId);
      expect(unchanged?.metadata['approvalGrants']).toEqual(['issue_refund']);
      await rewind(opened, run.contextId, 'alice-key', {
        fromMessageId: ids[0],
        forgetGrantsFor: ['issue_refund'],
      });
      const emptied = await opened.bureau.contexts.get(run.contextId);
      expect(emptied?.metadata['approvalGrants']).toBeUndefined();
    });
  });

  it('answers a row the context does not hold as a missing message, and changes nothing', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      const before = await rowIds(opened, run.contextId);

      const body = await rewind(opened, run.contextId, 'alice-key', {
        fromMessageId: 'no-such-row',
      });

      expect(body.error?.data).toMatchObject({ httpStatus: 404, resource: 'message' });
      expect(await rowIds(opened, run.contextId)).toEqual(before);
    });
  });

  it('refuses a context a run is going on, and changes nothing', async () => {
    await withBureau(async (opened) => {
      const run = await opened.bureau.tasks.start('default', 'work', { principal: OWNER.alice });
      await waitForCondition(
        () => opened.bureau.tasks.detail(run.id)?.status === 'running',
        'run started',
      );
      const before = await rowIds(opened, run.contextId);

      const body = await rewind(opened, run.contextId, 'alice-key', { fromMessageId: before[0] });

      expect(body.error?.data).toMatchObject({ httpStatus: 409, reason: 'run-in-progress' });
      expect(await rowIds(opened, run.contextId)).toEqual(before);
    });
  });

  it('answers another owner’s context exactly as a missing one', async () => {
    await withBureau(async (opened) => {
      const run = await finishedSession(opened);
      const ids = await rowIds(opened, run.contextId);

      const stranger = await rewind(opened, run.contextId, 'bob-key', { fromMessageId: ids[1] });
      const missing = await rewind(opened, 'no-such-context', 'bob-key', { fromMessageId: ids[1] });

      expect(stranger.error?.data?.httpStatus).toBe(404);
      expect(JSON.stringify(stranger).replaceAll(run.contextId, '<id>')).toBe(
        JSON.stringify(missing).replaceAll('no-such-context', '<id>'),
      );
      expect(await rowIds(opened, run.contextId)).toEqual(ids);
    });
  });
});
