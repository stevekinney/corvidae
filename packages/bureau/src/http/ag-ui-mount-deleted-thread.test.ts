/**
 * COR-1986 — a deleted chat stays deleted. A start sends every row of the conversation and a
 * thread id that names no session creates one, so a client still open on a deleted chat would
 * write it back, deleted messages and all. Deleting a chat writes a tombstone (the id, the owner
 * and the time, no content) under the thread's lease, and an AG-UI start or resume on that id is
 * refused with `THREAD_DELETED`, with nothing stored.
 */
import { EventType, type ResumeEntry } from '@ag-ui/core';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { stopWhen, type Toolbox } from '@lostgradient/operative';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { contextTombstoneKey, writeContextTombstone } from '../context-tombstone.ts';
import {
  as,
  authentication,
  type Harness,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import { createAgUiLeases } from './ag-ui-lease.ts';
import { bureauMetadata, readAgUiStream } from './ag-ui-stream.test-support.ts';

const THREAD = 'thread-1';

async function withHarness<T>(
  options: Parameters<typeof openHarness>[0],
  body: (harness: Harness) => Promise<T>,
): Promise<T> {
  const harness = await openHarness(options);
  try {
    return await body(harness);
  } finally {
    await harness.dispose();
  }
}

const say = (content: string) => ({
  kind: 'respond' as const,
  response: { content, toolCalls: [] },
});

const firstMessage = { id: 'user-1', role: 'user' as const, content: 'hello' };
const secondMessage = { id: 'user-2', role: 'user' as const, content: 'one more thing' };

/** Alice starts `threadId` with `messages` under `runId` and reads the stream to its end. */
async function aliceStarts(
  harness: Pick<Harness, 'handler'>,
  runId: string,
  messages: ReadonlyArray<typeof firstMessage>,
  threadId = THREAD,
  key = 'alice-key',
) {
  return readAgUiStream(
    await harness.handler(
      startRequest(runAgentInput({ threadId, runId, messages: [...messages] }), as(key)),
    ),
  );
}

/** Whether deleting `threadId` deleted a chat. */
async function deletes(harness: Pick<Harness, 'bureau'>, threadId: string): Promise<boolean> {
  const report = await harness.bureau.contexts.delete(threadId);
  return report.deleted;
}

/** What a refusal is: one frame, a `RUN_ERROR` with the code. */
function expectRefusal(frames: Awaited<ReturnType<typeof aliceStarts>>, code: string) {
  expect(frames).toHaveLength(1);
  expect(frames[0]!.event).toMatchObject({ type: EventType.RUN_ERROR, code });
}

describe('a start on a deleted chat', () => {
  it('is refused with THREAD_DELETED and stores nothing, where it used to recreate the chat with every row', async () => {
    await withHarness(
      { script: [say('First.'), say('Second.')], authentication },
      async (harness) => {
        const first = await aliceStarts(harness, 'run-1', [firstMessage]);
        expect(first.at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
        expect(await deletes(harness, THREAD)).toBe(true);

        const again = await aliceStarts(harness, 'run-2', [firstMessage, secondMessage]);

        expectRefusal(again, 'THREAD_DELETED');
        expect(again[0]!.event).toMatchObject({ message: `Thread "${THREAD}" was deleted` });
        expect(await harness.bureau.contexts.get(THREAD)).toBeUndefined();
      },
    );
  });

  it('is refused for the same id however many rows it sends, a retry of the first start included', async () => {
    await withHarness({ script: [say('First.')], authentication }, async (harness) => {
      await aliceStarts(harness, 'run-1', [firstMessage]);
      await harness.bureau.contexts.delete(THREAD);

      expectRefusal(await aliceStarts(harness, 'run-1', [firstMessage]), 'THREAD_DELETED');
      expectRefusal(
        await aliceStarts(harness, 'run-3', [firstMessage, secondMessage]),
        'THREAD_DELETED',
      );
      expect(await harness.bureau.contexts.get(THREAD)).toBeUndefined();
    });
  });

  it('does not touch a new chat under a fresh id', async () => {
    await withHarness(
      { script: [say('First.'), say('Fresh.')], authentication },
      async (harness) => {
        await aliceStarts(harness, 'run-1', [firstMessage]);
        await harness.bureau.contexts.delete(THREAD);

        const fresh = await aliceStarts(harness, 'run-9', [firstMessage], 'thread-fresh');

        expect(fresh.at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
        expect(await harness.bureau.contexts.get('thread-fresh')).toBeDefined();
      },
    );
  });

  it('is answered THREAD_NOT_FOUND for another owner, which learns nothing, and stores nothing', async () => {
    await withHarness({ script: [say('First.')], authentication }, async (harness) => {
      await aliceStarts(harness, 'run-1', [firstMessage]);
      await harness.bureau.contexts.delete(THREAD);

      const bob = await aliceStarts(harness, 'run-bob', [firstMessage], THREAD, 'bob-key');

      expectRefusal(bob, 'THREAD_NOT_FOUND');
      expect(await harness.bureau.contexts.get(THREAD)).toBeUndefined();
    });
  });

  it('is refused after a restart, because the tombstone is persisted', async () => {
    await withHarness(
      { script: [say('First.')], authentication, storage: 'sqlite' },
      async (harness) => {
        await aliceStarts(harness, 'run-1', [firstMessage]);
        await harness.bureau.contexts.delete(THREAD);

        const restarted = await harness.restart([say('Never.')]);
        try {
          expectRefusal(
            await aliceStarts(restarted, 'run-2', [firstMessage, secondMessage]),
            'THREAD_DELETED',
          );
          expect(await restarted.bureau.contexts.get(THREAD)).toBeUndefined();
        } finally {
          await restarted.dispose();
        }
      },
    );
  });
});

describe('deleting a chat', () => {
  it('writes a tombstone of exactly four fields and no content', async () => {
    await withHarness({ script: [say('A secret answer.')], authentication }, async (harness) => {
      await aliceStarts(harness, 'run-1', [firstMessage]);

      await harness.bureau.contexts.delete(THREAD);

      const stored = await harness.bureau.internals.kv!.get(contextTombstoneKey(THREAD));
      const record = JSON.parse(stored!) as Record<string, unknown>;
      expect(Object.keys(record).toSorted()).toEqual([
        'contextId',
        'deletedAt',
        'owner',
        'version',
      ]);
      expect(record).toMatchObject({ version: 1, contextId: THREAD, owner: 'api-key:alice' });
      expect(stored).not.toContain('hello');
      expect(stored).not.toContain('secret');
    });
  });

  it('writes none for an id that names no chat, and leaves a tombstone alone when it runs again', async () => {
    await withHarness({ script: [say('First.')], authentication }, async (harness) => {
      const kv = harness.bureau.internals.kv!;

      expect(await deletes(harness, 'never-existed')).toBe(false);
      expect(await kv.get(contextTombstoneKey('never-existed'))).toBeNull();

      await aliceStarts(harness, 'run-1', [firstMessage]);
      await harness.bureau.contexts.delete(THREAD);
      const written = await kv.get(contextTombstoneKey(THREAD));

      expect(await deletes(harness, THREAD)).toBe(false);
      expect(await kv.get(contextTombstoneKey(THREAD))).toBe(written);
    });
  });

  it('removes nothing when the tombstone cannot be written, and a retry finishes the delete', async () => {
    await withHarness({ script: [say('First.')], authentication }, async (harness) => {
      await aliceStarts(harness, 'run-1', [firstMessage]);
      const kv = harness.bureau.internals.kv!;
      const original = kv.conditionalBatch.bind(kv);
      const failing = spyOn(kv, 'conditionalBatch').mockImplementation(
        async (conditions, operations) => {
          if (operations.some((operation) => operation.key.startsWith('context-tombstone:'))) {
            throw new Error('the store is down');
          }
          return original(conditions, operations);
        },
      );

      expect(await rejectionOf(harness.bureau.contexts.delete(THREAD))).toMatchObject({
        message: expect.stringContaining('the store is down'),
      });

      expect(await harness.bureau.contexts.get(THREAD)).toBeDefined();
      failing.mockRestore();
      expect(await deletes(harness, THREAD)).toBe(true);
      expect(await kv.get(contextTombstoneKey(THREAD))).not.toBeNull();
    });
  });

  it('that crashed after its tombstone leaves the chat refusing starts, and a retried delete keeps the first deletedAt', async () => {
    await withHarness({ script: [say('First.')], authentication }, async (harness) => {
      await aliceStarts(harness, 'run-1', [firstMessage]);
      const kv = harness.bureau.internals.kv!;
      await writeContextTombstone(kv, {
        version: 1,
        contextId: THREAD,
        owner: 'api-key:alice',
        deletedAt: 111,
      });
      const rowsBefore = (await harness.bureau.contexts.get(THREAD))!.conversationHistory;

      expectRefusal(
        await aliceStarts(harness, 'run-2', [firstMessage, secondMessage]),
        'THREAD_DELETED',
      );
      expectRefusal(await aliceStarts(harness, 'run-1', [firstMessage]), 'THREAD_DELETED');
      expect((await harness.bureau.contexts.get(THREAD))!.conversationHistory).toEqual(rowsBefore);

      expect(await deletes(harness, THREAD)).toBe(true);
      expect(JSON.parse((await kv.get(contextTombstoneKey(THREAD)))!)).toMatchObject({
        deletedAt: 111,
      });
      expect(await harness.bureau.contexts.get(THREAD)).toBeUndefined();
    });
  });

  it('waits for the thread’s lease, so it cannot interleave with a start, and tombstones once it holds it', async () => {
    const later = createManualRuntimeServices({ origin: new Date().toISOString() });
    await withHarness(
      { script: [say('First.')], authentication, bureauRuntime: later, agUi: { runtime: later } },
      async (harness) => {
        await aliceStarts(harness, 'run-1', [firstMessage]);
        const kv = harness.bureau.internals.kv!;
        const held = await createAgUiLeases({ kv, runtime: later }).acquire('thread', THREAD);
        expect(held).toBeDefined();
        const timersBefore = later.pendingTimers().length;

        const deletion = harness.bureau.contexts.delete(THREAD);
        await waitUntil(() => later.pendingTimers().length > timersBefore, {
          message: 'the delete waits for the lease on the injected timers',
        });

        expect(await kv.get(contextTombstoneKey(THREAD))).toBeNull();
        expect(await harness.bureau.contexts.get(THREAD)).toBeDefined();

        await held!.release();
        await later.advance(100);

        const report = await deletion;
        expect(report.deleted).toBe(true);
        expect(JSON.parse((await kv.get(contextTombstoneKey(THREAD)))!)).toMatchObject({
          contextId: THREAD,
          owner: 'api-key:alice',
        });
        expect(await harness.bureau.contexts.get(THREAD)).toBeUndefined();
      },
    );
  });
});

describe('a resume on a deleted chat', () => {
  const chargeCard = createTool({
    name: 'charge-card',
    version: '1.0.0',
    description: 'Charge a payment card',
    input: z.object({ cents: z.number() }),
    async execute({ cents }) {
      return { charged: cents };
    },
  });
  const approvalToolbox = createToolbox([chargeCard], {
    approvalSecret: 'cor-1986-secret',
    policy: {
      beforeExecute: () => ({
        allow: false as const,
        status: 'needs_approval' as const,
        reason: 'Operator approval required',
        action: { message: 'Approve charge' },
      }),
    },
  }) as unknown as Toolbox;

  const charge = {
    kind: 'respond' as const,
    response: {
      content: 'Charging.',
      toolCalls: [{ id: 'call-1', name: 'charge-card', arguments: { cents: 500 } }],
    },
  };

  /** Alice's start parks on the charge's approval; the interrupt it raised. */
  async function parkedInterrupt(harness: Harness): Promise<string> {
    const parked = await aliceStarts(harness, 'run-1', [firstMessage]);
    const finished = parked.at(-1)!.event as unknown as {
      outcome: { type: string; interrupts: Array<{ id: string }> };
    };
    expect(bureauMetadata(parked[0]!.event)['runId']).toBeDefined();
    return finished.outcome.interrupts[0]!.id;
  }

  const approve = (interruptId: string): ResumeEntry => ({
    interruptId,
    status: 'resolved',
    payload: { decision: 'approve' },
  });

  const resumeAs = async (harness: Harness, key: string, entry: ResumeEntry) =>
    readAgUiStream(
      await harness.handler(
        startRequest(runAgentInput({ runId: 'run-2', messages: [], resume: [entry] }), as(key)),
      ),
    );

  it('is refused with THREAD_DELETED, and nothing is resolved', async () => {
    await withHarness(
      {
        script: [charge, say('Charged.')],
        toolbox: approvalToolbox,
        stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
        authentication,
      },
      async (harness) => {
        const interruptId = await parkedInterrupt(harness);
        await writeContextTombstone(harness.bureau.internals.kv!, {
          version: 1,
          contextId: THREAD,
          owner: 'api-key:alice',
          deletedAt: 5,
        });

        const frames = await resumeAs(harness, 'alice-key', approve(interruptId));

        expectRefusal(frames, 'THREAD_DELETED');
        expect(harness.bureau.reviews.list().some((review) => review.id === interruptId)).toBe(
          true,
        );
      },
    );
  });

  it('is refused with THREAD_DELETED after a real delete has purged its reviews, and THREAD_NOT_FOUND for another owner', async () => {
    await withHarness(
      {
        script: [charge, say('Charged.')],
        toolbox: approvalToolbox,
        stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
        authentication,
      },
      async (harness) => {
        const interruptId = await parkedInterrupt(harness);
        expect(await deletes(harness, THREAD)).toBe(true);
        // The delete took the review with it, which is what used to answer INTERRUPT_NOT_FOUND.
        expect(await harness.bureau.reviews.get(interruptId)).toBeUndefined();

        expectRefusal(await resumeAs(harness, 'alice-key', approve(interruptId)), 'THREAD_DELETED');
        expectRefusal(await resumeAs(harness, 'bob-key', approve(interruptId)), 'THREAD_NOT_FOUND');
        expect(await harness.bureau.contexts.get(THREAD)).toBeUndefined();
      },
    );
  });
});
