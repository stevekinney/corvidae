/**
 * COR-855 — the routes of the AG-UI mount, driven in process: every request is a
 * fetch against the handler, every run is scripted (no model), and every event
 * read back is parsed with `@ag-ui/core`'s own schema.
 */
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { stopWhen, type Toolbox, waitForCondition } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { DEFAULT_AG_UI_LEASE_MS } from './ag-ui-lease.ts';
import {
  attachRunRequest,
  attachThreadRequest,
  authentication,
  as,
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

/** Whether two events are the same once each one's own requested id is replaced and the clock reading dropped. */
function sameOnceSubstituted(
  left: unknown,
  leftId: string,
  right: unknown,
  rightId: string,
): boolean {
  const normalize = (event: unknown, id: string): string =>
    JSON.stringify(event)
      .replaceAll(id, '<id>')
      .replace(/"timestamp":\d+/, '"timestamp":0');
  return normalize(left, leftId) === normalize(right, rightId);
}

const callTool = (id = 'call-1') => ({
  kind: 'respond' as const,
  response: {
    content: 'Looking it up.',
    toolCalls: [{ id, name: 'lookup', arguments: { q: 'x' } }],
  },
});
const say = (content: string) => ({
  kind: 'respond' as const,
  response: { content, toolCalls: [] },
});

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

describe('start', () => {
  it('streams a run from RUN_STARTED to RUN_FINISHED under the ids the client and the session chose', async () => {
    await withHarness({ script: [say('Hello there.')] }, async ({ handler }) => {
      const response = await handler(startRequest(runAgentInput()));

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const frames = await readAgUiStream(response);
      expect(typesOf(frames)).toEqual([
        EventType.RUN_STARTED,
        EventType.STATE_SNAPSHOT,
        EventType.STEP_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.STEP_FINISHED,
        EventType.RUN_FINISHED,
      ]);
      const [started, , , start, content, , , finished] = frames.map((frame) => frame.event);
      expect(started).toMatchObject({ threadId: 'thread-1', runId: 'client-run-1' });
      const nativeRunId = String(bureauMetadata(started!)['runId']);
      expect(nativeRunId).not.toBe('client-run-1');
      expect(bureauMetadata(started!)['sessionId']).toBe('thread-1');
      expect(start).toMatchObject({ messageId: `${nativeRunId}:step:0`, role: 'assistant' });
      expect(content).toMatchObject({ delta: 'Hello there.' });
      expect(finished).toMatchObject({
        threadId: 'thread-1',
        runId: 'client-run-1',
        outcome: { type: 'success' },
        usage: [expect.any(Object)],
      });
    });
  });

  it('announces a tool call under the native call id and shows its result under the row id', async () => {
    await withHarness({ script: [callTool(), say('Found it.')] }, async ({ handler }) => {
      const frames = await readAgUiStream(await handler(startRequest(runAgentInput())));

      const events = frames.map((frame) => frame.event);
      const nativeRunId = String(bureauMetadata(events[0]!)['runId']);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: EventType.TOOL_CALL_START,
          toolCallId: 'call-1',
          toolCallName: 'lookup',
          parentMessageId: `${nativeRunId}:step:0`,
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: 'call-1',
          delta: '{"q":"x"}',
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: EventType.TOOL_CALL_RESULT,
          messageId: `${nativeRunId}:step:0:result:call-1`,
          toolCallId: 'call-1',
        }),
      );
    });
  });

  it('labels live events non-durable and the terminal event with the cursor of its history record', async () => {
    await withHarness(
      { script: [callTool(), say('Found it.')], storage: 'sqlite' },
      async ({ handler, bureau }) => {
        const frames = await readAgUiStream(await handler(startRequest(runAgentInput())));

        const liveDeltas = frames.filter(
          (candidate) =>
            candidate.event.type === EventType.TEXT_MESSAGE_CONTENT ||
            candidate.event.type === EventType.TOOL_CALL_ARGS,
        );
        expect(liveDeltas.length).toBeGreaterThan(0);
        for (const frame of liveDeltas) {
          expect(bureauMetadata(frame.event)).toMatchObject({ durable: false });
          expect(bureauMetadata(frame.event)['cursor']).toBeUndefined();
          expect(frame.id).toBeUndefined();
        }
        const finished = frames.at(-1)!;
        const nativeRunId = String(bureauMetadata(frames[0]!.event)['runId']);
        const history = await bureau.eventHistory({ kind: 'run', id: nativeRunId });
        if (!('events' in history)) throw new Error('expected a page of history');
        const record = history.events.findLast((event) => event.kind === 'run.completed');
        expect(record?.cursor).toBeString();
        expect(finished.event.type).toBe(EventType.RUN_FINISHED);
        expect(bureauMetadata(finished.event)).toMatchObject({
          durable: true,
          cursor: record?.cursor,
        });
        expect(finished.id).toBe(record?.cursor);
        // Only the events that are history records carry an SSE id.
        expect(frames.filter((frame) => frame.id !== undefined)).toHaveLength(1);
      },
    );
  });

  it('is durable without a cursor on a Bureau that keeps no history', async () => {
    await withHarness({ script: [say('Hi.')] }, async ({ handler }) => {
      const frames = await readAgUiStream(await handler(startRequest(runAgentInput())));

      const finished = frames.at(-1)!;
      expect(bureauMetadata(finished.event)).toMatchObject({ durable: true });
      expect(bureauMetadata(finished.event)['cursor']).toBeUndefined();
      expect(finished.id).toBeUndefined();
    });
  });

  it('ends the AG-UI run with RUN_ERROR, carrying the native code and no cause, when the run fails', async () => {
    await withHarness(
      { script: [{ kind: 'fail', error: new Error('provider said no') }] },
      async ({ handler }) => {
        const frames = await readAgUiStream(await handler(startRequest(runAgentInput())));

        const last = frames.at(-1)!.event;
        expect(last.type).toBe(EventType.RUN_ERROR);
        expect(JSON.stringify(last)).not.toContain('cause');
        expect(last).toMatchObject({ message: expect.stringContaining('provider said no') });
      },
    );
  });

  it('answers an exact retry with the original run, not a second one', async () => {
    await withHarness(
      { script: [say('Once.')], storage: 'sqlite' },
      async ({ handler, bureau }) => {
        const first = await readAgUiStream(await handler(startRequest(runAgentInput())));
        const retry = await readAgUiStream(await handler(startRequest(runAgentInput())));

        expect(bureau.listRuns()).toHaveLength(1);
        expect(bureauMetadata(retry[0]!.event)['runId']).toBe(
          bureauMetadata(first[0]!.event)['runId'],
        );
        expect(retry.at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
      },
    );
  });

  it('refuses a runId reused for a different request as RUN_CONFLICT', async () => {
    await withHarness({ script: [say('Once.')], storage: 'sqlite' }, async ({ handler }) => {
      await readAgUiStream(await handler(startRequest(runAgentInput())));
      const changed = runAgentInput({
        threadId: 'thread-2',
        messages: [{ id: 'user-2', role: 'user', content: 'a different request' }],
      });

      const frames = await readAgUiStream(await handler(startRequest(changed)));

      expect(frames).toHaveLength(1);
      expect(frames[0]!.event).toMatchObject({ type: EventType.RUN_ERROR, code: 'RUN_CONFLICT' });
    });
  });
});

describe('a start that races another on the same thread', () => {
  it.each([
    ['a thread that does not exist yet', false],
    ['a thread whose last run has finished', true],
  ])('admits exactly one of two concurrent starts on %s', async (_name, existing) => {
    await withHarness(
      { script: [say('First.'), { kind: 'block', barrier: 'hold' }, say('Second.')] },
      async ({ handler, bureau, generate }) => {
        if (existing) await readAgUiStream(await handler(startRequest(runAgentInput())));
        const start = (runId: string, text: string) =>
          handler(
            startRequest(
              runAgentInput({
                runId,
                messages: [{ id: `user-${runId}`, role: 'user', content: text }],
              }),
            ),
          );
        const runsBefore = bureau.listRuns().length;

        const [left, right] = await Promise.all([start('race-a', 'one'), start('race-b', 'two')]);
        const leftReader = new FrameReader(left);
        const rightReader = new FrameReader(right);
        const [leftFirst, rightFirst] = await Promise.all([leftReader.next(), rightReader.next()]);
        generate.release('hold');
        await Promise.all([leftReader.rest(), rightReader.rest()]);

        const first = [leftFirst!.event, rightFirst!.event];
        const refused = first.filter((event) => event.type === EventType.RUN_ERROR);
        expect(first.filter((event) => event.type === EventType.RUN_STARTED)).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect(refused[0]).toMatchObject({ code: 'THREAD_BUSY' });
        expect(bureau.listRuns()).toHaveLength(runsBefore + 1);
      },
    );
  });
});

describe('a start that races another on the same thread in another process', () => {
  it('is admitted by exactly one of two Bureaus over one store, and the other answers THREAD_BUSY', async () => {
    await withHarness({ script: [say('First.')], storage: 'sqlite' }, async (harness) => {
      const peer = await harness.peer([say('Second.')]);
      try {
        const reached = Promise.withResolvers<void>();
        const held = Promise.withResolvers<void>();
        const createRun = harness.bureau.createRun.bind(harness.bureau);
        spyOn(harness.bureau, 'createRun').mockImplementationOnce(async (request) => {
          reached.resolve();
          await held.promise;
          return createRun(request);
        });
        const start = (handler: Harness['handler'], runId: string) =>
          handler(
            startRequest(
              runAgentInput({
                runId,
                messages: [{ id: `user-${runId}`, role: 'user', content: 'hello' }],
              }),
            ),
          );

        // The first Bureau has decided the thread is idle and not yet created its run.
        const admitted = start(harness.handler, 'run-a');
        await reached.promise;
        const refused = await readAgUiStream(await start(peer.handler, 'run-b'));
        held.resolve();
        const started = await readAgUiStream(await admitted);

        expect(refused).toHaveLength(1);
        expect(refused[0]!.event).toMatchObject({ type: EventType.RUN_ERROR, code: 'THREAD_BUSY' });
        expect(started.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(harness.bureau.listRuns()).toHaveLength(1);
        expect(peer.bureau.listRuns()).toHaveLength(0);
      } finally {
        await peer.dispose();
      }
    });
  });

  it('answers THREAD_BUSY in a Bureau that does not hold the thread’s live run, and starts nothing', async () => {
    await withHarness(
      {
        script: [{ kind: 'block', barrier: 'a-generating' }, say('A done.')],
        storage: 'sqlite',
      },
      async (harness) => {
        const peer = await harness.peer([say('B done.')]);
        try {
          const first = new FrameReader(
            await harness.handler(startRequest(runAgentInput({ runId: 'run-a' }))),
          );
          await harness.generate.reached('a-generating');

          const refused = await readAgUiStream(
            await peer.handler(
              startRequest(
                runAgentInput({
                  runId: 'run-b',
                  messages: [
                    { id: 'user-1', role: 'user', content: 'hello' },
                    { id: 'user-b', role: 'user', content: 'and also' },
                  ],
                }),
              ),
            ),
          );
          harness.generate.release('a-generating');
          await first.rest();

          expect(refused).toHaveLength(1);
          expect(refused[0]!.event).toMatchObject({
            type: EventType.RUN_ERROR,
            code: 'THREAD_BUSY',
          });
          expect(peer.bureau.listRuns()).toHaveLength(0);
        } finally {
          await peer.dispose();
        }
      },
    );
  });

  it('is admitted by the other Bureau once the first one’s lease has expired', async () => {
    const dead = createManualRuntimeServices();
    const living = createManualRuntimeServices();
    await withHarness(
      { script: [say('First.')], storage: 'sqlite', agUi: { runtime: dead } },
      async (harness) => {
        const peer = await harness.peer([say('Second.')], { runtime: living });
        try {
          const reached = Promise.withResolvers<void>();
          // The first Bureau claims the thread and its process dies before it creates the run.
          spyOn(harness.bureau, 'createRun').mockImplementationOnce(() => {
            reached.resolve();
            return new Promise(() => {});
          });
          void harness.handler(
            startRequest(
              runAgentInput({
                runId: 'run-a',
                messages: [{ id: 'user-a', role: 'user', content: 'hello' }],
              }),
            ),
          );
          await reached.promise;
          await living.advance(DEFAULT_AG_UI_LEASE_MS);

          const frames = await readAgUiStream(
            await peer.handler(
              startRequest(
                runAgentInput({
                  runId: 'run-b',
                  messages: [{ id: 'user-b', role: 'user', content: 'hello' }],
                }),
              ),
            ),
          );

          expect(frames.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
          expect(peer.bureau.listRuns()).toHaveLength(1);
        } finally {
          await peer.dispose();
        }
      },
    );
  });
});

describe('whether a thread is busy, decided from what the store holds', () => {
  const approvalToolbox = (): Toolbox =>
    createToolbox(
      [
        createTool({
          name: 'charge-card',
          version: '1.0.0',
          description: 'Charge a payment card',
          input: z.object({ cents: z.number() }),
          async execute({ cents }) {
            return { charged: cents };
          },
        }),
      ],
      {
        approvalSecret: 'busy-secret',
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
  const chargeOnce = {
    kind: 'respond' as const,
    response: {
      content: 'Charging.',
      toolCalls: [{ id: 'call-1', name: 'charge-card', arguments: { cents: 500 } }],
    },
  };
  const startWithMessage = (runId: string) =>
    startRequest(
      runAgentInput({
        runId,
        messages: [
          { id: 'user-1', role: 'user', content: 'hello' },
          { id: `user-${runId}`, role: 'user', content: 'and also' },
        ],
      }),
    );
  const settled = (harness: Harness) =>
    waitForCondition(
      () => harness.bureau.getRun(harness.bureau.listRuns()[0]!.id)?.status === 'completed',
      'run did not settle',
    );

  it('refuses a start in another process while the last run is settled with an approval pending', async () => {
    await withHarness(
      { script: [chargeOnce], toolbox: approvalToolbox(), storage: 'sqlite' },
      async (harness) => {
        const peer = await harness.peer([say('B done.')]);
        try {
          await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
          await settled(harness);

          const refused = await readAgUiStream(await peer.handler(startWithMessage('run-b')));

          expect(refused).toHaveLength(1);
          expect(refused[0]!.event).toMatchObject({
            type: EventType.RUN_ERROR,
            code: 'THREAD_BUSY',
          });
          expect(peer.bureau.listRuns()).toHaveLength(0);
        } finally {
          await peer.dispose();
        }
      },
    );
  });

  it('admits a start in another process once the approval was resolved through the Bureau after a restart', async () => {
    await withHarness(
      { script: [chargeOnce], toolbox: approvalToolbox(), storage: 'sqlite' },
      async (harness) => {
        await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
        await settled(harness);
        const id = harness.bureau.listPendingReviews()[0]!.id;
        const restarted = await harness.restart([say('A done.')]);
        const peer = await restarted.peer([say('B done.')]);
        try {
          await restarted.bureau.resolveReview({
            id,
            decision: 'deny',
            principal: 'anonymous:local',
            reason: 'no',
          });

          const frames = await readAgUiStream(await peer.handler(startWithMessage('run-b')));

          expect(frames.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
          expect(peer.bureau.listRuns()).toHaveLength(1);
        } finally {
          await peer.dispose();
          await restarted.dispose();
        }
      },
    );
  });

  it('admits a start in the process that held the run once another process resolved the approval', async () => {
    await withHarness(
      { script: [chargeOnce, say('A done.')], toolbox: approvalToolbox(), storage: 'sqlite' },
      async (harness) => {
        await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
        await settled(harness);
        const id = harness.bureau.listPendingReviews()[0]!.id;
        const peer = await harness.peer([say('B done.')]);
        try {
          const denied = await readAgUiStream(
            await peer.handler(
              startRequest(
                runAgentInput({
                  runId: 'run-b',
                  messages: [],
                  resume: [
                    {
                      interruptId: id,
                      status: 'resolved',
                      payload: { decision: 'deny', reason: 'no' },
                    },
                  ],
                }),
              ),
            ),
          );

          // The holder still lists the approval as pending in its own memory; the store says it is not.
          const frames = await readAgUiStream(await harness.handler(startWithMessage('run-c')));

          expect(denied.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
          expect(frames.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        } finally {
          await peer.dispose();
        }
      },
    );
  });

  it('is not held by an approval whose binding has expired, which nobody can answer', async () => {
    const later = createManualRuntimeServices({ origin: new Date().toISOString() });
    await withHarness(
      {
        script: [chargeOnce],
        toolbox: approvalToolbox(),
        storage: 'sqlite',
        // The one clock the Bureaus issue and expire the binding by and the mount reads.
        bureauRuntime: later,
      },
      async (harness) => {
        const peer = await harness.peer([say('B done.')], { runtime: later });
        try {
          await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
          await settled(harness);
          const before = await readAgUiStream(await peer.handler(startWithMessage('run-b')));
          // Far past any binding's lifetime.
          await later.advance(400 * 24 * 60 * 60 * 1000);

          const after = await readAgUiStream(await peer.handler(startWithMessage('run-c')));

          expect(before[0]!.event).toMatchObject({ code: 'THREAD_BUSY' });
          // The binding expired by the clock Bureau uses, not only by the mount's.
          expect(peer.bureau.listPendingReviews()).toEqual([]);
          expect(after.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        } finally {
          await peer.dispose();
        }
      },
    );
  });

  it('is freed by the mount’s own expiry rule when nothing has swept the expired approval away', async () => {
    const later = createManualRuntimeServices({ origin: new Date().toISOString() });
    await withHarness(
      {
        script: [chargeOnce],
        toolbox: approvalToolbox(),
        storage: 'sqlite',
        bureauRuntime: later,
        // Bureau does no expiry work of its own, so only the mount's rule can free the thread.
        durableBackgroundTasks: 'manual',
      },
      async (harness) => {
        const peer = await harness.peer([say('B done.')], { runtime: later });
        try {
          await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
          await settled(harness);
          const approvalId = harness.bureau.listPendingReviews()[0]!.id;
          const before = await readAgUiStream(await peer.handler(startWithMessage('run-b')));
          await later.advance(400 * 24 * 60 * 60 * 1000);
          const stale = await peer.bureau.getSession('thread-1');
          const overrides = stale?.metadata['pendingApprovalOverrides'] as Record<string, unknown>;
          // The expired approval is still in the session: nothing removed it.
          expect(Object.keys(overrides)).toContain(approvalId);

          const after = await readAgUiStream(await peer.handler(startWithMessage('run-c')));

          expect(before[0]!.event).toMatchObject({ code: 'THREAD_BUSY' });
          expect(after.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        } finally {
          await peer.dispose();
        }
      },
    );
  });

  it('is held by an approval that carries no binding, which never expires, until it is cancelled', async () => {
    const later = createManualRuntimeServices({ origin: new Date().toISOString() });
    // No approval secret: the approval is unsigned, so nothing binds it to a lifetime.
    const unsignedToolbox = createToolbox(
      [
        createTool({
          name: 'charge-card',
          version: '1.0.0',
          description: 'Charge a payment card',
          input: z.object({ cents: z.number() }),
          async execute({ cents }) {
            return { charged: cents };
          },
        }),
      ],
      {
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
    await withHarness(
      {
        script: [chargeOnce, say('Waiting.'), say('B done.')],
        toolbox: unsignedToolbox,
        stopWhen: stopWhen.noToolCalls(),
        storage: 'sqlite',
        agUi: { runtime: later },
      },
      async (harness) => {
        await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
        await settled(harness);
        const approvalId = harness.bureau.listPendingReviews()[0]!.id;
        const gated = await harness.bureau.getSession('thread-1');
        const overrides = gated?.metadata['pendingApprovalOverrides'] as Record<
          string,
          { approvalBinding?: unknown }
        >;
        expect(overrides[approvalId]?.approvalBinding).toBeUndefined();

        // Far past any binding's lifetime.
        await later.advance(400 * 24 * 60 * 60 * 1000);
        const held = await readAgUiStream(await harness.handler(startWithMessage('run-b')));
        const cancelled = await readAgUiStream(
          await harness.handler(
            startRequest(
              runAgentInput({
                runId: 'run-cancel',
                messages: [],
                resume: [{ interruptId: approvalId, status: 'cancelled' }],
              }),
            ),
          ),
        );
        const freed = await readAgUiStream(await harness.handler(startWithMessage('run-c')));

        expect(held[0]!.event).toMatchObject({ code: 'THREAD_BUSY' });
        expect(cancelled.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
        expect(freed.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
      },
    );
  });

  it('is decided by the last run alone, not by an approval an earlier run left unanswered', async () => {
    await withHarness(
      {
        script: [chargeOnce, say('Second run.'), say('Third run.')],
        toolbox: approvalToolbox(),
        storage: 'sqlite',
      },
      async (harness) => {
        await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
        await settled(harness);
        // Another run is started on the thread directly, past the mount, and settles.
        const second = await harness.bureau.createRun({
          sessionId: 'thread-1',
          agentName: 'assistant',
          message: 'and another thing',
          principal: 'anonymous:local',
        });
        await waitForCondition(
          () => harness.bureau.getRun(second.id)?.status === 'completed',
          'second run did not settle',
        );

        const frames = await readAgUiStream(
          await harness.handler(
            startRequest(
              runAgentInput({
                runId: 'run-c',
                messages: [
                  { id: 'user-1', role: 'user', content: 'hello' },
                  { id: 'user-3', role: 'user', content: 'once more' },
                ],
              }),
            ),
          ),
        );

        expect(frames.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
      },
    );
  });

  it('is not held by a running marker whose durable run has settled', async () => {
    await withHarness({ script: [say('A done.')], storage: 'sqlite' }, async (harness) => {
      const peer = await harness.peer([say('B done.')]);
      try {
        await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
        await settled(harness);
        // What a crash between the run's end and its session save leaves.
        const store = harness.bureau.sessionStore!;
        await store.update('thread-1', (session) =>
          session === undefined
            ? undefined
            : { ...session, metadata: { ...session.metadata, lastRunStatus: 'running' } },
        );

        const frames = await readAgUiStream(await peer.handler(startWithMessage('run-b')));

        expect(frames.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
      } finally {
        await peer.dispose();
      }
    });
  });

  it('is busy from the moment the first start is answered, before the run’s inline launch has flushed', async () => {
    await withHarness(
      { script: [say('A done.'), say('B done.')], storage: 'sqlite' },
      async (harness) => {
        // The Response resolves once the durable record has committed. Weft reports the
        // workflow `pending` until its inline launch runs, and that is still unsettled.
        const first = await harness.handler(startRequest(runAgentInput()));
        const session = await harness.bureau.getSession('thread-1');
        const durable = await harness.bureau.getDurableRun(
          session?.metadata['lastRunId'] as string,
        );
        expect(durable?.status).toBe('pending');

        const second = await readAgUiStream(await harness.handler(startWithMessage('run-b')));

        expect(second[0]!.event).toMatchObject({ code: 'THREAD_BUSY' });
        expect(harness.bureau.listRuns()).toHaveLength(1);
        await readAgUiStream(first);
      },
    );
  });

  describe('when an earlier run’s terminal save lands after a newer run started', () => {
    /** Holds the first write that would record a run as completed: run A's terminal save. */
    function holdFirstCompletedSave(harness: Harness): {
      readonly held: () => boolean;
      readonly landed: () => boolean;
      readonly release: () => void;
    } {
      const store = harness.bureau.sessionStore!;
      const update = store.update.bind(store);
      let release: (() => void) | undefined;
      let held = false;
      let landed = false;
      let armed = true;
      (store as { update: typeof store.update }).update = (async (
        sessionId: string,
        updater: Parameters<typeof store.update>[1],
        ...rest: unknown[]
      ) => {
        let isHeldWrite = false;
        if (armed) {
          const next = await updater(await store.load(sessionId));
          if (next?.metadata['lastRunStatus'] === 'completed') {
            armed = false;
            isHeldWrite = true;
            held = true;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
        }
        const result = await (update as (...args: unknown[]) => Promise<unknown>)(
          sessionId,
          updater,
          ...rest,
        );
        if (isHeldWrite) landed = true;
        return result;
      }) as typeof store.update;
      return { held: () => held, landed: () => landed, release: () => release!() };
    }
    const message = (runId: string, ids: string[]) =>
      startRequest(
        runAgentInput({
          runId,
          messages: ids.map((id) => ({ id, role: 'user' as const, content: id })),
        }),
      );

    it('keeps the newer run’s marker, so a third start is refused in the same process', async () => {
      await withHarness(
        {
          script: [
            say('A done.'),
            { kind: 'block', barrier: 'hold' },
            say('B done.'),
            say('C done.'),
          ],
          storage: 'sqlite',
        },
        async (harness) => {
          const save = holdFirstCompletedSave(harness);
          await readAgUiStream(await harness.handler(message('r1', ['user-1'])));
          await waitForCondition(save.held, 'run A’s terminal save never reached the store');
          const b = new FrameReader(await harness.handler(message('r2', ['user-1', 'user-2'])));
          await b.until(EventType.STEP_STARTED);
          await harness.generate.reached('hold');
          const [runA, runB] = harness.bureau.listRuns().map((run) => run.id);
          save.release();
          await waitForCondition(save.landed, 'run A’s terminal save never landed');
          const afterSave = await harness.bureau.getSession('thread-1');
          expect(afterSave?.metadata['lastRunId']).toBe(runB);
          // A's own leftovers are released although B holds the marker.
          const leftovers = afterSave?.metadata;
          expect(
            Object.keys((leftovers?.['lastRequestAuthorities'] ?? {}) as object),
          ).not.toContain(runA);
          expect(Object.keys((leftovers?.['steeringStartingRuns'] ?? {}) as object)).not.toContain(
            runA,
          );
          expect(runA).not.toBe(runB);

          const c = await readAgUiStream(
            await harness.handler(message('r3', ['user-1', 'user-2', 'user-3'])),
          );

          expect(c[0]!.event).toMatchObject({ code: 'THREAD_BUSY' });
          expect(harness.bureau.listRuns()).toHaveLength(2);
          harness.generate.release('hold');
          await b.rest();
        },
      );
    });

    it('keeps the newer run’s marker when that run was started by another process', async () => {
      await withHarness(
        { script: [say('A done.'), say('A unused.')], storage: 'sqlite' },
        async (harness) => {
          const peer = await harness.peer([{ kind: 'block', barrier: 'hold' }, say('B done.')]);
          try {
            const save = holdFirstCompletedSave(harness);
            await readAgUiStream(await harness.handler(message('r1', ['user-1'])));
            await waitForCondition(save.held, 'run A’s terminal save never reached the store');
            const b = new FrameReader(await peer.handler(message('r2', ['user-1', 'user-2'])));
            await b.until(EventType.STEP_STARTED);
            await peer.generate.reached('hold');
            const runB = peer.bureau.listRuns()[0]!.id;
            save.release();
            await waitForCondition(save.landed, 'run A’s terminal save never landed');
            const afterSave = await peer.bureau.getSession('thread-1');
            expect(afterSave?.metadata['lastRunId']).toBe(runB);
            expect(afterSave?.metadata['lastRunStatus']).toBe('running');

            const c = await readAgUiStream(
              await harness.handler(message('r3', ['user-1', 'user-2', 'user-3'])),
            );

            expect(c[0]!.event).toMatchObject({ code: 'THREAD_BUSY' });
            expect(harness.bureau.listRuns().length + peer.bureau.listRuns().length).toBe(2);
            peer.generate.release('hold');
            await b.rest();
          } finally {
            await peer.dispose();
          }
        },
      );
    });
  });

  it('is busy when the store cannot be read, rather than admitting a start on a guess', async () => {
    await withHarness({ script: [say('A done.'), say('B done.')] }, async (harness) => {
      await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
      const getSession = harness.bureau.getSession.bind(harness.bureau);
      // The read that checks the thread’s owner before the lease succeeds; the read under the
      // lease, which the busy decision is made from, does not.
      let reads = 0;
      spyOn(harness.bureau, 'getSession').mockImplementation(async (...args) => {
        reads += 1;
        if (reads === 2) throw new Error('store unavailable');
        return getSession(...args);
      });

      const refused = await readAgUiStream(await harness.handler(startWithMessage('run-b')));

      expect(refused[0]!.event).toMatchObject({ code: 'THREAD_BUSY' });
      expect(harness.bureau.listRuns()).toHaveLength(1);
    });
  });

  it('is busy when the durable run of the session’s last run cannot be read', async () => {
    await withHarness({ script: [say('A done.'), say('B done.')] }, async (harness) => {
      await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
      const getSession = harness.bureau.getSession.bind(harness.bureau);
      // The session says its last run is still running, so the busy decision reads the durable
      // run, and that read fails.
      spyOn(harness.bureau, 'getSession').mockImplementation(async (...args) => {
        const session = await getSession(...args);
        return session === undefined
          ? undefined
          : { ...session, metadata: { ...session.metadata, lastRunStatus: 'running' } };
      });
      spyOn(harness.bureau, 'getDurableRun').mockRejectedValue(new Error('store unavailable'));

      const refused = await readAgUiStream(await harness.handler(startWithMessage('run-b')));

      expect(refused[0]!.event).toMatchObject({ code: 'THREAD_BUSY' });
      expect(harness.bureau.listRuns()).toHaveLength(1);
    });
  });
});

describe('a start whose lease cannot be released', () => {
  it('still answers with the run it created, and says so on the console', async () => {
    await withHarness({ script: [say('Done.')], storage: 'sqlite' }, async (harness) => {
      const kv = harness.bureau.kv!;
      const write = kv.conditionalBatch.bind(kv);
      spyOn(kv, 'conditionalBatch').mockImplementation(async (conditions, operations) => {
        if (
          operations.some(
            (operation) =>
              operation.type === 'delete' && operation.key.startsWith('ag-ui-lease:v1:thread'),
          )
        ) {
          throw new Error('store unavailable');
        }
        return write(conditions, operations);
      });
      const logged = spyOn(console, 'error').mockImplementation(() => undefined);

      const frames = await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
      const logCount = logged.mock.calls.length;
      logged.mockRestore();

      expect(frames.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
      expect(harness.bureau.listRuns()).toHaveLength(1);
      expect(logCount).toBe(1);
    });
  });
});

describe('a start whose thread lease was taken over before it created its run', () => {
  it('answers THREAD_BUSY and creates nothing', async () => {
    const claimant = createManualRuntimeServices();
    const other = createManualRuntimeServices();
    await withHarness(
      { script: [say('First.')], storage: 'sqlite', agUi: { runtime: claimant } },
      async (harness) => {
        const peer = await harness.peer([say('Second.')], { runtime: other });
        try {
          const held = Promise.withResolvers<void>();
          const reached = Promise.withResolvers<void>();
          const getSession = harness.bureau.getSession.bind(harness.bureau);
          let reads = 0;
          // The start reads the session to build its rows, then again to decide whether the
          // thread is busy: held there, it has decided nothing yet.
          spyOn(harness.bureau, 'getSession').mockImplementation(async (...args) => {
            reads += 1;
            if (reads === 2) {
              reached.resolve();
              await held.promise;
            }
            return getSession(...args);
          });
          const message = (id: string) => [{ id, role: 'user' as const, content: 'hello' }];
          const slow = harness.handler(
            startRequest(runAgentInput({ runId: 'run-a', messages: message('user-a') })),
          );
          await reached.promise;
          // Its lease expires, and another process starts and finishes a run on the thread.
          await other.advance(DEFAULT_AG_UI_LEASE_MS);
          const second = await readAgUiStream(
            await peer.handler(
              startRequest(runAgentInput({ runId: 'run-b', messages: message('user-b') })),
            ),
          );
          held.resolve();
          const refused = await readAgUiStream(await slow);

          expect(second.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
          expect(refused).toHaveLength(1);
          expect(refused[0]!.event).toMatchObject({ code: 'THREAD_BUSY' });
          expect(harness.bureau.listRuns()).toHaveLength(0);
        } finally {
          await peer.dispose();
        }
      },
    );
  });
});

describe('a start that reuses the runId of another thread’s run', () => {
  it('is a conflict, not an attach to the other thread’s run', async () => {
    await withHarness({ script: [say('Once.')] }, async ({ handler, bureau }) => {
      await readAgUiStream(await handler(startRequest(runAgentInput())));

      const frames = await readAgUiStream(
        await handler(startRequest(runAgentInput({ threadId: 'thread-2', messages: [] }))),
      );

      expect(frames).toHaveLength(1);
      expect(frames[0]!.event).toMatchObject({ type: EventType.RUN_ERROR, code: 'RUN_CONFLICT' });
      expect(bureau.listRuns()).toHaveLength(1);
    });
  });
});

describe('a start retried after the Bureau restarted', () => {
  it('replays the original run: its messages and the outcome it had', async () => {
    await withHarness({ script: [say('Hello there.')], storage: 'sqlite' }, async (harness) => {
      const original = await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
      const restarted = await harness.restart([]);
      try {
        const retry = await readAgUiStream(await restarted.handler(startRequest(runAgentInput())));

        const messages = retry.find((frame) => frame.event.type === EventType.MESSAGES_SNAPSHOT)!
          .event as unknown as { messages: Array<{ role: string; content?: string }> };
        expect(messages.messages.map((message) => message.content)).toContain('Hello there.');
        expect(retry[0]!.event).toMatchObject({
          type: EventType.RUN_STARTED,
          runId: 'client-run-1',
        });
        expect(bureauMetadata(retry[0]!.event)['runId']).toBe(
          bureauMetadata(original[0]!.event)['runId'],
        );
        const finished = retry.at(-1)!;
        expect(finished.event).toMatchObject({
          type: EventType.RUN_FINISHED,
          outcome: { type: 'success' },
        });
        expect(bureauMetadata(finished.event)['durable']).toBe(true);
        expect(finished.id).toBe(original.at(-1)!.id);
        expect(finished.id).toBeString();
      } finally {
        await restarted.dispose();
      }
    });
  });

  it('replays the failure of a run that failed, not an invented success', async () => {
    await withHarness(
      { script: [{ kind: 'fail', error: new Error('provider said no') }], storage: 'sqlite' },
      async (harness) => {
        await readAgUiStream(await harness.handler(startRequest(runAgentInput())));
        const restarted = await harness.restart([]);
        try {
          const retry = await readAgUiStream(
            await restarted.handler(startRequest(runAgentInput())),
          );

          expect(retry.at(-1)!.event).toMatchObject({
            type: EventType.RUN_ERROR,
            message: expect.stringContaining('provider said no'),
          });
          expect(typesOf(retry)).not.toContain(EventType.RUN_FINISHED);
        } finally {
          await restarted.dispose();
        }
      },
    );
  });
});

describe('door refusals are one-event streams', () => {
  const refusal = async (harness: Harness, request: Request) => {
    const response = await harness.handler(request);
    expect(response.status).toBe(200);
    const frames = await readAgUiStream(response);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event.type).toBe(EventType.RUN_ERROR);
    return frames[0]!.event as { code: string; message: string };
  };

  it('answers an agent that is not published like an unknown thread', async () => {
    await withHarness({ script: [say('x')] }, async (harness) => {
      const unpublished = await refusal(
        harness,
        startRequest(runAgentInput(), {}, 'not-published'),
      );

      expect(unpublished.code).toBe('THREAD_NOT_FOUND');
    });
  });

  it.each<[string, Partial<RunAgentInput>]>([
    ['frontend tools', { tools: [{ name: 'draw', description: 'draw', parameters: {} }] }],
    ['a protocolVersion other than 1.0', { protocolVersion: '2.0' }],
    [
      'no user message to answer',
      { messages: [{ id: 'a-1', role: 'assistant' as const, content: 'x' }] },
    ],
    ['no new message at all', { messages: [] }],
  ])('refuses %s as INVALID_INPUT', async (_name, overrides) => {
    await withHarness({ script: [say('x')] }, async (harness) => {
      const event = await refusal(harness, startRequest(runAgentInput(overrides)));

      expect(event.code).toBe('INVALID_INPUT');
    });
  });

  // COR-1590: a browser resolves these out of the address that would open the thread.
  it.each(['.', '..'])(
    'refuses a start that would create the thread %s as INVALID_INPUT, and creates nothing',
    async (threadId) => {
      await withHarness({ script: [say('x')] }, async (harness) => {
        const event = await refusal(harness, startRequest(runAgentInput({ threadId })));

        expect(event.code).toBe('INVALID_INPUT');
        expect(event.message).toContain('unopenable-session-identifier');
        expect(await harness.bureau.getSession(threadId)).toBeUndefined();
      });
    },
  );

  it('still starts a thread whose id only contains dots', async () => {
    await withHarness({ script: [say('x')] }, async (harness) => {
      const frames = await readAgUiStream(
        await harness.handler(startRequest(runAgentInput({ threadId: '...' }))),
      );

      expect(typesOf(frames)).toContain(EventType.RUN_FINISHED);
    });
  });

  it('answers an attach to a run that does not exist as RUN_NOT_FOUND and to a thread as THREAD_NOT_FOUND', async () => {
    await withHarness({ script: [say('x')] }, async (harness) => {
      const missingRun = await refusal(harness, attachRunRequest('nope'));
      const missingThread = await refusal(harness, attachThreadRequest('nope'));

      expect(missingRun.code).toBe('RUN_NOT_FOUND');
      expect(missingThread.code).toBe('THREAD_NOT_FOUND');
    });
  });

  it('answers an attach to a thread whose last run finished with nothing pending as RUN_NOT_FOUND', async () => {
    await withHarness({ script: [say('Done.')] }, async (harness) => {
      await readAgUiStream(await harness.handler(startRequest(runAgentInput())));

      const event = await refusal(harness, attachThreadRequest('thread-1'));

      expect(event.code).toBe('RUN_NOT_FOUND');
    });
  });
});

describe('transport problems keep their status codes', () => {
  it('answers 406 without text/event-stream, 400 for a body that is not a RunAgentInput, 404 elsewhere', async () => {
    await withHarness({ script: [say('x')] }, async ({ handler }) => {
      const noAccept = new Request('http://localhost/ag-ui/agents/assistant/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(runAgentInput()),
      });
      const badBody = new Request('http://localhost/ag-ui/agents/assistant/run', {
        method: 'POST',
        headers: { Accept: 'text/event-stream', 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: 'only-this' }),
      });
      const elsewhere = new Request('http://localhost/ag-ui/nothing', {
        headers: { Accept: 'text/event-stream' },
      });

      const statuses: number[] = [];
      for (const request of [noAccept, badBody, elsewhere]) {
        const response = await handler(request);
        statuses.push(response.status);
      }

      expect(statuses).toEqual([406, 400, 404]);
    });
  });

  it('answers 401 to every route without credentials when authentication is required', async () => {
    await withHarness({ script: [say('x')], authentication }, async ({ handler }) => {
      for (const request of [
        startRequest(runAgentInput()),
        attachThreadRequest('thread-1'),
        attachRunRequest('run-1'),
        cancelRequest('run-1'),
      ]) {
        const response = await handler(request);
        expect(response.status).toBe(401);
      }
    });
  });
});

describe('a thread with a run in progress', () => {
  it('refuses a second start as THREAD_BUSY and creates nothing', async () => {
    await withHarness(
      { script: [{ kind: 'block', barrier: 'hold' }, say('Done.')] },
      async ({ handler, bureau, generate }) => {
        const first = new FrameReader(await handler(startRequest(runAgentInput())));
        await first.until(EventType.STEP_STARTED);
        await generate.reached('hold');
        const runsBefore = bureau.listRuns().length;

        const second = await readAgUiStream(
          await handler(
            startRequest(
              runAgentInput({
                runId: 'client-run-2',
                messages: [{ id: 'user-2', role: 'user', content: 'again' }],
              }),
            ),
          ),
        );

        expect(second).toHaveLength(1);
        expect(second[0]!.event).toMatchObject({ type: EventType.RUN_ERROR, code: 'THREAD_BUSY' });
        expect(bureau.listRuns()).toHaveLength(runsBefore);
        generate.release('hold');
        await first.rest();
      },
    );
  });
});

describe('attach', () => {
  it('opens with the conversation as a snapshot, the state, and the step in flight, then follows the run', async () => {
    await withHarness(
      { script: [callTool(), { kind: 'block', barrier: 'hold' }, say('Found it.')] },
      async ({ handler, generate }) => {
        const starter = new FrameReader(await handler(startRequest(runAgentInput())));
        await starter.until(EventType.TOOL_CALL_RESULT);
        await generate.reached('hold');
        const nativeRunId = String(bureauMetadata(starter.received[0]!.event)['runId']);

        const attached = new FrameReader(await handler(attachThreadRequest('thread-1')));
        const opening = await attached.until(EventType.STEP_STARTED);

        expect(typesOf(opening)).toEqual([
          EventType.RUN_STARTED,
          EventType.MESSAGES_SNAPSHOT,
          EventType.STATE_SNAPSHOT,
          EventType.STEP_STARTED,
        ]);
        expect(opening[0]!.event).toMatchObject({ threadId: 'thread-1', runId: nativeRunId });
        const snapshot = opening[1]!.event as { messages: Array<{ id: string; role: string }> };
        const ids = snapshot.messages.map((message) => message.id);
        // The committed step shows once, under the ids the starting stream used.
        expect(ids).toContain(`${nativeRunId}:step:0`);
        expect(ids).toContain(`${nativeRunId}:step:0:result:call-1`);
        expect(new Set(ids).size).toBe(ids.length);
        expect(opening[3]!.event).toMatchObject({ stepName: 'step-1' });

        // The attach consumed nothing: the starting stream still gets every event.
        generate.release('hold');
        const tail = await attached.rest();
        const startedTail = await starter.rest();
        expect(tail.at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
        expect(startedTail.at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
        expect(
          typesOf(tail).filter((type) => type === EventType.TEXT_MESSAGE_CONTENT),
        ).toHaveLength(1);
      },
    );
  });

  it('attaches by run id, and gives a non-owner the answer a missing run gets', async () => {
    await withHarness(
      { script: [{ kind: 'block', barrier: 'hold' }, say('Done.')], authentication },
      async ({ handler, generate }) => {
        const starter = new FrameReader(
          await handler(startRequest(runAgentInput(), as('alice-key'))),
        );
        await starter.until(EventType.STEP_STARTED);
        await generate.reached('hold');
        const nativeRunId = String(bureauMetadata(starter.received[0]!.event)['runId']);

        const owner = new FrameReader(
          await handler(attachRunRequest(nativeRunId, as('alice-key'))),
        );
        const opening = await owner.until(EventType.STATE_SNAPSHOT);
        const stranger = await readAgUiStream(
          await handler(attachRunRequest(nativeRunId, as('bob-key'))),
        );
        const random = await readAgUiStream(
          await handler(attachRunRequest('run-that-never-was', as('bob-key'))),
        );

        expect(opening[0]!.event.type).toBe(EventType.RUN_STARTED);
        expect(stranger).toHaveLength(1);
        expect(stranger[0]!.event).toMatchObject({ code: 'RUN_NOT_FOUND' });
        // The denial is the answer for a random id, once the requested id is substituted.
        expect(
          sameOnceSubstituted(
            stranger[0]!.event,
            nativeRunId,
            random[0]!.event,
            'run-that-never-was',
          ),
        ).toBe(true);
        generate.release('hold');
        await owner.rest();
        await starter.rest();
      },
    );
  });
});

describe('cancel', () => {
  it('aborts a live run for its owner and ends every open stream as cancelled', async () => {
    await withHarness(
      { script: [{ kind: 'block', barrier: 'hold' }, say('Never.')], authentication },
      async ({ handler, generate }) => {
        const starter = new FrameReader(
          await handler(startRequest(runAgentInput(), as('alice-key'))),
        );
        await starter.until(EventType.STEP_STARTED);
        await generate.reached('hold');
        const nativeRunId = String(bureauMetadata(starter.received[0]!.event)['runId']);

        const refused = await handler(cancelRequest(nativeRunId, as('bob-key')));
        const cancelled = await handler(cancelRequest(nativeRunId, as('alice-key')));
        generate.release('hold');
        const tail = await starter.rest();

        expect(refused.status).toBe(404);
        expect(await refused.json()).toMatchObject({ code: 'NotFound' });
        expect(cancelled.status).toBe(200);
        expect(await cancelled.json()).toEqual({ runId: nativeRunId, status: 'aborting' });
        expect(tail.at(-1)!.event).toMatchObject({
          type: EventType.RUN_FINISHED,
          outcome: { type: 'cancelled' },
        });
      },
    );
  });

  it('answers a run that does not exist with a NotFound fault', async () => {
    await withHarness({ script: [say('x')] }, async ({ handler }) => {
      const response = await handler(cancelRequest('run-that-never-was'));

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        code: 'NotFound',
        data: { resource: 'run', identifier: 'run-that-never-was' },
      });
    });
  });
});

describe('a client that goes away', () => {
  it('leaves the native run running', async () => {
    await withHarness(
      { script: [{ kind: 'block', barrier: 'hold' }, say('Done.')] },
      async ({ handler, bureau, generate }) => {
        const starter = new FrameReader(await handler(startRequest(runAgentInput())));
        await starter.until(EventType.STEP_STARTED);
        await generate.reached('hold');
        const runId = bureau.listRuns()[0]!.id;

        await starter.cancel();

        expect(bureau.getRun(runId)?.status).toBe('running');
        const attached = new FrameReader(await handler(attachRunRequest(runId)));
        const opening = await attached.until(EventType.STATE_SNAPSHOT);
        expect(opening[0]!.event.type).toBe(EventType.RUN_STARTED);
        generate.release('hold');
        await attached.rest();
        await waitForCondition(
          () => bureau.getRun(runId)?.status === 'completed',
          'the run never finished',
        );
      },
    );
  });
});
