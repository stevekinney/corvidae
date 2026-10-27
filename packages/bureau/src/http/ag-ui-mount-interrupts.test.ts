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
  cancelRequest,
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
import { listHeldTasks } from '../test';

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

const say = (content: string) => ({
  kind: 'respond' as const,
  response: { content, toolCalls: [] },
});

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
        expect(types).toEqual([
          EventType.RUN_STARTED,
          EventType.STATE_SNAPSHOT,
          EventType.STEP_STARTED,
          EventType.TEXT_MESSAGE_START,
          EventType.TEXT_MESSAGE_CONTENT,
          EventType.TEXT_MESSAGE_END,
          EventType.TOOL_CALL_START,
          EventType.TOOL_CALL_ARGS,
          EventType.TOOL_CALL_END,
          EventType.TOOL_CALL_RESULT,
          EventType.STEP_FINISHED,
          EventType.RUN_FINISHED,
        ]);
        expect(types).toContain(EventType.TOOL_CALL_RESULT);
        // The review is the same one the management plane lists.
        expect(bureau.reviews.list().map((review) => review.id)).toEqual([
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
        const [review] = bureau.reviews.list();

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

describe('the interrupt of a settled approval', () => {
  it('carries the same durable label and cursor on an attach as on the start stream', async () => {
    await withHarness(
      { script: [chargeCard], toolbox: approvalToolbox([]), storage: 'sqlite' },
      async ({ handler, bureau }) => {
        const started = await readAgUiStream(await handler(startRequest(runAgentInput())));
        const nativeRunId = String(bureauMetadata(started[0]!.event)['runId']);

        const attached = await readAgUiStream(await handler(attachThreadRequest('thread-1')));

        const history = await bureau.tasks.events(nativeRunId);
        if (!('events' in history)) throw new Error('expected a page of history');
        const record = history.events.findLast((event) => event.kind === 'run.completed');
        const last = attached.at(-1)!;
        expect(last.event).toMatchObject({
          type: EventType.RUN_FINISHED,
          outcome: { type: 'interrupt' },
        });
        expect(bureauMetadata(last.event)).toMatchObject({ durable: true, cursor: record?.cursor });
        expect(last.id).toBe(record?.cursor);
        expect(bureauMetadata(started.at(-1)!.event)).toMatchObject({
          durable: true,
          cursor: record?.cursor,
        });
      },
    );
  });

  it('keeps the human-wait interrupt non-durable on an attach', async () => {
    await withHarness(
      {
        script: [askHuman],
        stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        storage: 'sqlite',
      },
      async ({ handler }) => {
        await readAgUiStream(await handler(startRequest(runAgentInput())));

        const attached = await readAgUiStream(await handler(attachThreadRequest('thread-1')));

        expect(bureauMetadata(attached.at(-1)!.event)['durable']).toBe(false);
        expect(attached.at(-1)!.id).toBeUndefined();
      },
    );
  });
});

describe('an attach to a run the Bureau no longer holds', () => {
  it('reports the state it can know, with no liveness assessment', async () => {
    await withHarness(
      { script: [chargeCard], toolbox: approvalToolbox([]), storage: 'sqlite' },
      async (harness) => {
        await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
        const restarted = await harness.restart([]);
        try {
          const frames = await readAgUiStream(
            await restarted.handler(attachThreadRequest('thread-1')),
          );

          const state = frames.find((frame) => frame.event.type === EventType.STATE_SNAPSHOT)!
            .event as unknown as { snapshot: Record<string, unknown> };
          expect(state.snapshot).not.toHaveProperty('assessment');
          expect(state.snapshot).toMatchObject({
            status: 'terminal',
            pendingInterruptIds: [expect.any(String)],
          });
          expect(frames.at(-1)!.event).toMatchObject({ outcome: { type: 'interrupt' } });
        } finally {
          await restarted.dispose();
        }
      },
    );
  });
});

describe('cancelling a run that settled with an approval pending', () => {
  it('leaves the thread busy until the interrupt is answered, and answering it as cancelled frees it', async () => {
    await withHarness(
      { script: [chargeCard, say('Understood.'), say('Next.')], toolbox: approvalToolbox([]) },
      async ({ handler, bureau }) => {
        const first = await readAgUiStream(await handler(startRequest(runAgentInput())));
        const nativeRunId = String(bureauMetadata(first[0]!.event)['runId']);
        const [review] = bureau.reviews.list();
        const next = () =>
          handler(
            startRequest(
              runAgentInput({
                runId: `next-${Math.random()}`,
                messages: [{ id: `user-${Math.random()}`, role: 'user', content: 'again' }],
              }),
            ),
          );

        const cancelled = await handler(cancelRequest(nativeRunId));
        const busy = await readAgUiStream(await next());
        await readAgUiStream(
          await handler(
            startRequest(
              runAgentInput({
                runId: 'answer',
                messages: [],
                resume: [{ interruptId: review!.id, status: 'cancelled' }],
              }),
            ),
          ),
        );
        const free = await readAgUiStream(await next());

        expect(cancelled.status).toBe(200);
        expect(busy[0]!.event).toMatchObject({ code: 'THREAD_BUSY' });
        expect(free[0]!.event.type).toBe(EventType.RUN_STARTED);
      },
    );
  });
});

describe('a human wait', () => {
  it('ends the AG-UI run with an interrupt while the native run stays parked', async () => {
    await withHarness(
      {
        script: [askHuman],
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
        const [review] = bureau.reviews.list();
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
        expect(bureau.tasks.detail(nativeRunId)?.status).toBe('running');
      },
    );
  });

  it('is what a client that attaches to the parked run is told, ending in the same interrupt', async () => {
    await withHarness(
      {
        script: [askHuman],
        stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
      },
      async ({ handler, bureau }) => {
        const started = new FrameReader(await handler(startRequest(runAgentInput())));
        await started.rest();
        await waitForCondition(() => bureau.reviews.list().length === 1, 'the run never parked');
        const nativeRunId = bureau.reviews.list()[0]!.runId;

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

describe('a thread that is waiting on an answer', () => {
  const startAgain = (handler: Harness['handler']) =>
    handler(
      startRequest(
        runAgentInput({
          runId: 'client-run-2',
          messages: [{ id: 'user-2', role: 'user', content: 'and another thing' }],
        }),
      ),
    );

  it('refuses a start while the run is parked on a human wait, and creates nothing', async () => {
    await withHarness(
      {
        script: [askHuman],
        stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
      },
      async ({ handler, bureau }) => {
        await readAgUiStream(await handler(startRequest(runAgentInput())));
        const runsBefore = listHeldTasks(bureau).length;

        const frames = await readAgUiStream(await startAgain(handler));

        expect(frames).toHaveLength(1);
        expect(frames[0]!.event).toMatchObject({ type: EventType.RUN_ERROR, code: 'THREAD_BUSY' });
        expect(listHeldTasks(bureau)).toHaveLength(runsBefore);
      },
    );
  });

  it('refuses a start while a run has settled with a tool approval pending, and creates nothing', async () => {
    await withHarness(
      { script: [chargeCard], toolbox: approvalToolbox([]) },
      async ({ handler, bureau }) => {
        await readAgUiStream(await handler(startRequest(runAgentInput())));
        const runsBefore = listHeldTasks(bureau).length;

        const frames = await readAgUiStream(await startAgain(handler));

        expect(frames).toHaveLength(1);
        expect(frames[0]!.event).toMatchObject({ type: EventType.RUN_ERROR, code: 'THREAD_BUSY' });
        expect(listHeldTasks(bureau)).toHaveLength(runsBefore);
      },
    );
  });
});
