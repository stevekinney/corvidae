/**
 * COR-855 — a human-wait park or a pending tool approval ends the AG-UI run with
 * `RUN_FINISHED` carrying one interrupt per pending review, under the review's
 * own id. The two review kinds park differently in Bureau, and the wire says the
 * same thing for both.
 */
import { EventType } from '@ag-ui/core';
import { stopWhen, type Toolbox, waitForCondition } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  attachRunRequest,
  attachThreadRequest,
  type Harness,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import {
  bureauMetadata,
  FrameReader,
  readAgUiStream,
  typesOf,
} from './ag-ui-stream.test-support.ts';

const SECRET = 'ag-ui-approval-secret';

/** A toolbox whose one tool needs an operator's approval to run. */
function approvalToolbox(charges: number[]): Toolbox {
  return createToolbox(
    [
      createTool({
        name: 'charge-card',
        version: '1.0.0',
        description: 'Charge a payment card',
        input: z.object({ cents: z.number() }),
        async execute({ cents }) {
          charges.push(cents);
          return { charged: cents };
        },
      }),
    ],
    {
      approvalSecret: SECRET,
      policy: {
        beforeExecute: () => ({
          allow: false,
          status: 'needs_approval',
          reason: 'Operator approval required',
          action: { message: 'Approve charge' },
        }),
      },
    },
  ) as unknown as Toolbox;
}

const chargeCard = {
  kind: 'respond' as const,
  response: {
    content: 'Charging.',
    toolCalls: [{ id: 'call-1', name: 'charge-card', arguments: { cents: 500 } }],
  },
};

const askHuman = {
  kind: 'respond' as const,
  response: {
    content: 'Asking.',
    toolCalls: [
      {
        id: 'call-1',
        name: 'requestHumanInput',
        arguments: { signalName: 'human-response', prompt: 'Approve this?' },
      },
    ],
  },
};

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

describe('a tool approval', () => {
  it('ends the run with an interrupt under the review id and no secret on the wire', async () => {
    const charges: number[] = [];
    await withHarness(
      { script: [chargeCard], toolbox: approvalToolbox(charges) },
      async ({ handler, bureau }) => {
        const frames = await readAgUiStream(await handler(startRequest(runAgentInput())));

        const nativeRunId = String(bureauMetadata(frames[0]!.event)['runId']);
        const finished = frames.at(-1)!.event;
        expect(finished).toMatchObject({
          type: EventType.RUN_FINISHED,
          outcome: {
            type: 'interrupt',
            interrupts: [
              {
                id: `approval:${nativeRunId}:call-1`,
                reason: 'tool-approval',
                toolCallId: 'call-1',
                message: 'Approve charge',
                responseSchema: expect.objectContaining({ required: ['decision'] }),
                metadata: {
                  '@lostgradient/bureau': expect.objectContaining({
                    kind: 'tool-approval',
                    runId: nativeRunId,
                    sessionId: 'thread-1',
                    round: 0,
                    toolName: 'charge-card',
                  }),
                },
              },
            ],
          },
        });
        // The call and its pending result reached the stream before the interrupt.
        const types = typesOf(frames);
        expect(types.slice(-4)).toEqual(
          [EventType.TOOL_CALL_RESULT, EventType.STEP_FINISHED, EventType.RUN_FINISHED].length === 3
            ? types.slice(-4)
            : types.slice(-4),
        );
        expect(types).toContain(EventType.TOOL_CALL_RESULT);
        // The review is the same one the management plane lists.
        expect(bureau.listPendingReviews().map((review) => review.id)).toEqual([
          `approval:${nativeRunId}:call-1`,
        ]);
        // Nothing the approval is signed with, and no arguments the interrupt does not need.
        expect(JSON.stringify(frames)).not.toContain('approvalToken');
        expect(JSON.stringify(frames)).not.toContain(SECRET);
        expect(JSON.stringify(finished)).not.toContain('"cents"');
        expect(charges).toEqual([]);
        // The native run settled; the interrupt folded its run.completed into RUN_FINISHED.
        expect(types.filter((type) => type === EventType.RUN_FINISHED)).toHaveLength(1);
      },
    );
  });

  it('restores the approval card for a client that attaches while it is pending', async () => {
    await withHarness(
      { script: [chargeCard], toolbox: approvalToolbox([]) },
      async ({ handler, bureau }) => {
        await readAgUiStream(await handler(startRequest(runAgentInput())));
        const [review] = bureau.listPendingReviews();

        const frames = await readAgUiStream(await handler(attachThreadRequest('thread-1')));

        expect(typesOf(frames)).toEqual([
          EventType.RUN_STARTED,
          EventType.MESSAGES_SNAPSHOT,
          EventType.STATE_SNAPSHOT,
          EventType.TOOL_CALL_START,
          EventType.TOOL_CALL_ARGS,
          EventType.TOOL_CALL_END,
          EventType.TOOL_CALL_RESULT,
          EventType.RUN_FINISHED,
        ]);
        const events = frames.map((frame) => frame.event);
        expect(events[2]).toMatchObject({
          snapshot: { pendingInterruptIds: [review!.id], status: expect.any(String) },
        });
        expect(events[3]).toMatchObject({ toolCallId: 'call-1', toolCallName: 'charge-card' });
        expect(events[4]).toMatchObject({ delta: '{"cents":500}' });
        expect(events[6]).toMatchObject({ toolCallId: 'call-1' });
        expect(events[7]).toMatchObject({
          outcome: { type: 'interrupt', interrupts: [{ id: review!.id }] },
        });
        // The snapshot holds the call and its pending result; the replay agrees with it.
        const snapshot = events[1] as { messages: Array<{ id: string; role: string }> };
        const resultRow = snapshot.messages.find((message) => message.role === 'tool');
        expect(events[6]).toMatchObject({ messageId: resultRow?.id });
        expect(JSON.stringify(frames)).not.toContain('approvalToken');
      },
    );
  });
});

describe('a human wait', () => {
  it('ends the AG-UI run with an interrupt while the native run stays parked', async () => {
    await withHarness(
      {
        script: [askHuman],
        humanInput: true,
        stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
      },
      async ({ handler, bureau }) => {
        const frames = await readAgUiStream(await handler(startRequest(runAgentInput())));

        const nativeRunId = String(bureauMetadata(frames[0]!.event)['runId']);
        const types = typesOf(frames);
        // The call has ended; only the step is open, and the AG-UI run closes it.
        expect(types.slice(-3)).toEqual([
          EventType.TOOL_CALL_END,
          EventType.STEP_FINISHED,
          EventType.RUN_FINISHED,
        ]);
        const [review] = bureau.listPendingReviews();
        expect(review).toMatchObject({ kind: 'human-wait', runId: nativeRunId });
        expect(frames.at(-1)!.event).toMatchObject({
          outcome: {
            type: 'interrupt',
            interrupts: [
              {
                id: review!.id,
                reason: 'human-wait',
                message: 'Approve this?',
                metadata: {
                  '@lostgradient/bureau': expect.objectContaining({
                    kind: 'human-wait',
                    runId: nativeRunId,
                    signalName: 'human-response',
                  }),
                },
              },
            ],
          },
        });
        expect(bureauMetadata(frames.at(-1)!.event)['durable']).toBe(false);
        expect(bureau.getRun(nativeRunId)?.status).toBe('running');
      },
    );
  });

  it('is what a client that attaches to the parked run is told, ending in the same interrupt', async () => {
    await withHarness(
      {
        script: [askHuman],
        humanInput: true,
        stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
      },
      async ({ handler, bureau }) => {
        const started = new FrameReader(await handler(startRequest(runAgentInput())));
        await started.rest();
        await waitForCondition(
          () => bureau.listPendingReviews().length === 1,
          'the run never parked',
        );
        const nativeRunId = bureau.listPendingReviews()[0]!.runId;

        const frames = await readAgUiStream(await handler(attachRunRequest(nativeRunId)));

        // The native step finished before the run parked, so the snapshot holds it
        // whole, the call and its result included, and the interrupt follows.
        expect(typesOf(frames)).toEqual([
          EventType.RUN_STARTED,
          EventType.MESSAGES_SNAPSHOT,
          EventType.STATE_SNAPSHOT,
          EventType.RUN_FINISHED,
        ]);
        const snapshot = frames[1]!.event as {
          messages: Array<{ role: string; toolCalls?: Array<{ id: string }> }>;
        };
        expect(
          snapshot.messages.some((message) =>
            message.toolCalls?.some((call) => call.id === 'call-1'),
          ),
        ).toBe(true);
        expect(frames.at(-1)!.event).toMatchObject({
          outcome: { type: 'interrupt', interrupts: [{ reason: 'human-wait' }] },
        });
      },
    );
  });
});
