/**
 * COR-1828 — approving with `remember` allows the tool for the rest of the chat, and only the chat:
 * the next `on-changes` ask for that tool in that chat is skipped; another chat still asks, a tool set
 * to `always` still asks, a tool set to `blocked` is still denied, a fork starts with none, and a
 * deleted chat takes its grants along.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventType } from '@ag-ui/core';
import { MemoryStorage } from '@lostgradient/storage';
import { createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { BureauError } from './create-bureau';
import { runAgentInput, startRequest } from './http/ag-ui-fixtures.test-support';
import { readAgUiStream } from './http/ag-ui-stream.test-support';
import { createBureauHandler } from './http/create-bureau-handler';
import { RESOLVED_REVIEW_KEY_PREFIX } from './resolved-review-record';
import { agentFileDirectory } from './sources/agent-file-directory';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import type { Bureau } from './types';

const executed: string[] = [];

const issueRefund = createTool({
  name: 'issue-refund',
  version: '1.0.0',
  description: 'Refund an order',
  input: z.object({ orderId: z.string() }),
  metadata: { mutates: true, summary: 'Refund order {orderId}' },
  execute: async ({ orderId }) => {
    executed.push(`issue-refund:${orderId}`);
    return { refunded: orderId };
  },
});

const sendReceipt = createTool({
  name: 'send-receipt',
  version: '1.0.0',
  description: 'Send a receipt',
  input: z.object({ orderId: z.string() }),
  metadata: { mutates: true },
  execute: async ({ orderId }) => {
    executed.push(`send-receipt:${orderId}`);
    return { sent: orderId };
  },
});

const TOOLS = { 'issue-refund': issueRefund, 'send-receipt': sendReceipt };
const ALICE = 'api-key:alice';
const BOB = 'api-key:bob';

const roots: string[] = [];
const harnesses: FileBureauHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  executed.length = 0;
});

/** What the model asks for on its first step of a run; read when the step runs. */
const plan: { tool: string; orderId: string } = { tool: 'issue-refund', orderId: 'A1' };

async function start(toolApproval?: string, storage?: MemoryStorage): Promise<FileBureauHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'bureau-approval-grants-'));
  roots.push(directory);
  const asked = new Set<string>();
  const harness = await startFileBureau({
    directory,
    scripts: {
      [KNOWN_MODEL.split('/')[1] as string]: () => {
        // A run asks once for an order. Its second step, after the result or the refusal, answers.
        const key = `${plan.tool}:${plan.orderId}`;
        if (asked.has(key)) return 'Done.';
        asked.add(key);
        return {
          content: '',
          toolCalls: [{ name: plan.tool, arguments: { orderId: plan.orderId } }],
        };
      },
    },
    overrides: {
      id: 'grants-bureau',
      agentApprovalSecret: 'grants-secret',
      ...(storage === undefined ? {} : { storage }),
      agentSource: agentFileDirectory(directory, { tools: TOOLS }),
    },
  });
  harnesses.push(harness);
  await harness.put(
    'helper.md',
    agentFileText({
      model: KNOWN_MODEL,
      tools: '[issue-refund, send-receipt]',
      ...(toolApproval === undefined ? {} : { toolApproval }),
    }),
  );
  await harness.bureau.agents.refresh();
  return harness;
}

function pendingOf(bureau: Bureau, runId: string) {
  return bureau.reviews.list().filter((review) => review.runId === runId);
}

/** Asks for `tool` on `orderId` in a chat (a new one unless `contextId` names it) and returns the run and its chat. */
async function ask(
  bureau: Bureau,
  tool: string,
  orderId: string,
  contextId?: string,
): Promise<{ id: string; contextId: string }> {
  plan.tool = tool;
  plan.orderId = orderId;
  const task = await bureau.tasks.start('helper', 'Go.', {
    principal: ALICE,
    ...(contextId === undefined ? {} : { contextId }),
  });
  await task.result();
  return { id: task.id, contextId: task.contextId };
}

/** Approves the one tool approval a run holds, asking to remember its tool. */
async function approveRemembering(bureau: Bureau, runId: string, remember = true) {
  const [review] = pendingOf(bureau, runId);
  if (review?.kind !== 'tool-approval') throw new Error('Expected a tool approval.');
  return bureau.reviews.resolve({
    id: review.id,
    decision: 'approve',
    principal: BOB,
    ...(remember ? { remember: true } : {}),
  });
}

describe('approving with remember (COR-1828)', () => {
  it('skips the next on-changes ask for the tool in the same chat, and not in another chat', async () => {
    const { bureau } = await start();
    const first = await ask(bureau, 'issue-refund', 'A1');
    const resolved = await approveRemembering(bureau, first.id);
    expect(resolved).toMatchObject({ decision: 'approve', remembered: true, loosened: true });
    expect(executed).toEqual(['issue-refund:A1']);

    // The same chat: the same tool runs without asking.
    const again = await ask(bureau, 'issue-refund', 'A2', first.contextId);
    expect(pendingOf(bureau, again.id)).toHaveLength(0);
    expect(executed).toEqual(['issue-refund:A1', 'issue-refund:A2']);

    // Another chat has no grant, and asks.
    const elsewhere = await ask(bureau, 'issue-refund', 'A3');
    expect(pendingOf(bureau, elsewhere.id)).toHaveLength(1);
    expect(executed).toEqual(['issue-refund:A1', 'issue-refund:A2']);
  });

  it('allows only the tool that was approved', async () => {
    const { bureau } = await start();
    const first = await ask(bureau, 'issue-refund', 'A1');
    await approveRemembering(bureau, first.id);

    const other = await ask(bureau, 'send-receipt', 'A1', first.contextId);

    expect(pendingOf(bureau, other.id)).toHaveLength(1);
    expect(executed).toEqual(['issue-refund:A1']);
  });

  it('grants nothing when the approval does not ask to remember', async () => {
    const { bureau } = await start();
    const first = await ask(bureau, 'issue-refund', 'A1');
    const resolved = await approveRemembering(bureau, first.id, false);
    expect(resolved.remembered).toBeUndefined();
    expect(resolved.loosened).toBeUndefined();

    const again = await ask(bureau, 'issue-refund', 'A2', first.contextId);

    expect(pendingOf(bureau, again.id)).toHaveLength(1);
  });

  it('keeps a tool set to always asking after it was remembered', async () => {
    const { bureau } = await start('{ issue-refund: always }');
    const first = await ask(bureau, 'issue-refund', 'A1');
    const resolved = await approveRemembering(bureau, first.id);
    expect(resolved).toMatchObject({ remembered: true, loosened: false });

    const again = await ask(bureau, 'issue-refund', 'A2', first.contextId);

    expect(pendingOf(bureau, again.id)).toHaveLength(1);
    expect(executed).toEqual(['issue-refund:A1']);
  });

  it('keeps a tool that is blocked denied after it was remembered', async () => {
    const harness = await start();
    const { bureau } = harness;
    const first = await ask(bureau, 'issue-refund', 'A1');
    await approveRemembering(bureau, first.id);
    // The file changes: the tool is blocked from now on, grant or no grant.
    await harness.put(
      'helper.md',
      agentFileText({
        model: KNOWN_MODEL,
        tools: '[issue-refund, send-receipt]',
        toolApproval: '{ issue-refund: blocked }',
      }),
    );
    await bureau.agents.refresh();

    const again = await ask(bureau, 'issue-refund', 'A2', first.contextId);

    expect(pendingOf(bureau, again.id)).toHaveLength(0);
    expect(executed).toEqual(['issue-refund:A1']);
  });

  it('refuses remember on a deny, a reject, and a human wait, before anything is decided', async () => {
    const { bureau } = await start();
    const first = await ask(bureau, 'issue-refund', 'A1');
    const [review] = pendingOf(bureau, first.id);
    if (review === undefined) throw new Error('Expected a review.');

    for (const decision of ['deny', 'reject'] as const) {
      const refused = await bureau.reviews
        .resolve({ id: review.id, decision, principal: BOB, remember: true, reason: 'No.' })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(refused).toBeInstanceOf(BureauError);
      expect((refused as BureauError).code).toBe('BAD_REQUEST');
    }
    const human = await bureau.reviews
      .resolve({
        id: 'human-wait:run-1:answer:0',
        decision: 'approve',
        principal: BOB,
        remember: true,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect((human as BureauError).code).toBe('BAD_REQUEST');
    // The approval is still pending: nothing was decided.
    expect(pendingOf(bureau, first.id)).toHaveLength(1);
  });

  it('is not carried into a fork of the chat', async () => {
    const { bureau } = await start();
    const first = await ask(bureau, 'issue-refund', 'A1');
    await approveRemembering(bureau, first.id);
    const forked = await bureau.contexts.fork(first.contextId, {
      owner: ALICE,
      commandId: 'fork-grants',
      throughMessageId: null,
    });
    if (!('contextId' in forked)) throw new Error('Expected the fork to be made.');

    const forkedSession = await bureau.internals.sessionStore?.load(forked.contextId);
    expect(forkedSession?.metadata['approvalGrants']).toBeUndefined();
    const inFork = await ask(bureau, 'issue-refund', 'A2', forked.contextId);
    expect(pendingOf(bureau, inFork.id)).toHaveLength(1);
  });

  it('ends with the chat', async () => {
    const { bureau } = await start();
    const first = await ask(bureau, 'issue-refund', 'A1');
    await approveRemembering(bureau, first.id);
    const sessions = bureau.internals.sessionStore;
    const before = await sessions?.load(first.contextId);
    // The id the approval is bound to, version included (COR-1950).
    expect(before?.metadata['approvalGrants']).toEqual(['default:issue-refund@1.0.0']);

    await bureau.contexts.delete(first.contextId);

    expect(await sessions?.load(first.contextId)).toBeUndefined();
    // A chat made afterwards holds no grant.
    const fresh = await ask(bureau, 'issue-refund', 'A2');
    expect(pendingOf(bureau, fresh.id)).toHaveLength(1);
  });
});

describe('the record of a decided tool approval (COR-1828)', () => {
  it('keeps what was asked and who decided it, and nothing that could run the tool again', async () => {
    const storage = new MemoryStorage();
    const { bureau } = await start(undefined, storage);
    const first = await ask(bureau, 'issue-refund', 'A1');
    const [review] = pendingOf(bureau, first.id);
    if (review?.kind !== 'tool-approval') throw new Error('Expected a tool approval.');
    expect(review.approval.approvalToken).toBeDefined();

    await bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: BOB });

    const [record] = await bureau.reviews.listResolved();
    expect(record).toMatchObject({
      decision: 'approve',
      decidedBy: BOB,
      owner: ALICE,
      review: {
        kind: 'tool-approval',
        id: review.id,
        runId: first.id,
        status: 'approved',
        approval: { toolName: 'issue-refund', arguments: { orderId: 'A1' } },
      },
    });
    expect(record?.decidedAt).toBeGreaterThan(0);
    const decoder = new TextDecoder();
    const stored: string[] = [];
    for await (const [key, value] of storage.scan(RESOLVED_REVIEW_KEY_PREFIX)) {
      stored.push(`${key}=${decoder.decode(value)}`);
    }
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toContain(review.approval.approvalToken as string);
    expect(stored[0]).not.toContain('approvalBinding');
    expect(await bureau.reviews.get(review.id)).toMatchObject({
      status: 'approved',
      resolvedBy: BOB,
      resolvedAt: record?.decidedAt,
    });
  });
});

describe('Allow for the rest of this chat, answered on an AG-UI resume (COR-1990)', () => {
  const OWNER = 'anonymous:local';

  /** Asks for a refund in `thread-1` through AG-UI, then answers its approval with Allow. */
  async function allowThroughResume(toolApproval?: string) {
    const { bureau } = await start(toolApproval);
    const handler = createBureauHandler(bureau, {
      unauthenticatedAccess: 'allow',
      agUi: {},
    });
    plan.tool = 'issue-refund';
    plan.orderId = 'A1';
    const asked = await readAgUiStream(await handler(startRequest(runAgentInput(), {}, 'helper')));
    const interrupt = (asked.at(-1)!.event as { outcome: { interrupts: Array<{ id: string }> } })
      .outcome.interrupts[0]!;
    const resumed = await readAgUiStream(
      await handler(
        startRequest(
          runAgentInput({
            runId: 'client-run-2',
            messages: [],
            resume: [
              {
                interruptId: interrupt.id,
                status: 'resolved',
                payload: { decision: 'approve', remember: true },
                metadata: { '@lostgradient/bureau': { round: 0 } },
              },
            ],
          }),
          {},
          'helper',
        ),
      ),
    );
    const grants = resumed
      .map((frame) => frame.event)
      .filter(
        (event) => event.type === EventType.CUSTOM && event.name === 'bureau.tool-grant-settled',
      );
    /** The next refund in the same chat, asked as the chat's owner. */
    const askAgain = async (orderId: string) => {
      plan.orderId = orderId;
      const task = await bureau.tasks.start('helper', 'Go.', {
        principal: OWNER,
        contextId: 'thread-1',
      });
      await task.result();
      return task.id;
    };
    return { bureau, grants, interruptId: interrupt.id, askAgain };
  }

  it('skips the tool’s next ask in the chat and says so', async () => {
    const { bureau, grants, interruptId, askAgain } = await allowThroughResume();

    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      value: { interruptId, toolName: 'issue-refund', remembered: true, loosened: true },
    });
    expect(executed).toEqual(['issue-refund:A1']);
    expect(pendingOf(bureau, await askAgain('A2'))).toHaveLength(0);
    expect(executed).toEqual(['issue-refund:A1', 'issue-refund:A2']);
  });

  it('says the grant did not loosen a tool its agent sets to always, which still asks', async () => {
    const { bureau, grants, askAgain } = await allowThroughResume('{ issue-refund: always }');

    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ value: { remembered: true, loosened: false } });
    expect(pendingOf(bureau, await askAgain('A2'))).toHaveLength(1);
  });
});
