import { decodeChatStreamEvents } from '@lostgradient/chat';

import type { ConversationHistory } from 'conversationalist';
import type {
  ApplicationRendererRpc,
  ChatStreamEndMessage,
  ChatStreamLineMessage,
} from '../shared/rpc-contract';

/**
 * An async queue that turns pushed values into an `AsyncIterable`.
 *
 * `decodeChatStreamEvents` accepts `AsyncIterable<string>` directly, so the
 * lines arriving as discrete RPC messages can be fed to the published decoder
 * unchanged — the renderer never re-implements framing, sequencing, or the
 * terminal-frame rule, all of which stay in `@lostgradient/chat` where they are
 * tested.
 *
 * Bounded only by how fast the renderer drains it. A turn's frames are small
 * and the consumer is a synchronous reducer, so backpressure is not modelled;
 * if that changes this is where it would go.
 */
type LineQueue = {
  push(line: string): void;
  close(): void;
  fail(error: Error): void;
  lines: AsyncIterable<string>;
};

function createLineQueue(): LineQueue {
  const buffered: string[] = [];
  let waiting: (() => void) | undefined;
  let closed = false;
  let failure: Error | undefined;

  const wake = () => {
    waiting?.();
    waiting = undefined;
  };

  return {
    push(line) {
      if (closed) return;
      buffered.push(line);
      wake();
    },
    close() {
      closed = true;
      wake();
    },
    fail(error) {
      // The first failure wins: a later one would describe a consequence of
      // this one rather than a second, independent problem.
      failure ??= error;
      closed = true;
      wake();
    },
    lines: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (buffered.length > 0) {
            // `shift` cannot return undefined inside a positive-length guard,
            // but `noUncheckedIndexedAccess` cannot see that.
            const line = buffered.shift();
            if (line !== undefined) yield line;
          }
          if (failure) throw failure;
          if (closed) return;
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
        }
      },
    },
  };
}

export type ChatTransportOptions = {
  rpc: ApplicationRendererRpc;
  /**
   * Registers a listener for one renderer-handled message and returns an
   * unsubscribe. Supplied by the caller rather than read off the RPC object so
   * the transport can be exercised without a live Electrobun bridge.
   */
  subscribe: (handlers: {
    onLine: (payload: ChatStreamLineMessage) => void;
    onEnd: (payload: ChatStreamEndMessage) => void;
  }) => () => void;
  /** Overridable so a test can supply deterministic run ids. */
  createRunId?: () => string;
};

/**
 * Builds the `transport` that `createChatSessionController` calls once per turn.
 *
 * The shape mirrors the old SvelteKit lab's `fetch('/api/chat')` exactly: hand
 * the conversation over, get an async iterable of decoded events back. What
 * changed underneath is only how the bytes travel — an RPC request starts the
 * turn, and its frames arrive as messages, because Electrobun rejects any
 * request outstanding longer than a second.
 */
export function createChatTransport({
  rpc,
  subscribe,
  createRunId = () => crypto.randomUUID(),
}: ChatTransportOptions) {
  return async ({
    conversation,
    signal,
  }: {
    conversation: ConversationHistory;
    signal?: AbortSignal;
  }) => {
    const runId = createRunId();
    const queue = createLineQueue();

    const unsubscribe = subscribe({
      onLine: (payload) => {
        if (payload.runId === runId) queue.push(payload.line);
      },
      onEnd: (payload) => {
        if (payload.runId !== runId) return;
        if (payload.reason === 'failed') {
          queue.fail(new Error('The assistant could not complete this turn.'));
          return;
        }
        queue.close();
      },
    });

    const onAbort = () => {
      // Fire and forget: the run is being torn down either way, and a rejected
      // abort request must not replace the abort the person asked for with an
      // error they did not cause.
      void rpc.request.abortChatRun({ runId }).catch(() => undefined);
    };

    // Subscribed BEFORE the run starts. The main process can emit its first
    // frame the moment `startChatRun` is handled, and a listener attached
    // afterwards would miss it.
    let started: Awaited<ReturnType<typeof rpc.request.startChatRun>>;
    try {
      started = await rpc.request.startChatRun({ runId, conversation });
    } catch (cause) {
      unsubscribe();
      throw cause;
    }

    if (started.status === 'unavailable') {
      unsubscribe();
      throw new Error(started.message);
    }

    signal?.addEventListener('abort', onAbort, { once: true });

    async function* drain() {
      try {
        yield* decodeChatStreamEvents(queue.lines);
      } finally {
        // Runs on normal completion AND on the early `return()` a consumer
        // triggers by breaking out of the loop, which is what makes this the
        // right place to release both the listener and the run.
        signal?.removeEventListener('abort', onAbort);
        unsubscribe();
      }
    }

    return drain();
  };
}
