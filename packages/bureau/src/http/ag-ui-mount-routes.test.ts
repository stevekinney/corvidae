/**
 * COR-855 — the routes of the AG-UI mount, driven in process: every request is a
 * fetch against the handler, every run is scripted (no model), and every event
 * read back is parsed with `@ag-ui/core`'s own schema.
 */
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { waitForCondition } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

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
