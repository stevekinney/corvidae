/**
 * Server-Sent Events writer for streamed A2A JSON-RPC responses.
 *
 * Each SSE event's `data:` is exactly one JSON-RPC response object. An event whose
 * cursor entry carries a durable cursor is written with that cursor as its SSE `id`.
 * The stream closes after `maxStreamDurationMs` with a final comment line, so a
 * long-lived subscription reconnects and is authenticated again.
 *
 * @module a2a/sse-response
 */

import { JsonRpcTransportHandler } from '@a2a-js/sdk/server';

import { formatServerSentEvent } from '../server/operations/sse-stream.ts';
import type { StreamCursorEntry } from './stream-cursors.ts';

/** A JSON-RPC response envelope as the SDK's transport handler produces it. */
export type JsonRpcResponseEnvelope = {
  readonly jsonrpc: string;
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: unknown;
};

/**
 * Schedules `callback` after `delayMs` and returns a function that cancels it. The
 * kit uses `setTimeout`; tests substitute a manual clock.
 */
export type A2AStreamTimerScheduler = (callback: () => void, delayMs: number) => () => void;

export const scheduleWithTimeout: A2AStreamTimerScheduler = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => {
    clearTimeout(timer);
  };
};

export type A2AEventStreamOptions = {
  /** The transport handler's response iterator, already advanced once. */
  readonly iterator: AsyncIterator<JsonRpcResponseEnvelope, void, undefined>;
  /** The result of the first `next()`, taken before the response was committed. */
  readonly first: IteratorResult<JsonRpcResponseEnvelope, void>;
  /** One entry per streamed event, filled in order by the cursor-recording wrapper. */
  readonly cursors: StreamCursorEntry[];
  /** The JSON-RPC request id, for an error that interrupts the stream. */
  readonly requestId: string | number | null;
  readonly maxStreamDurationMs: number;
  readonly schedule: A2AStreamTimerScheduler;
  readonly headers: Headers;
};

const textEncoder = new TextEncoder();

function encodeResponseEvent(
  response: JsonRpcResponseEnvelope,
  entry: StreamCursorEntry | undefined,
): Uint8Array {
  const data = JSON.stringify(response);
  const cursor = entry?.cursor;
  return textEncoder.encode(
    formatServerSentEvent(cursor === undefined ? { data } : { id: cursor, data }),
  );
}

/**
 * Await an upstream generator's `return()`. The response is already closed, so a
 * failure in the generator's own cleanup has no one left to report to.
 */
async function settleQuietly(settling: Promise<unknown> | undefined): Promise<void> {
  try {
    await settling;
  } catch {
    // Nothing to do: the client is gone or the stream has already ended.
  }
}

/** Build the `text/event-stream` response for a streaming JSON-RPC method. */
export function createA2AEventStreamResponse(options: A2AEventStreamOptions): Response {
  const { iterator, cursors } = options;
  let closed = false;
  let cancelTimer: (() => void) | undefined;

  function stopUpstream(): void {
    closed = true;
    cancelTimer?.();
    // Settles once any pending `next()` does; nothing waits on it.
    void settleQuietly(iterator.return?.());
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      cancelTimer = options.schedule(() => {
        if (closed) return;
        stopUpstream();
        controller.enqueue(
          textEncoder.encode(
            `: stream closed after ${options.maxStreamDurationMs} ms; reconnect to continue\n\n`,
          ),
        );
        controller.close();
      }, options.maxStreamDurationMs);

      void (async () => {
        let step = options.first;
        try {
          while (step.done !== true) {
            controller.enqueue(encodeResponseEvent(step.value, cursors.shift()));
            step = await iterator.next();
            if (closed) return;
          }
        } catch (error) {
          if (closed) return;
          const response: JsonRpcResponseEnvelope = {
            jsonrpc: '2.0',
            id: options.requestId,
            error: JsonRpcTransportHandler.mapToJSONRPCError(error),
          };
          controller.enqueue(encodeResponseEvent(response, undefined));
        }
        closed = true;
        cancelTimer?.();
        controller.close();
      })();
    },
    cancel() {
      stopUpstream();
    },
  });

  const headers = new Headers(options.headers);
  headers.set('content-type', 'text/event-stream');
  headers.set('cache-control', 'no-cache');
  headers.set('x-accel-buffering', 'no');
  return new Response(body, { status: 200, headers });
}
