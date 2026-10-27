/**
 * COR-855 — how a stream ends, and what it leaves behind: the maximum duration,
 * a reader that falls behind, a client that goes away, and the reasoning that
 * never reaches the wire.
 */
import { EventType } from '@ag-ui/core';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { type Toolbox, waitForCondition } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createConversationHistory, appendMessages } from 'conversationalist';

import { snapshotMessages } from './ag-ui-messages.ts';
import {
  attachRunRequest,
  type Harness,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import { FrameReader, parseAgUiFrames, typesOf } from './ag-ui-stream.test-support.ts';
import { listHeldTasks } from '../test';

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

describe('the maximum stream duration', () => {
  it('ends a stream with STREAM_DEADLINE when the manual clock reaches it, and leaves the run running', async () => {
    const runtime = createManualRuntimeServices();
    await withHarness(
      {
        script: [{ kind: 'block', barrier: 'hold' }, say('Done.')],
        agUi: { maxStreamDurationMs: 60_000, runtime },
      },
      async ({ handler, bureau, generate }) => {
        const stream = new FrameReader(await handler(startRequest(runAgentInput())));
        await stream.until(EventType.STEP_STARTED);
        await generate.reached('hold');

        await runtime.advance(59_999);
        expect(stream.received.at(-1)!.event.type).not.toBe(EventType.RUN_ERROR);
        await runtime.advance(1);
        const tail = await stream.rest();

        expect(tail).toHaveLength(1);
        expect(tail[0]!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'STREAM_DEADLINE',
          message: 'The stream reached its maximum duration; attach again.',
        });
        expect(listHeldTasks(bureau)[0]!.status).toBe('running');

        // The client reconnects with an attach and the run goes on.
        const runId = listHeldTasks(bureau)[0]!.id;
        const again = new FrameReader(await handler(attachRunRequest(runId)));
        await again.until(EventType.STATE_SNAPSHOT);
        generate.release('hold');
        const againTail = await again.rest();
        expect(againTail.at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
        expect(runtime.pendingTimers()).toHaveLength(0);
      },
    );
  });
});

describe('a reader that falls behind', () => {
  it('has its own stream closed with STREAM_OVERFLOW while a second reader misses nothing', async () => {
    await withHarness(
      {
        script: [{ kind: 'block', barrier: 'hold' }, say('x'.repeat(10))],
        agUi: { liveBufferSize: 2 },
      },
      async ({ handler, bureau, generate }) => {
        const fast = new FrameReader(await handler(startRequest(runAgentInput())));
        await fast.until(EventType.STEP_STARTED);
        await generate.reached('hold');
        const runId = listHeldTasks(bureau)[0]!.id;
        // A second stream that is opened and never read from.
        const slow = await handler(attachRunRequest(runId));

        generate.release('hold');
        const fastTail = await fast.rest();
        const slowFrames = new FrameReader(slow);
        const slowRead = await slowFrames.rest();

        expect(fastTail.at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
        expect(typesOf(fastTail)).toContain(EventType.TEXT_MESSAGE_CONTENT);
        expect(slowRead.at(-1)!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'STREAM_OVERFLOW',
        });
      },
    );
  });
});

describe('a quiet stream', () => {
  it('carries an SSE comment every few seconds, on the manual clock, so an idle timeout never closes it', async () => {
    const runtime = createManualRuntimeServices();
    await withHarness(
      { script: [{ kind: 'block', barrier: 'hold' }, say('Done.')], agUi: { runtime } },
      async ({ handler, generate }) => {
        const response = await handler(startRequest(runAgentInput()));
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let raw = '';
        const pump = (async () => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            raw += decoder.decode(value, { stream: true });
          }
        })();
        await generate.reached('hold');

        await runtime.advance(4_999);
        const beforeInterval = raw;
        await runtime.advance(1);
        await Promise.resolve();

        expect(beforeInterval).not.toMatch(/^:/m);
        expect(raw).toMatch(/^: keep-alive$/m);
        generate.release('hold');
        await pump;
        // A client that parses events skips the comment.
        expect(parseAgUiFrames(raw).at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
        expect(runtime.pendingTimers()).toHaveLength(0);
      },
    );
  });

  it('sends no comment while the reader still has events to read', async () => {
    const runtime = createManualRuntimeServices();
    await withHarness(
      { script: [{ kind: 'block', barrier: 'hold' }, say('Done.')], agUi: { runtime } },
      async ({ handler, generate }) => {
        const response = await handler(startRequest(runAgentInput()));
        await generate.reached('hold');

        await runtime.advance(60_000);
        generate.release('hold');
        const text = await response.text();

        expect(text).not.toMatch(/^:/m);
      },
    );
  });
});

describe('the live backlog bound', () => {
  it('counts only unread live events once the opening has been read', async () => {
    const calls = Array.from({ length: 6 }, (_unused, index) => ({
      id: `call-${index}`,
      name: 'wait-for-gate',
      arguments: {},
    }));
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const tool = createTool({
      name: 'wait-for-gate',
      description: 'waits',
      input: z.object({}),
      async execute() {
        await gate;
        return 'done';
      },
    });
    await withHarness(
      {
        script: [
          { kind: 'respond', response: { content: 'Calling.', toolCalls: calls } },
          say('Finished.'),
        ],
        toolbox: createToolbox([tool]) as unknown as Toolbox,
        agUi: { liveBufferSize: 3 },
      },
      async ({ handler, bureau }) => {
        const starter = await handler(startRequest(runAgentInput()));
        await waitForCondition(
          () =>
            bureau.tasks
              .detail(listHeldTasks(bureau)[0]?.id ?? '')
              ?.events.some((event) => event.event === 'tools.executing') === true,
          'the calls never started',
        );
        const runId = listHeldTasks(bureau)[0]!.id;
        const stalled = new FrameReader(await handler(attachRunRequest(runId)));
        // Read the whole opening: the snapshots, the step, the message, and each call.
        const opening = 4 + 3 + 3 * calls.length;
        for (let read = 0; read < opening; read += 1) await stalled.next();
        expect(stalled.received.at(-1)!.event.type).toBe(EventType.TOOL_CALL_END);

        // Everything after this is live. The reader reads none of it.
        const startedText = starter.text();
        open();
        await startedText;
        const tail = await stalled.rest();

        expect(tail.at(-1)!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'STREAM_OVERFLOW',
        });
      },
    );
  });
});

describe('the revision of the state a stream reports', () => {
  it('never goes down on one stream, whatever order the Bureau reports liveness in', async () => {
    await withHarness(
      { script: [{ kind: 'block', barrier: 'hold' }, say('Done.')] },
      async ({ handler, bureau, generate }) => {
        const observers: Array<(snapshot: never) => void> = [];
        const subscribe = bureau.tasks.snapshot.bind(bureau.tasks);
        bureau.tasks.snapshot = (runId, observer, options) => {
          observers.push(observer);
          return subscribe(runId, observer, options);
        };
        const starter = new FrameReader(await handler(startRequest(runAgentInput())));
        await starter.until(EventType.STEP_STARTED);
        await generate.reached('hold');
        const runId = listHeldTasks(bureau)[0]!.id;
        const attached = new FrameReader(await handler(attachRunRequest(runId)));
        await attached.until(EventType.STEP_STARTED);
        const observe = observers.at(-1)!;
        const snapshot = (revision: number, status: string) =>
          ({ ...bureau.tasks.detail(runId)!.liveness, revision, status }) as never;

        observe(snapshot(99, 'waiting'));
        observe(snapshot(1, 'running'));
        generate.release('hold');
        const tail = await attached.rest();

        const revisions = [...attached.received]
          .filter((frame) => frame.event.type === EventType.STATE_SNAPSHOT)
          .map(
            (frame) =>
              (frame.event as unknown as { snapshot: { revision: number } }).snapshot.revision,
          );
        expect(revisions.length).toBeGreaterThanOrEqual(3);
        expect(revisions).toEqual(revisions.toSorted((left, right) => left - right));
        expect(tail.at(-1)!.event.type).toBe(EventType.RUN_FINISHED);
        await starter.rest();
      },
    );
  });
});

describe('text deltas that arrive while a stream is still opening', () => {
  it('are dropped, because the replay and the next delta carry everything they would', async () => {
    await withHarness(
      { script: [{ kind: 'block', barrier: 'hold' }, say('Done.')] },
      async ({ handler, bureau, generate }) => {
        const starter = new FrameReader(await handler(startRequest(runAgentInput())));
        await starter.until(EventType.STEP_STARTED);
        await generate.reached('hold');
        const runId = listHeldTasks(bureau)[0]!.id;
        // A delta from before the stream's replay was read reaches its listener
        // while it is still buffering.
        const subscribe = bureau.frames.bind(bureau);
        bureau.frames = (listener) => {
          const stop = subscribe(listener);
          listener({
            type: 'stream:text-delta',
            runId,
            content: 'stale',
            accumulated: 'stale',
            runSeq: 1,
          });
          return stop;
        };

        const attached = new FrameReader(await handler(attachRunRequest(runId)));
        await attached.until(EventType.STEP_STARTED);
        generate.release('hold');
        await attached.rest();

        const text = attached.received
          .filter((frame) => frame.event.type === EventType.TEXT_MESSAGE_CONTENT)
          .map((frame) => (frame.event as unknown as { delta: string }).delta);
        expect(text).toEqual(['Done.']);
        await starter.rest();
      },
    );
  });
});

describe('the answer an onMaximumSteps handler leaves', () => {
  it('reaches a stream before its RUN_ERROR, from the completion the run records', async () => {
    await withHarness(
      { script: [{ kind: 'block', barrier: 'hold' }, say('Done.')] },
      async ({ handler, bureau, generate }) => {
        // A run completes with the handler's text recorded only on its completion event, which
        // is the one frame the stream cannot get that text from anywhere else.
        let deliver: Parameters<Harness['bureau']['frames']>[0] | undefined;
        const subscribe = bureau.frames.bind(bureau);
        bureau.frames = (listener) => {
          deliver = listener;
          return subscribe(listener);
        };
        const stream = new FrameReader(await handler(startRequest(runAgentInput())));
        await stream.until(EventType.STEP_STARTED);
        await generate.reached('hold');
        const nativeRunId = listHeldTasks(bureau)[0]!.id;

        deliver!({
          type: 'event',
          event: 'step.completed',
          runId: nativeRunId,
          sequence: 999_999,
          detail: { step: 0, content: '' },
        } as never);
        deliver!({
          type: 'event',
          event: 'run.completed',
          runId: nativeRunId,
          sequence: 1_000_000,
          detail: {
            finishReason: 'maximum-steps',
            content: 'Out of steps.',
            steps: [{ step: 0, content: '' }],
            error: JSON.stringify({
              message: 'Agent run exceeded maximumSteps (1).',
              kind: 'policy',
              code: 'MAXIMUM_STEPS',
            }),
          },
        } as never);
        const tail = await stream.rest();
        generate.release('hold');

        expect(tail.slice(-4).map((frame) => frame.event.type)).toEqual([
          EventType.TEXT_MESSAGE_START,
          EventType.TEXT_MESSAGE_CONTENT,
          EventType.TEXT_MESSAGE_END,
          EventType.RUN_ERROR,
        ]);
        expect(tail.at(-3)!.event).toMatchObject({
          messageId: `${nativeRunId}:step:1`,
          delta: 'Out of steps.',
        });
        // COR-1627: the run stopped at its step limit, which is a failure.
        expect(tail.at(-1)!.event).toMatchObject({
          code: 'MAXIMUM_STEPS',
          message: 'Agent run exceeded maximumSteps (1).',
        });
      },
    );
  });
});

describe('the answer an onMaximumSteps handler leaves, for a client that attached', () => {
  it('is not announced again when the snapshot the attach opened with already holds its row', async () => {
    await withHarness(
      { script: [{ kind: 'block', barrier: 'hold' }, say('Done.')] },
      async ({ handler, bureau, generate }) => {
        let deliver: Parameters<Harness['bureau']['frames']>[0] | undefined;
        const subscribe = bureau.frames.bind(bureau);
        bureau.frames = (listener) => {
          deliver = listener;
          return subscribe(listener);
        };
        const starter = new FrameReader(await handler(startRequest(runAgentInput())));
        await starter.until(EventType.STEP_STARTED);
        await generate.reached('hold');
        const nativeRunId = listHeldTasks(bureau)[0]!.id;
        // The run has already put its answer in the conversation, under the id the step
        // after its last would have had, as a run does before this stream's completion.
        const tailRow = {
          id: `${nativeRunId}:step:1`,
          role: 'assistant' as const,
          content: 'Out of steps.',
        };
        const getRun = bureau.tasks.detail.bind(bureau.tasks);
        bureau.tasks.detail = (runId) => {
          const detail = getRun(runId);
          return detail?.transcript === undefined
            ? detail
            : { ...detail, transcript: appendMessages(detail.transcript, tailRow) };
        };
        const getSession = bureau.contexts.get.bind(bureau);
        bureau.contexts.get = async (sessionId) => {
          const session = await getSession(sessionId);
          return session === undefined
            ? session
            : {
                ...session,
                conversationHistory: appendMessages(session.conversationHistory, tailRow),
              };
        };
        const attached = new FrameReader(await handler(attachRunRequest(nativeRunId)));
        await attached.until(EventType.STEP_STARTED);

        deliver!({
          type: 'event',
          event: 'run.completed',
          runId: nativeRunId,
          sequence: 1_000_000,
          detail: {
            finishReason: 'maximum-steps',
            content: 'Out of steps.',
            steps: [{ step: 0, content: '' }],
            error: JSON.stringify({
              message: 'Agent run exceeded maximumSteps (1).',
              kind: 'policy',
              code: 'MAXIMUM_STEPS',
            }),
          },
        } as never);
        const tail = await attached.rest();
        generate.release('hold');

        expect(
          attached.received.some((frame) => frame.event.type === EventType.MESSAGES_SNAPSHOT),
        ).toBe(true);
        expect(
          attached.received.filter((frame) => frame.event.type === EventType.TEXT_MESSAGE_START),
        ).toEqual([]);
        expect(tail.at(-1)!.event).toMatchObject({
          type: EventType.RUN_ERROR,
          code: 'MAXIMUM_STEPS',
        });
        await starter.rest();
      },
    );
  });
});

describe('cleanup', () => {
  it('leaves no listener, timer, or snapshot subscription once every stream has ended', async () => {
    const runtime = createManualRuntimeServices();
    await withHarness(
      { script: [say('Hello.')], agUi: { runtime } },
      async ({ handler, bureau }) => {
        let listening = 0;
        const original = bureau.frames.bind(bureau);
        bureau.frames = (listener) => {
          listening += 1;
          const stop = original(listener);
          return () => {
            listening -= 1;
            stop();
          };
        };

        const finished = new FrameReader(await handler(startRequest(runAgentInput())));
        await finished.rest();
        const abandoned = new FrameReader(
          await handler(startRequest(runAgentInput({ runId: 'r-2', threadId: 'thread-2' }))),
        );
        await abandoned.next();
        await abandoned.cancel();

        expect(listening).toBe(0);
        expect(runtime.pendingTimers()).toHaveLength(0);
      },
    );
  });
});

describe('reasoning', () => {
  it('never reaches a snapshot: thinking and redacted thinking parts are taken out before export', () => {
    const history = appendMessages(
      createConversationHistory({ id: 'thread-1' }),
      { id: 'user-1', role: 'user', content: 'hi' },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'secret chain of thought', signature: 'sig' },
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'text', text: 'The answer.' },
        ],
      },
    );

    const messages = snapshotMessages(history);

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(messages)).not.toContain('secret chain of thought');
    expect(messages[1]).toMatchObject({ id: 'assistant-1', content: 'The answer.' });
  });
});

describe('parts an AG-UI assistant message cannot carry (COR-713)', () => {
  const unrepresentable: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    [
      'server_tool_use',
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'q' } },
    ],
    [
      'web_search_tool_result',
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: [{ type: 'web_search_result', url: 'https://e.x', title: 't' }],
      },
    ],
    [
      'web_fetch_tool_result',
      {
        type: 'web_fetch_tool_result',
        tool_use_id: 'srvtoolu_2',
        content: { type: 'web_fetch_result', url: 'https://x.test' },
      },
    ],
    [
      'code_execution_tool_result',
      {
        type: 'code_execution_tool_result',
        tool_use_id: 'srvtoolu_3',
        content: { type: 'code_execution_result', stdout: '2', stderr: 'none', return_code: 0 },
      },
    ],
    ['container_upload', { type: 'container_upload', file_id: 'file_1' }],
    [
      'managed-asset image',
      {
        type: 'image',
        mimeType: 'image/png',
        source: { kind: 'managed-asset', assetId: 'asset-1', revision: 1 },
      },
    ],
  ];

  it.each(unrepresentable)(
    'a %s part never fails the snapshot: the row keeps its text',
    (_name, part) => {
      const history = appendMessages(
        createConversationHistory({ id: 'thread-1' }),
        { id: 'user-1', role: 'user', content: 'hi' },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: [part as never, { type: 'text', text: 'The answer.' }],
        },
      );

      const messages = snapshotMessages(history);

      expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
      expect(messages[1]).toMatchObject({ id: 'assistant-1', content: 'The answer.' });
    },
  );

  it('keeps a row that holds only such a part, without content, rather than dropping the thread', () => {
    const history = appendMessages(
      createConversationHistory({ id: 'thread-1' }),
      { id: 'user-1', role: 'user', content: 'hi' },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: [{ type: 'container_upload', file_id: 'f' } as never],
      },
    );

    expect(snapshotMessages(history).map((message) => message.role)).toEqual(['user', 'assistant']);
  });
});
