/**
 * COR-855 — the AG-UI mount against `@ag-ui/client` 1.0.3, the protocol's own
 * client, over a real socket (`Bun.serve({ port: 0 })`).
 *
 * `HttpAgent` drives the fixtures it can drive (start, tool, interrupt and resume,
 * error, terminal). It cannot attach to a run it did not start
 * (`connectAgent` throws), so the attach, reconnect and cancel fixtures read the
 * stream with a raw `fetch` and run the client's own pipeline over it
 * (`runHttpRequest`, `transformHttpEventStream`, `verifyEvents`), which is
 * what rejects an out-of-order stream. Every event a fixture receives is parsed
 * with `@ag-ui/core`'s `EventSchemas`, whichever way it was read (the observed
 * `fetch` of `HttpAgent`, a raw POST, or the client's pipeline); an event the
 * schema refuses fails the fixture that read it, and a transport failure of a
 * stream the fixture itself abandoned does not.
 *
 * Runs are scripted (no model). The suite is in the slow lane because the real
 * client and real sockets put several fixtures near the per-test time limit on a
 * loaded host.
 */
import {
  buildResumeArray,
  HttpAgent,
  type HttpAgentFetchFn,
  runHttpRequest,
  transformHttpEventStream,
  verifyEvents,
} from '@ag-ui/client';
import {
  type BaseEvent,
  EventType,
  type Event,
  type Message,
  type RunAgentInput,
} from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { stopWhen, type Toolbox } from '@lostgradient/operative';
import { agUiConversationAdapter } from 'conversationalist';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { AGENT, type Harness, openHarness, runAgentInput } from './ag-ui-fixtures.test-support.ts';
import {
  bureauMetadata,
  parseAgUiFrames,
  type ReceivedFrame,
} from './ag-ui-stream.test-support.ts';

// ---------------------------------------------------------------------------
// Serving, observing, and driving
// ---------------------------------------------------------------------------

type Served = { readonly base: string; stop(): void };

function serve(harness: Harness): Served {
  const server = Bun.serve({ port: 0, fetch: (request) => harness.handler(request) });
  return { base: `http://localhost:${server.port}`, stop: () => void server.stop(true) };
}

/**
 * A `fetch` for `HttpAgent` that also parses, with the pinned schema, every stream
 * it carries. A body the schema refuses fails `frames()`; a stream the fixture
 * abandoned (an aborted fetch) has no body to parse and is skipped.
 */
function observed() {
  const parsing: Promise<{ frames: ReceivedFrame[]; refused?: unknown }>[] = [];
  const fetchFn: HttpAgentFetchFn = async (url, init) => {
    const response = await fetch(url, init);
    if (response.ok && response.headers.get('content-type')?.includes('text/event-stream')) {
      parsing.push(
        response
          .clone()
          .text()
          .then(
            (body) => {
              try {
                return { frames: parseAgUiFrames(body) };
              } catch (refused) {
                return { frames: [], refused };
              }
            },
            () => ({ frames: [] }),
          ),
      );
    }
    return response;
  };
  return {
    fetch: fetchFn,
    async frames(): Promise<ReceivedFrame[]> {
      const parsed = await Promise.all(parsing);
      const refused = parsed.find((entry) => entry.refused !== undefined);
      if (refused !== undefined) throw refused.refused;
      return parsed.flatMap((entry) => entry.frames);
    },
  };
}

function agentFor(
  served: Served,
  observer: ReturnType<typeof observed>,
  options: { threadId?: string; messages?: Message[]; headers?: Record<string, string> } = {},
): HttpAgent {
  return new HttpAgent({
    url: `${served.base}/ag-ui/agents/${AGENT}/run`,
    threadId: options.threadId ?? 'thread-1',
    initialMessages: options.messages ?? [{ id: 'user-1', role: 'user', content: 'hello' }],
    fetch: observer.fetch,
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
}

/**
 * Follows a stream through the client's own pipeline, which rejects one out of
 * order. `opened` resolves when the first event has arrived, so a fixture can wait
 * for the server to have the stream open before it acts on the run.
 */
function follow(source$: {
  subscribe(observer: {
    next(event: BaseEvent): void;
    error(error: unknown): void;
    complete(): void;
  }): unknown;
}): { readonly opened: Promise<void>; readonly events: Promise<BaseEvent[]> } {
  let opened: () => void = () => {};
  const firstEvent = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const events = new Promise<BaseEvent[]>((resolve, reject) => {
    const received: BaseEvent[] = [];
    source$.subscribe({
      next: (event) => {
        // The client's pipeline has accepted the event; the pinned schema must as well.
        const parsed = EventSchemas.safeParse(event);
        if (!parsed.success) {
          reject(new Error(`Not an AG-UI event: ${parsed.error.message}`));
          return;
        }
        received.push(event);
        opened();
      },
      error: reject,
      complete: () => resolve(received),
    });
  });
  return { opened: firstEvent, events };
}

function pipeline(url: string, init: RequestInit = {}) {
  const request = runHttpRequest(() =>
    fetch(url, {
      ...init,
      headers: {
        Accept: 'text/event-stream',
        ...(init.headers as Record<string, string> | undefined),
      },
    }),
  );
  return transformHttpEventStream(request).pipe(verifyEvents());
}

async function rawPost(served: Served, input: RunAgentInput): Promise<ReceivedFrame[]> {
  const response = await fetch(`${served.base}/ag-ui/agents/${AGENT}/run`, {
    method: 'POST',
    headers: { Accept: 'text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return parseAgUiFrames(await response.text());
}

const typesOf = (events: ReadonlyArray<{ type: string }>) => events.map((event) => event.type);

/** The events of every stream an observer saw. */
async function eventsSeen(observer: ReturnType<typeof observed>): Promise<Event[]> {
  const frames = await observer.frames();
  return frames.map((frame) => frame.event);
}

/** The text of a response a fetch is still producing. */
async function textOf(pending: Promise<Response>): Promise<string> {
  const response = await pending;
  return response.text();
}

async function withServed<T>(
  options: Parameters<typeof openHarness>[0],
  body: (context: { harness: Harness; served: Served }) => Promise<T>,
): Promise<T> {
  const harness = await openHarness(options);
  const served = serve(harness);
  try {
    return await body({ harness, served });
  } finally {
    served.stop();
    await harness.dispose();
  }
}

const say = (content: string) => ({
  kind: 'respond' as const,
  response: { content, toolCalls: [] },
});
const lookupOnce = {
  kind: 'respond' as const,
  response: {
    content: 'Looking it up.',
    toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { q: 'x' } }],
  },
};
const lookupTool = createTool({
  name: 'lookup',
  description: 'look something up',
  input: z.object({ q: z.string() }),
  async execute({ q }) {
    return { found: q };
  },
});
const lookupToolbox = () => createToolbox([lookupTool]) as unknown as Toolbox;

/** A toolbox whose one tool needs an operator's approval before it runs. */
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
      approvalSecret: 'conformance-secret',
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
const chargeOnce = {
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
const humanWait = {
  stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

describe('start', () => {
  it('runs from RUN_STARTED to RUN_FINISHED, and the client’s new messages carry the ids the session holds', async () => {
    await withServed({ script: [say('Hello there.')] }, async ({ harness, served }) => {
      const observer = observed();
      const agent = agentFor(served, observer);

      const result = await agent.runAgent({ runId: 'run-a' });

      const frames = await observer.frames();
      expect(typesOf(frames.map((frame) => frame.event))).toEqual([
        EventType.RUN_STARTED,
        EventType.STATE_SNAPSHOT,
        EventType.STEP_STARTED,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_CONTENT,
        EventType.TEXT_MESSAGE_END,
        EventType.STEP_FINISHED,
        EventType.RUN_FINISHED,
      ]);
      const session = await harness.bureau.contexts.get('thread-1');
      const exported = agUiConversationAdapter.export(session!.conversationHistory);
      const sessionIds = exported.map((message) => message.id).filter((id) => id !== 'user-1');
      expect(result.newMessages.map((message) => message.id)).toEqual(sessionIds);
      expect(result.newMessages[0]).toMatchObject({ role: 'assistant', content: 'Hello there.' });
    });
  });
});

describe('tool', () => {
  it('streams the call under its native id and its result under the id of the session row', async () => {
    await withServed(
      { script: [lookupOnce, say('Found it.')], toolbox: lookupToolbox() },
      async ({ harness, served }) => {
        const observer = observed();
        const agent = agentFor(served, observer);

        const result = await agent.runAgent({ runId: 'run-a' });

        const events = await eventsSeen(observer);
        const nativeRunId = String(bureauMetadata(events[0]!)['runId']);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: EventType.TOOL_CALL_START,
            toolCallId: 'call-1',
            toolCallName: 'lookup',
          }),
        );
        const toolMessage = result.newMessages.find((message) => message.role === 'tool');
        expect(toolMessage).toMatchObject({
          id: `${nativeRunId}:step:0:result:call-1`,
          toolCallId: 'call-1',
        });
        const session = await harness.bureau.contexts.get('thread-1');
        const rowIds = session!.conversationHistory.ids;
        expect(rowIds).toContain(`${nativeRunId}:step:0:result:call-1`);
        const assistant = result.newMessages.find((message) => message.role === 'assistant');
        expect(assistant).toMatchObject({
          id: `${nativeRunId}:step:0`,
          toolCalls: [{ id: 'call-1' }],
        });
      },
    );
  });
});

describe('terminal', () => {
  it('ends with one RUN_FINISHED carrying one usage entry, and nothing after it', async () => {
    await withServed({ script: [say('Done.')] }, async ({ served }) => {
      const observer = observed();

      await agentFor(served, observer).runAgent({ runId: 'run-a' });

      const events = await eventsSeen(observer);
      const finished = events.filter((event) => event.type === EventType.RUN_FINISHED);
      expect(finished).toHaveLength(1);
      expect(events.at(-1)).toBe(finished[0]);
      expect(finished[0]).toMatchObject({ usage: [expect.any(Object)] });
      expect((finished[0] as { usage: unknown[] }).usage).toHaveLength(1);
    });
  });
});

describe('error', () => {
  it('ends a failed run with RUN_ERROR carrying the native code and message, and no cause', async () => {
    await withServed(
      { script: [{ kind: 'fail', error: new Error('provider said no') }] },
      async ({ served }) => {
        const observer = observed();
        const agent = agentFor(served, observer);

        await agent.runAgent({ runId: 'run-a' }).then(
          () => undefined,
          () => undefined,
        );

        const events = await eventsSeen(observer);
        const last = events.at(-1)!;
        expect(last).toMatchObject({
          type: EventType.RUN_ERROR,
          code: expect.any(String),
          message: expect.stringContaining('provider said no'),
        });
        expect(JSON.stringify(last)).not.toContain('cause');
      },
    );
  });

  it('answers each refusal at the door with its own code, as the first and only event', async () => {
    await withServed(
      { script: [{ kind: 'block', barrier: 'hold' }, say('Done.')], storage: 'sqlite' },
      async ({ harness, served }) => {
        const post = (overrides: Partial<RunAgentInput>) =>
          rawPost(served, runAgentInput({ threadId: 'thread-1', ...overrides }));
        const attach = async (path: string) => {
          const response = await fetch(`${served.base}/ag-ui${path}`, {
            headers: { Accept: 'text/event-stream' },
          });
          return parseAgUiFrames(await response.text());
        };
        const codes: Record<string, string | undefined> = {};
        const codeOf = (frames: ReceivedFrame[]): string | undefined =>
          (frames[0]?.event as { code?: string } | undefined)?.code;

        codes['THREAD_NOT_FOUND'] = codeOf(await attach('/threads/nope/run'));
        codes['RUN_NOT_FOUND'] = codeOf(await attach('/runs/nope'));
        codes['INVALID_INPUT'] = codeOf(await post({ protocolVersion: '2.0' }));
        codes['INTERRUPT_NOT_FOUND'] = codeOf(
          await post({
            messages: [],
            resume: [{ interruptId: 'approval:nope:call-1', status: 'cancelled' }],
          }),
        );
        // A run in progress on the thread: a second start is refused, a changed retry conflicts.
        const first = fetch(`${served.base}/ag-ui/agents/${AGENT}/run`, {
          method: 'POST',
          headers: { Accept: 'text/event-stream', 'content-type': 'application/json' },
          body: JSON.stringify(runAgentInput()),
        });
        await harness.generate.reached('hold');
        codes['THREAD_BUSY'] = codeOf(
          await post({
            runId: 'client-run-2',
            messages: [{ id: 'user-2', role: 'user', content: 'again' }],
          }),
        );
        harness.generate.release('hold');
        await textOf(first);
        codes['RUN_CONFLICT'] = codeOf(
          await post({ messages: [{ id: 'user-3', role: 'user', content: 'a changed request' }] }),
        );
        const createRun = spyOn(harness.bureau, 'createRun').mockRejectedValueOnce(
          new Error('storage fell over'),
        );
        codes['RUN_FAILED'] = codeOf(
          await post({
            threadId: 'thread-2',
            runId: 'client-run-9',
            messages: [{ id: 'user-9', role: 'user', content: 'will fail to start' }],
          }),
        );
        createRun.mockRestore();

        expect(codes).toEqual({
          THREAD_NOT_FOUND: 'THREAD_NOT_FOUND',
          RUN_NOT_FOUND: 'RUN_NOT_FOUND',
          INVALID_INPUT: 'INVALID_INPUT',
          INTERRUPT_NOT_FOUND: 'INTERRUPT_NOT_FOUND',
          THREAD_BUSY: 'THREAD_BUSY',
          RUN_CONFLICT: 'RUN_CONFLICT',
          RUN_FAILED: 'RUN_FAILED',
        });
      },
    );
  });
});

describe('attach', () => {
  it('opens with RUN_STARTED, MESSAGES_SNAPSHOT and STATE_SNAPSHOT, then follows a run it did not start, without consuming it', async () => {
    await withServed(
      {
        script: [lookupOnce, { kind: 'block', barrier: 'hold' }, say('Found it.')],
        toolbox: lookupToolbox(),
      },
      async ({ harness, served }) => {
        const starterObserver = observed();
        const starting = agentFor(served, starterObserver).runAgent({ runId: 'run-a' });
        await harness.generate.reached('hold');
        const nativeRunId = harness.bureau.listRuns()[0]!.id;

        const attaching = follow(pipeline(`${served.base}/ag-ui/threads/thread-1/run`));
        await attaching.opened;
        harness.generate.release('hold');
        const events = await attaching.events;
        const started = await starting;

        expect(typesOf(events).slice(0, 4)).toEqual([
          EventType.RUN_STARTED,
          EventType.MESSAGES_SNAPSHOT,
          EventType.STATE_SNAPSHOT,
          EventType.STEP_STARTED,
        ]);
        const snapshot = events[1] as unknown as { messages: Array<{ id: string }> };
        const ids = snapshot.messages.map((message) => message.id);
        expect(ids).toContain(`${nativeRunId}:step:0`);
        expect(ids).toContain(`${nativeRunId}:step:0:result:call-1`);
        expect(new Set(ids).size).toBe(ids.length);
        expect(events.at(-1)!.type).toBe(EventType.RUN_FINISHED);
        // The starting stream received every delta too: the attach consumed nothing.
        const startedEvents = await eventsSeen(starterObserver);
        expect(startedEvents.at(-1)!.type).toBe(EventType.RUN_FINISHED);
        expect(started.newMessages.length).toBeGreaterThan(0);
      },
    );
  });
});

describe('reconnect', () => {
  it('ends a stream at its maximum duration with STREAM_DEADLINE, and the next attach holds the committed step once', async () => {
    const runtime = createManualRuntimeServices();
    await withServed(
      {
        script: [lookupOnce, { kind: 'block', barrier: 'hold' }, say('Found it.')],
        toolbox: lookupToolbox(),
        agUi: { maxStreamDurationMs: 60_000, runtime },
      },
      async ({ harness, served }) => {
        const first = fetch(`${served.base}/ag-ui/agents/${AGENT}/run`, {
          method: 'POST',
          headers: { Accept: 'text/event-stream', 'content-type': 'application/json' },
          body: JSON.stringify(runAgentInput()),
        });
        await harness.generate.reached('hold');
        const nativeRunId = harness.bureau.listRuns()[0]!.id;

        await runtime.advance(60_000);
        const closed = parseAgUiFrames(await textOf(first));
        const second = follow(pipeline(`${served.base}/ag-ui/runs/${nativeRunId}`));
        await second.opened;
        harness.generate.release('hold');
        const events = await second.events;

        expect(closed.at(-1)!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'STREAM_DEADLINE',
        });
        expect(typesOf(closed.map((frame) => frame.event))).not.toContain(EventType.RUN_FINISHED);
        const snapshot = events[1] as unknown as { messages: Array<{ id: string }> };
        const ids = snapshot.messages.map((message) => message.id);
        expect(ids.filter((id) => id === `${nativeRunId}:step:0`)).toHaveLength(1);
        expect(ids.filter((id) => id === `${nativeRunId}:step:0:result:call-1`)).toHaveLength(1);
        expect(events.at(-1)!.type).toBe(EventType.RUN_FINISHED);
      },
    );
  });
});

describe('cancel', () => {
  it('leaves the run running when a client aborts its fetch, and ends every open stream as cancelled when the run is cancelled', async () => {
    await withServed(
      { script: [{ kind: 'block', barrier: 'hold' }, say('Never.')] },
      async ({ harness, served }) => {
        const starterObserver = observed();
        const agent = agentFor(served, starterObserver);
        const starting = agent.runAgent({ runId: 'run-a' }).then(
          () => undefined,
          () => undefined,
        );
        await harness.generate.reached('hold');
        const nativeRunId = harness.bureau.listRuns()[0]!.id;

        agent.abortRun();
        await starting;
        await starterObserver.frames();
        expect(harness.bureau.getRun(nativeRunId)?.status).toBe('running');

        const attaching = follow(pipeline(`${served.base}/ag-ui/runs/${nativeRunId}`));
        await attaching.opened;
        const cancel = await fetch(`${served.base}/ag-ui/runs/${nativeRunId}/cancel`, {
          method: 'POST',
        });
        harness.generate.release('hold');
        const events = await attaching.events;

        expect(cancel.status).toBe(200);
        expect(await cancel.json()).toEqual({ runId: nativeRunId, status: 'aborting' });
        expect(events.at(-1)).toMatchObject({
          type: EventType.RUN_FINISHED,
          outcome: { type: 'cancelled' },
        });
      },
    );
  });
});

describe('interrupt and resume', () => {
  it('resumes a tool approval on a new native run that replays the call before its executed result', async () => {
    const charges: number[] = [];
    await withServed(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        storage: 'sqlite',
      },
      async ({ served, harness }) => {
        const observer = observed();
        const agent = agentFor(served, observer);

        await agent.runAgent({ runId: 'run-a' });
        const interrupts = [...agent.pendingInterrupts];
        expect(interrupts).toHaveLength(1);
        const first = await observer.frames();
        const firstRunId = String(bureauMetadata(first[0]!.event)['runId']);

        await agent.runAgent({
          runId: 'run-b',
          resume: buildResumeArray(interrupts, {
            [interrupts[0]!.id]: { status: 'resolved', payload: { decision: 'approve' } },
          }),
        });

        const everySeen = await observer.frames();
        const second = everySeen.slice(first.length);
        const secondRunId = String(bureauMetadata(second[0]!.event)['runId']);
        expect(secondRunId).not.toBe(firstRunId);
        const types = typesOf(second.map((frame) => frame.event));
        expect(types.indexOf(EventType.TOOL_CALL_END)).toBeLessThan(
          types.indexOf(EventType.TOOL_CALL_RESULT),
        );
        const result = second.find((frame) => frame.event.type === EventType.TOOL_CALL_RESULT)!
          .event as { messageId: string };
        expect(result.messageId).toBe(`${firstRunId}:step:0:result:call-1`);
        expect(charges).toEqual([500]);
        expect(agent.pendingInterrupts).toHaveLength(0);
        expect(harness.bureau.reviews.list()).toHaveLength(0);
      },
    );
  });

  it('resumes a human wait on the same native run', async () => {
    await withServed({ script: [askHuman, say('Thanks.')], ...humanWait }, async ({ served }) => {
      const observer = observed();
      const agent = agentFor(served, observer);

      await agent.runAgent({ runId: 'run-a' });
      const interrupts = [...agent.pendingInterrupts];
      const first = await observer.frames();
      await agent.runAgent({
        runId: 'run-b',
        resume: buildResumeArray(interrupts, {
          [interrupts[0]!.id]: {
            status: 'resolved',
            payload: { decision: 'approve', answer: 'yes' },
          },
        }),
      });

      const everySeen = await observer.frames();
      const second = everySeen.slice(first.length);
      expect(bureauMetadata(second[0]!.event)['runId']).toBe(
        bureauMetadata(first[0]!.event)['runId'],
      );
      expect(second.at(-1)!.event).toMatchObject({ outcome: { type: 'success' } });
    });
  });

  it('maps cancelled to deny, and refuses a partial or unknown answer with nothing applied', async () => {
    const charges: number[] = [];
    await withServed(
      { script: [chargeOnce, say('Understood.')], toolbox: approvalToolbox(charges) },
      async ({ served, harness }) => {
        const observer = observed();
        const agent = agentFor(served, observer);
        await agent.runAgent({ runId: 'run-a' });
        const [interrupt] = agent.pendingInterrupts;

        const unknown = await rawPost(
          served,
          runAgentInput({
            runId: 'run-b',
            messages: [],
            resume: [{ interruptId: 'approval:nope:call-9', status: 'cancelled' }],
          }),
        );
        expect(unknown[0]!.event).toMatchObject({ code: 'INTERRUPT_NOT_FOUND' });
        expect(harness.bureau.reviews.list()).toHaveLength(1);

        await agent.runAgent({
          runId: 'run-c',
          resume: buildResumeArray([interrupt!], {
            [interrupt!.id]: { status: 'cancelled' },
          }),
        });
        expect(charges).toEqual([]);
        expect(harness.bureau.reviews.list()).toHaveLength(0);
        await observer.frames();
      },
    );
  });

  it('attaches, while an approval is pending, with the snapshot and the interrupt that restores its card', async () => {
    await withServed(
      { script: [chargeOnce, say('Charged.')], toolbox: approvalToolbox([]) },
      async ({ served, harness }) => {
        const observer = observed();
        await agentFor(served, observer).runAgent({ runId: 'run-a' });
        const [review] = harness.bureau.reviews.list();

        const events = await follow(pipeline(`${served.base}/ag-ui/threads/thread-1/run`)).events;
        await observer.frames();

        expect(typesOf(events)).toEqual([
          EventType.RUN_STARTED,
          EventType.MESSAGES_SNAPSHOT,
          EventType.STATE_SNAPSHOT,
          EventType.TOOL_CALL_START,
          EventType.TOOL_CALL_ARGS,
          EventType.TOOL_CALL_END,
          EventType.TOOL_CALL_RESULT,
          EventType.RUN_FINISHED,
        ]);
        expect(events.at(-1)).toMatchObject({
          outcome: { type: 'interrupt', interrupts: [{ id: review!.id }] },
        });
      },
    );
  });

  it('attaches an exact duplicate resume to the first one’s run without a second resolution', async () => {
    const charges: number[] = [];
    await withServed(
      {
        script: [chargeOnce, say('Charged.')],
        toolbox: approvalToolbox(charges),
        storage: 'sqlite',
      },
      async ({ served, harness }) => {
        const observer = observed();
        const agent = agentFor(served, observer);
        await agent.runAgent({ runId: 'run-a' });
        const [interrupt] = agent.pendingInterrupts;
        const entries = [
          {
            interruptId: interrupt!.id,
            status: 'resolved' as const,
            payload: { decision: 'approve' },
          },
        ];
        const original = await rawPost(
          served,
          runAgentInput({ runId: 'run-b', messages: [], resume: entries }),
        );
        const resolve = spyOn(harness.bureau.reviews, 'resolve');

        const retry = await rawPost(
          served,
          runAgentInput({ runId: 'run-c', messages: [], resume: entries }),
        );

        expect(resolve).not.toHaveBeenCalled();
        await observer.frames();
        expect(charges).toEqual([500]);
        expect(bureauMetadata(retry[0]!.event)['runId']).toBe(
          bureauMetadata(original[0]!.event)['runId'],
        );
        const conflict = await rawPost(
          served,
          runAgentInput({
            runId: 'run-d',
            messages: [],
            resume: [{ interruptId: interrupt!.id, status: 'cancelled' }],
          }),
        );
        expect(conflict[0]!.event).toMatchObject({ code: 'RESUME_CONFLICT' });
      },
    );
  });
});

describe('slow consumer', () => {
  it('closes only the stream that fell behind with STREAM_OVERFLOW, and a second reader misses nothing', async () => {
    await withServed(
      {
        script: [{ kind: 'block', barrier: 'hold' }, say('Done.')],
        agUi: { liveBufferSize: 2 },
      },
      async ({ harness }) => {
        const fast = await harness.handler(
          new Request('http://localhost/ag-ui/agents/assistant/run', {
            method: 'POST',
            headers: { Accept: 'text/event-stream', 'content-type': 'application/json' },
            body: JSON.stringify(runAgentInput()),
          }),
        );
        await harness.generate.reached('hold');
        const runId = harness.bureau.listRuns()[0]!.id;
        // Opened in process: a socket's buffers would hide a reader that never reads.
        const stalled = await harness.handler(
          new Request(`http://localhost/ag-ui/runs/${runId}`, {
            headers: { Accept: 'text/event-stream' },
          }),
        );
        const steady = harness.handler(
          new Request(`http://localhost/ag-ui/runs/${runId}`, {
            headers: { Accept: 'text/event-stream' },
          }),
        );

        // The readers that keep up read while the run goes on; the stalled one does not.
        const fastText = fast.text();
        const steadyText = textOf(steady);
        harness.generate.release('hold');
        const fastFrames = parseAgUiFrames(await fastText);
        const steadyFrames = parseAgUiFrames(await steadyText);
        const stalledFrames = parseAgUiFrames(await stalled.text());

        const deltasOf = (frames: ReadonlyArray<ReceivedFrame>) =>
          frames
            .map((frame) => frame.event)
            .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
            .map((event) => (event as unknown as { delta: string }).delta);
        expect(fastFrames.at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
        expect(steadyFrames.at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
        // The second reader that kept up saw exactly what the first did.
        expect(deltasOf(fastFrames)).toEqual(['Done.']);
        expect(deltasOf(steadyFrames)).toEqual(deltasOf(fastFrames));
        // The stalled one was closed rather than thinned: it holds no delta the others lack.
        expect(deltasOf(stalledFrames).every((delta) => deltasOf(fastFrames).includes(delta))).toBe(
          true,
        );
        expect(stalledFrames.at(-1)!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'STREAM_OVERFLOW',
        });
      },
    );
  });
});

describe('cleanup', () => {
  it('leaves no listener, snapshot subscription, or timer once every stream has ended', async () => {
    const runtime = createManualRuntimeServices();
    await withServed(
      {
        script: [
          lookupOnce,
          say('Found it.'),
          { kind: 'block', barrier: 'hold' },
          say('Finished after its client left.'),
        ],
        toolbox: lookupToolbox(),
        agUi: { runtime },
      },
      async ({ harness, served }) => {
        let frameListeners = 0;
        let snapshotSubscriptions = 0;
        // Settled by the wrapped calls themselves, never by polling or a timer.
        let subscribed = Promise.withResolvers<void>();
        let allGone = Promise.withResolvers<void>();
        const subscribeLiveFrames = harness.bureau.subscribeLiveFrames.bind(harness.bureau);
        const subscribeRunSnapshot = harness.bureau.subscribeRunSnapshot.bind(harness.bureau);
        harness.bureau.subscribeLiveFrames = (listener) => {
          frameListeners += 1;
          subscribed.resolve();
          const stop = subscribeLiveFrames(listener);
          return () => {
            frameListeners -= 1;
            if (frameListeners === 0) allGone.resolve();
            stop();
          };
        };
        harness.bureau.subscribeRunSnapshot = (runId, observer, options) => {
          snapshotSubscriptions += 1;
          const subscription = subscribeRunSnapshot(runId, observer, options);
          return {
            get closed() {
              return subscription.closed;
            },
            unsubscribe: () => {
              snapshotSubscriptions -= 1;
              subscription.unsubscribe();
            },
          };
        };

        const firstObserver = observed();
        await agentFor(served, firstObserver).runAgent({ runId: 'run-a' });
        await allGone.promise;
        expect(frameListeners).toBe(0);
        await firstObserver.frames();

        // A client that goes away once the server has its stream open: the run keeps
        // going, and the stream's listener and subscription go.
        subscribed = Promise.withResolvers<void>();
        allGone = Promise.withResolvers<void>();
        const abandonedObserver = observed();
        const abandoned = agentFor(served, abandonedObserver, { threadId: 'thread-2' });
        const aborted = abandoned.runAgent({ runId: 'run-b' }).then(
          () => undefined,
          () => undefined,
        );
        await harness.generate.reached('hold');
        await subscribed.promise;
        const abandonedRunId = harness.bureau
          .listRuns()
          .find((run) => run.sessionId === 'thread-2')!.id;
        expect(frameListeners).toBe(1);
        abandoned.abortRun();
        await aborted;
        await allGone.promise;
        expect(harness.bureau.getRun(abandonedRunId)?.status).toBe('running');
        harness.generate.release('hold');
        await abandonedObserver.frames();

        expect(frameListeners).toBe(0);
        expect(snapshotSubscriptions).toBe(0);
        expect(runtime.pendingTimers()).toHaveLength(0);
      },
    );
  });
});
