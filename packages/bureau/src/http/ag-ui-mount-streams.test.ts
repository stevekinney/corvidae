/**
 * COR-855 — how a stream ends, and what it leaves behind: the maximum duration,
 * a reader that falls behind, a client that goes away, and the reasoning that
 * never reaches the wire.
 */
import { EventType } from '@ag-ui/core';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory, appendMessages } from 'conversationalist';

import { snapshotMessages } from './ag-ui-messages.ts';
import {
  attachRunRequest,
  type Harness,
  openHarness,
  runAgentInput,
  startRequest,
} from './ag-ui-fixtures.test-support.ts';
import { FrameReader, typesOf } from './ag-ui-stream.test-support.ts';

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
        expect(bureau.listRuns()[0]!.status).toBe('running');

        // The client reconnects with an attach and the run goes on.
        const runId = bureau.listRuns()[0]!.id;
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
        const runId = bureau.listRuns()[0]!.id;
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

describe('cleanup', () => {
  it('leaves no listener, timer, or snapshot subscription once every stream has ended', async () => {
    const runtime = createManualRuntimeServices();
    await withHarness(
      { script: [say('Hello.')], agUi: { runtime } },
      async ({ handler, bureau }) => {
        let listening = 0;
        const original = bureau.subscribeLiveFrames.bind(bureau);
        bureau.subscribeLiveFrames = (listener) => {
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
