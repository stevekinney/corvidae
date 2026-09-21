import { encodeChatStreamEvent } from '@lostgradient/chat';
import { describe, expect, test } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { createChatTransport } from '../../src/views/chat-transport.ts';

import type {
  ApplicationRendererRpc,
  ChatStreamEndMessage,
  ChatStreamLineMessage,
} from '../../src/shared/rpc-contract.ts';

/**
 * A stand-in for the native bridge.
 *
 * The transport's whole job is correlating one turn's frames with one run id
 * across a channel that carries every run's frames, so the fake deliberately
 * keeps the broadcast shape: `emitLine` reaches every subscriber, exactly as
 * the real `chatStreamLine` handler does.
 */
function createBridge(options: { started?: 'started' | 'unavailable' } = {}) {
  const subscribers = new Set<{
    onLine: (payload: ChatStreamLineMessage) => void;
    onEnd: (payload: ChatStreamEndMessage) => void;
  }>();
  const aborted: string[] = [];

  const rpc = {
    request: {
      startChatRun: async () =>
        options.started === 'unavailable'
          ? ({ status: 'unavailable', message: 'ANTHROPIC_API_KEY is not configured' } as const)
          : ({ status: 'started' } as const),
      abortChatRun: async ({ runId }: { runId: string }) => {
        aborted.push(runId);
        return { aborted: true };
      },
    },
  } as unknown as ApplicationRendererRpc;

  return {
    rpc,
    aborted,
    subscriberCount: () => subscribers.size,
    subscribe: (entry: {
      onLine: (payload: ChatStreamLineMessage) => void;
      onEnd: (payload: ChatStreamEndMessage) => void;
    }) => {
      subscribers.add(entry);
      return () => subscribers.delete(entry);
    },
    emitLine: (payload: ChatStreamLineMessage) => {
      for (const entry of Array.from(subscribers)) entry.onLine(payload);
    },
    emitEnd: (payload: ChatStreamEndMessage) => {
      for (const entry of Array.from(subscribers)) entry.onEnd(payload);
    },
  };
}

const frame = (sequence: number, text: string) =>
  encodeChatStreamEvent({ type: 'text', text, wireVersion: 2, sequence });

const terminal = (sequence: number) =>
  encodeChatStreamEvent({
    type: 'run.completed',
    conversation: createConversationHistory({ id: 'test' }),
    content: 'done',
    usage: { prompt: 1, completion: 1, total: 2 },
    finishReason: 'stop',
    wireVersion: 2,
    sequence,
  });

describe('the chat transport', () => {
  test('decodes this run’s frames and stops at the terminal frame', async () => {
    const bridge = createBridge();
    const transport = createChatTransport({
      rpc: bridge.rpc,
      subscribe: bridge.subscribe,
      createRunId: () => 'run-1',
    });

    const events = await transport({ conversation: createConversationHistory({ id: 'test' }) });
    bridge.emitLine({ runId: 'run-1', line: frame(0, 'hello ') });
    bridge.emitLine({ runId: 'run-1', line: frame(1, 'world') });
    bridge.emitLine({ runId: 'run-1', line: terminal(2) });
    // The main process always follows the terminal frame with an end, and the
    // decoder keeps reading its source until it closes; without this the
    // consumer would wait on a stream that has nothing left to say.
    bridge.emitEnd({ runId: 'run-1', reason: 'completed' });

    const seen: string[] = [];
    for await (const event of events) seen.push(event.type);

    expect(seen).toEqual(['text', 'text', 'run.completed']);
  });

  test('ignores frames belonging to another run', async () => {
    const bridge = createBridge();
    const transport = createChatTransport({
      rpc: bridge.rpc,
      subscribe: bridge.subscribe,
      createRunId: () => 'run-1',
    });

    const events = await transport({ conversation: createConversationHistory({ id: 'test' }) });
    // A second window's turn, on the same broadcast channel. Accepting it
    // would inject another conversation's text into this one, and its
    // sequence numbering would make the decoder reject the stream outright.
    bridge.emitLine({ runId: 'run-2', line: frame(0, 'not mine') });
    bridge.emitLine({ runId: 'run-1', line: frame(0, 'mine') });
    bridge.emitLine({ runId: 'run-1', line: terminal(1) });
    bridge.emitEnd({ runId: 'run-1', reason: 'completed' });

    const texts: string[] = [];
    for await (const event of events) {
      if (event.type === 'text') texts.push(event.text);
    }

    expect(texts).toEqual(['mine']);
  });

  test('surfaces an unavailable run as its message, and subscribes to nothing', async () => {
    const bridge = createBridge({ started: 'unavailable' });
    const transport = createChatTransport({
      rpc: bridge.rpc,
      subscribe: bridge.subscribe,
      createRunId: () => 'run-1',
    });

    await expect(
      transport({ conversation: createConversationHistory({ id: 'test' }) }),
    ).rejects.toThrow('ANTHROPIC_API_KEY is not configured');
    // A refused run must not leave a listener behind; the next turn would then
    // deliver its frames to a queue nothing reads.
    expect(bridge.subscriberCount()).toBe(0);
  });

  test('releases its listener once the caller stops reading', async () => {
    const bridge = createBridge();
    const transport = createChatTransport({
      rpc: bridge.rpc,
      subscribe: bridge.subscribe,
      createRunId: () => 'run-1',
    });

    const events = await transport({ conversation: createConversationHistory({ id: 'test' }) });
    expect(bridge.subscriberCount()).toBe(1);

    bridge.emitLine({ runId: 'run-1', line: frame(0, 'hello') });
    // Breaking out calls the generator's `return()`, which must run the
    // cleanup in its `finally` rather than leaking the subscription.
    for await (const _event of events) break;

    expect(bridge.subscriberCount()).toBe(0);
  });

  test('aborts the run in the main process when the signal fires', async () => {
    const bridge = createBridge();
    const transport = createChatTransport({
      rpc: bridge.rpc,
      subscribe: bridge.subscribe,
      createRunId: () => 'run-1',
    });
    const controller = new AbortController();

    const events = await transport({
      conversation: createConversationHistory({ id: 'test' }),
      signal: controller.signal,
    });
    controller.abort();
    await Promise.resolve();

    expect(bridge.aborted).toEqual(['run-1']);
    bridge.emitEnd({ runId: 'run-1', reason: 'completed' });
    for await (const _event of events) break;
  });

  test('a failed end closes the stream with an error rather than hanging', async () => {
    const bridge = createBridge();
    const transport = createChatTransport({
      rpc: bridge.rpc,
      subscribe: bridge.subscribe,
      createRunId: () => 'run-1',
    });

    const events = await transport({ conversation: createConversationHistory({ id: 'test' }) });
    // No terminal frame: the main process died mid-turn. Without the explicit
    // end the composer would stay disabled forever waiting for a frame that
    // is never coming.
    bridge.emitEnd({ runId: 'run-1', reason: 'failed' });

    await expect(
      (async () => {
        for await (const _event of events) void _event;
      })(),
    ).rejects.toThrow('could not complete this turn');
  });
});
