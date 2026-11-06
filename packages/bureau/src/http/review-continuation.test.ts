/**
 * COR-2016 — a decision through `bureau.reviews.resolve` (the Reviews page, the CLI and MCP)
 * continues a chat the way the chat's own AG-UI resume does: once no tool approval of a chat-origin
 * run is still pending, the run that answers the decisions starts, once, under the decided run's
 * command id (`review-continuation.ts`).
 *
 * What each case is measured against on `main`: there, the operation resolved the review and wrote
 * its outcome but started nothing, so the chat sat settled until the person sent a message.
 *
 * - One review: the decision starts the continuation, which is the chat's, and the operation says
 *   which run it is.
 * - Several reviews, in either order: only the decision that settles the last one starts it.
 * - A deny: the refusal is the outcome the continuation answers, so it continues too.
 * - A decision racing the chat's own resume: whichever path decides last starts the same run, so
 *   one continuation runs whether Reviews or the chat decided the last review.
 * - A duplicate resolve: the review is no longer pending, so the repeat is refused and starts
 *   nothing.
 * - A restart between the decision and the continuation: nothing retries the start (a residual, as
 *   for the resume's own `CONTINUATION_NOT_STARTED`); the decision and its outcome survive, a repeat
 *   still starts nothing, and the next message continues the chat from them.
 */
import { EventType } from '@ag-ui/core';
import { createToolbox, createTool } from 'armorer';
import type { Toolbox } from '@lostgradient/operative';
import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { listHeldTasks, waitForTaskState } from '../test';
import {
  as,
  authentication,
  type Handler,
  type Harness,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import { readAgUiStream } from './ag-ui-stream.test-support.ts';
import { reviewContinuationCommandId } from './review-continuation.ts';

const SECRET = 'review-continuation-secret';

function chargeCardTool(charges: number[]) {
  return createTool({
    name: 'charge-card',
    version: '1.0.0',
    description: 'Charge a payment card',
    input: z.object({ cents: z.number() }),
    async execute({ cents }) {
      charges.push(cents);
      return { charged: cents };
    },
  });
}

/** Every call needs approval, and an approved one runs. */
function approvalToolbox(charges: number[]): Toolbox {
  return createToolbox([chargeCardTool(charges)], {
    approvalSecret: SECRET,
    policy: {
      beforeExecute: () => ({
        allow: false as const,
        status: 'needs_approval' as const,
        reason: 'Operator approval required',
        action: { message: 'Approve charge' },
      }),
    },
  }) as unknown as Toolbox;
}

/** The policy changes its mind on each evaluation, so approving a call gates it again. */
function regatingToolbox(charges: number[]): Toolbox {
  let evaluations = 0;
  return createToolbox([chargeCardTool(charges)], {
    approvalSecret: SECRET,
    policy: {
      beforeExecute: () => ({
        allow: false as const,
        status: 'needs_approval' as const,
        reason: `Operator approval required (evaluation ${(evaluations += 1)})`,
        action: { message: 'Approve charge' },
      }),
    },
  }) as unknown as Toolbox;
}

const chargeOnce = {
  kind: 'respond' as const,
  response: {
    content: 'Charging.',
    toolCalls: [{ id: 'call-1', name: 'charge-card', arguments: { cents: 500 } }],
  },
};
const chargeTwice = {
  kind: 'respond' as const,
  response: {
    content: 'Charging both.',
    toolCalls: [
      { id: 'call-1', name: 'charge-card', arguments: { cents: 500 } },
      { id: 'call-2', name: 'charge-card', arguments: { cents: 700 } },
    ],
  },
};
const say = (content: string) => ({
  kind: 'respond' as const,
  response: { content, toolCalls: [] },
});

type ResolveReply = {
  result?: {
    receipt: string;
    continuation?: { status: 'started'; runId: string } | { status: 'not-started'; reason: string };
  };
  error?: { code: number; data?: { httpStatus?: number } };
};

/** `bureau.reviews.resolve` over the harness's own handler, as the Reviews page, CLI and MCP call it. */
async function resolveThroughOperation(
  handler: Handler,
  params: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<ResolveReply> {
  const response = await handler(
    new Request('http://localhost/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bureau.reviews.resolve', params }),
    }),
  );
  return (await response.json()) as ResolveReply;
}

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

/** Starts a chat run that ends waiting on approvals, and returns the waiting reviews' ids, call order. */
async function chatWaitingOnApprovals(
  harness: Harness,
  headers: Record<string, string> = {},
): Promise<string[]> {
  const frames = await readAgUiStream(
    await harness.handler(startRequest(runAgentInput(), headers)),
  );
  const finished = frames.at(-1)!.event as {
    outcome: { type: string; interrupts: Array<{ id: string }> };
  };
  expect(finished.outcome.type).toBe('interrupt');
  return finished.outcome.interrupts.map((interrupt) => interrupt.id);
}

/** The last row of the chat's conversation. */
async function lastRow(harness: Harness) {
  const rows = await transcript(harness);
  return rows.at(-1);
}

/** The chat's conversation as role and text, the rows a person reads. */
async function transcript(harness: Harness, threadId = 'thread-1') {
  const session = await harness.bureau.contexts.get(threadId);
  const history = session?.conversationHistory;
  return (history?.ids ?? []).map((id) => {
    const row = history!.messages[id]!;
    return {
      role: row.role,
      content: row.content,
      outcome: row.toolResult?.outcome,
      result: row.toolResult?.content,
    };
  });
}

describe('a decision through bureau.reviews.resolve continues the chat (COR-2016)', () => {
  it('starts the continuation when it decides the run’s one review, and says which run it is', async () => {
    const charges: number[] = [];
    await withHarness(
      { script: [chargeOnce, say('Charged.')], toolbox: approvalToolbox(charges) },
      async (harness) => {
        const [reviewId] = await chatWaitingOnApprovals(harness);
        const runId = harness.bureau.reviews.list()[0]!.runId;

        const reply = await resolveThroughOperation(harness.handler, {
          id: reviewId,
          decision: 'approve',
        });

        expect(reply.result?.receipt).toBe('applied');
        expect(reply.result?.continuation?.status).toBe('started');
        const continuation =
          reply.result?.continuation?.status === 'started' ? reply.result.continuation.runId : '';
        await waitForTaskState(harness.bureau, continuation);
        expect(charges).toEqual([500]);
        expect(listHeldTasks(harness.bureau)).toHaveLength(2);
        // The continuation is the chat's own, under the decided run's command id.
        const task = await harness.bureau.tasks.get(continuation);
        expect(task?.origin).toMatchObject({ kind: 'chat', contextId: 'thread-1' });
        expect(task?.contextId).toBe('thread-1');
        const receipt = await harness.bureau.tasks.receipt({
          principal: 'anonymous:local',
          agentName: 'assistant',
          commandId: reviewContinuationCommandId('thread-1', runId),
        });
        expect(receipt).toMatchObject({ status: 'recorded' });
        expect(await lastRow(harness)).toMatchObject({
          role: 'assistant',
          content: 'Charged.',
        });
      },
    );
  });

  for (const order of [
    ['call-1', 'call-2'],
    ['call-2', 'call-1'],
  ] as const) {
    it(`starts it only once the last of several reviews is decided (${order.join(' then ')})`, async () => {
      const charges: number[] = [];
      await withHarness(
        { script: [chargeTwice, say('Both charged.')], toolbox: approvalToolbox(charges) },
        async (harness) => {
          await chatWaitingOnApprovals(harness);
          const byCall = new Map(
            harness.bureau.reviews
              .list()
              .flatMap((review) =>
                review.kind === 'tool-approval' ? [[review.approval.callId, review.id]] : [],
              ),
          );

          const first = await resolveThroughOperation(harness.handler, {
            id: byCall.get(order[0]),
            decision: 'approve',
          });
          expect(first.result?.receipt).toBe('applied');
          // Another review of the run is still pending: nothing continues yet.
          expect(first.result?.continuation).toBeUndefined();
          expect(listHeldTasks(harness.bureau)).toHaveLength(1);

          const second = await resolveThroughOperation(harness.handler, {
            id: byCall.get(order[1]),
            decision: 'approve',
          });
          expect(second.result?.continuation?.status).toBe('started');
          const continuation =
            second.result?.continuation?.status === 'started'
              ? second.result.continuation.runId
              : '';
          await waitForTaskState(harness.bureau, continuation);
          expect(charges.toSorted((left, right) => left - right)).toEqual([500, 700]);
          expect(listHeldTasks(harness.bureau)).toHaveLength(2);
          expect(await lastRow(harness)).toMatchObject({ content: 'Both charged.' });
        },
      );
    });
  }

  it('continues after a deny, whose note is the outcome the agent answers', async () => {
    const charges: number[] = [];
    await withHarness(
      { script: [chargeOnce, say('I have not charged it.')], toolbox: approvalToolbox(charges) },
      async (harness) => {
        const [reviewId] = await chatWaitingOnApprovals(harness);

        const reply = await resolveThroughOperation(harness.handler, {
          id: reviewId,
          decision: 'deny',
          reason: 'Check the carrier’s claim first.',
        });

        expect(reply.result?.continuation?.status).toBe('started');
        const continuation =
          reply.result?.continuation?.status === 'started' ? reply.result.continuation.runId : '';
        await waitForTaskState(harness.bureau, continuation);
        expect(charges).toEqual([]);
        const rows = await transcript(harness);
        const refused = rows.find((row) => row.role === 'tool-result');
        expect(refused?.outcome).toBe('error');
        expect(JSON.stringify(refused?.result)).toContain('Check the carrier’s claim first.');
        expect(rows.at(-1)).toMatchObject({ role: 'assistant', content: 'I have not charged it.' });
      },
    );
  });

  it('starts nothing for an approval the policy gates again: the review is pending once more', async () => {
    await withHarness(
      { script: [chargeOnce, say('Charged.')], toolbox: regatingToolbox([]) },
      async (harness) => {
        const [reviewId] = await chatWaitingOnApprovals(harness);

        const reply = await resolveThroughOperation(harness.handler, {
          id: reviewId,
          decision: 'approve',
        });

        expect(reply.result?.receipt).toBe('superseded');
        expect(reply.result?.continuation).toBeUndefined();
        expect(listHeldTasks(harness.bureau)).toHaveLength(1);
        expect(harness.bureau.reviews.list()).toHaveLength(1);
      },
    );
  });

  it('refuses a duplicate resolve, which starts no second continuation', async () => {
    await withHarness(
      { script: [chargeOnce, say('Charged.')], toolbox: approvalToolbox([]) },
      async (harness) => {
        const [reviewId] = await chatWaitingOnApprovals(harness);
        const first = await resolveThroughOperation(harness.handler, {
          id: reviewId,
          decision: 'approve',
        });
        const continuation =
          first.result?.continuation?.status === 'started' ? first.result.continuation.runId : '';
        await waitForTaskState(harness.bureau, continuation);

        const again = await resolveThroughOperation(harness.handler, {
          id: reviewId,
          decision: 'approve',
        });

        expect(again.error?.data?.httpStatus).toBe(404);
        expect(listHeldTasks(harness.bureau)).toHaveLength(2);
      },
    );
  });

  it('continues a chat its owner holds, whoever decides: an operator’s decision runs as the owner', async () => {
    await withHarness(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox([]),
        authentication,
      },
      async (harness) => {
        const [reviewId] = await chatWaitingOnApprovals(harness, as('alice-key'));

        const reply = await resolveThroughOperation(
          harness.handler,
          { id: reviewId, decision: 'approve' },
          as('operator-key'),
        );

        expect(reply.result?.continuation?.status).toBe('started');
        const continuation =
          reply.result?.continuation?.status === 'started' ? reply.result.continuation.runId : '';
        await waitForTaskState(harness.bureau, continuation);
        const task = await harness.bureau.tasks.get(continuation);
        const original = await harness.bureau.tasks.get(listHeldTasks(harness.bureau)[0]!.id);
        expect(task?.owner).toBe(original?.owner);
        expect(task?.owner).not.toContain('operator');
      },
    );
  });

  it('continues nothing for a run that is not a chat’s', async () => {
    await withHarness(
      { script: [chargeOnce, say('Charged.')], toolbox: approvalToolbox([]) },
      async (harness) => {
        const started = await harness.bureau.tasks.start('assistant', 'hello', {
          principal: 'anonymous:local',
        });
        await waitForTaskState(harness.bureau, started.id);
        const reviewId = harness.bureau.reviews.list()[0]!.id;

        const reply = await resolveThroughOperation(harness.handler, {
          id: reviewId,
          decision: 'approve',
        });

        expect(reply.result?.receipt).toBe('applied');
        expect(reply.result?.continuation).toBeUndefined();
        expect(listHeldTasks(harness.bureau)).toHaveLength(1);
      },
    );
  });
});

describe('a decision through bureau.reviews.resolve racing the chat’s own resume', () => {
  it('starts one continuation when Reviews decides the review the resume was about to', async () => {
    const charges: number[] = [];
    await withHarness(
      { script: [chargeOnce, say('Charged.')], toolbox: approvalToolbox(charges) },
      async (harness) => {
        const [reviewId] = await chatWaitingOnApprovals(harness);
        // Reviews decides first; the chat's resume of the same review comes after.
        const reply = await resolveThroughOperation(harness.handler, {
          id: reviewId,
          decision: 'approve',
        });
        const continuation =
          reply.result?.continuation?.status === 'started' ? reply.result.continuation.runId : '';

        const resumed = await readAgUiStream(
          await harness.handler(
            startRequest(
              runAgentInput({
                runId: 'client-run-2',
                messages: [],
                resume: [
                  {
                    interruptId: reviewId!,
                    status: 'resolved',
                    payload: { decision: 'approve' },
                  },
                ],
              }),
            ),
          ),
        );

        // The resume answers what is no longer pending, so it applies nothing and starts nothing.
        expect(resumed.at(-1)!.event).toMatchObject({ type: EventType.RUN_ERROR });
        await waitForTaskState(harness.bureau, continuation);
        expect(charges).toEqual([500]);
        expect(listHeldTasks(harness.bureau)).toHaveLength(2);
      },
    );
  });

  it('starts one continuation when each decides one of the run’s reviews, at once', async () => {
    const charges: number[] = [];
    await withHarness(
      { script: [chargeTwice, say('Both charged.')], toolbox: approvalToolbox(charges) },
      async (harness) => {
        const interruptIds = await chatWaitingOnApprovals(harness);
        const byCall = new Map(
          harness.bureau.reviews
            .list()
            .flatMap((review) =>
              review.kind === 'tool-approval' ? [[review.approval.callId, review.id]] : [],
            ),
        );
        // The resume answers both; it decides call-1, and Reviews decides call-2 while the resume
        // is about to.
        const real = harness.bureau.reviews.resolve.bind(harness.bureau.reviews);
        let calls = 0;
        let releaseSecond: () => void = () => undefined;
        const secondHeld = new Promise<void>((resolve) => (releaseSecond = resolve));
        let reachedSecond: () => void = () => undefined;
        const secondReached = new Promise<void>((resolve) => (reachedSecond = resolve));
        spyOn(harness.bureau.reviews, 'resolve').mockImplementation(async (input) => {
          calls += 1;
          if (calls === 2) {
            reachedSecond();
            await secondHeld;
          }
          return real(input);
        });
        const ordered = interruptIds.toSorted((left, right) =>
          left === byCall.get('call-1') ? -1 : right === byCall.get('call-1') ? 1 : 0,
        );
        const resuming = harness.handler(
          startRequest(
            runAgentInput({
              runId: 'client-run-2',
              messages: [],
              resume: ordered.map((interruptId) => ({
                interruptId,
                status: 'resolved' as const,
                payload: { decision: 'approve' },
              })),
            }),
          ),
        );
        await secondReached;

        const reply = await resolveThroughOperation(harness.handler, {
          id: byCall.get('call-2'),
          decision: 'approve',
        });
        releaseSecond();
        const resumed = await readAgUiStream(await resuming);

        expect(reply.result?.continuation?.status).toBe('started');
        const continuation =
          reply.result?.continuation?.status === 'started' ? reply.result.continuation.runId : '';
        await waitForTaskState(harness.bureau, continuation);
        // The resume's continuation is the same run, under the same command id.
        expect(resumed.at(-1)!.event).toMatchObject({ type: EventType.RUN_FINISHED });
        expect(listHeldTasks(harness.bureau)).toHaveLength(2);
        expect(charges.toSorted((left, right) => left - right)).toEqual([500, 700]);
      },
    );
  });
});

describe('a restart between a decision and its continuation', () => {
  it('keeps the decision and its outcome, starts nothing on a repeat, and the next message continues the chat', async () => {
    const charges: number[] = [];
    const harness = await openHarness({
      script: [chargeOnce, say('Charged.')],
      toolbox: approvalToolbox(charges),
      storage: 'sqlite',
    });
    let current = harness;
    try {
      const [reviewId] = await chatWaitingOnApprovals(harness);
      // The decision commits, and the process dies before the operation starts the continuation:
      // the Bureau's own resolve is all that ran.
      await harness.bureau.reviews.resolve({
        id: reviewId!,
        decision: 'approve',
        principal: 'anonymous:local',
      });
      current = await harness.restart([say('Picked up from the charge.')], undefined);

      expect(current.bureau.reviews.list()).toHaveLength(0);
      const repeat = await resolveThroughOperation(current.handler, {
        id: reviewId,
        decision: 'approve',
      });
      expect(repeat.error).toBeDefined();
      expect(listHeldTasks(current.bureau)).toHaveLength(0);
      const kept = await transcript(current);
      expect(kept.find((row) => row.role === 'tool-result')?.outcome).toBe('success');

      const next = await readAgUiStream(
        await current.handler(
          startRequest(
            runAgentInput({
              runId: 'client-run-3',
              messages: [{ id: 'user-2', role: 'user', content: 'Is it done?' }],
            }),
          ),
        ),
      );

      expect(next.at(-1)!.event).toMatchObject({
        type: EventType.RUN_FINISHED,
        outcome: { type: 'success' },
      });
      expect(await lastRow(current)).toMatchObject({
        content: 'Picked up from the charge.',
      });
      expect(charges).toEqual([500]);
    } finally {
      await current.dispose();
    }
  });
});
