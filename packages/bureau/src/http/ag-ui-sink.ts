/**
 * The Server-Sent Events writer one AG-UI stream owns.
 *
 * Every frame's `data:` line is one `@ag-ui/core` event as JSON. The SSE `id:`
 * field is set only for an event that is the projection of a durable history
 * record, to that record's cursor, so a raw client's last-event-id is always a
 * durable cursor and never the position of a live delta.
 *
 * The sink owns the three ways a stream ends: the client goes away
 * (`cancel`), the mount closes it (`close`), or the stream has been open for its
 * maximum duration (`onDeadline`). A stream that ends this way ends the AG-UI
 * run, never the native one: the sink holds no handle on the native run at all.
 *
 * @module ag-ui-sink
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import type { Event } from '@ag-ui/core';

const textEncoder = new TextEncoder();

/** An SSE comment: a block with no `data:` line, which a client skips. */
const KEEP_ALIVE_FRAME = textEncoder.encode(': keep-alive\n\n');

/**
 * A count that no queue reaches, so `desiredSize` is `capacity - queued` and the
 * sink can read how many chunks are unread without Bun deciding when to stop
 * pulling.
 */
const UNBOUNDED_CAPACITY = 1_000_000_000;

export const AG_UI_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export type AgUiSinkOptions = {
  readonly timers: RuntimeServices['timers'];
  /** The stream ends this many milliseconds after it opens. */
  readonly maxStreamDurationMs: number;
  /**
   * How often a quiet stream writes an SSE comment (`: keep-alive`), which every
   * client ignores. `Bun.serve` closes a connection that sends nothing for ten
   * seconds (`idleTimeout`, at most 255), and a model step that does not stream can
   * be silent for longer, so the default is half of that. Weft's own subscription
   * heartbeat is fifteen seconds, which is longer than Bun's default allows.
   */
  readonly keepAliveMs: number;
  /**
   * How many unread live events a stream holds before it is closed as too slow.
   * The events written at open (the snapshots and the replay of the step in
   * flight) are not live and are not counted against it.
   */
  readonly liveBufferSize: number;
  /** Called once, when the stream has been open for `maxStreamDurationMs`. */
  readonly onDeadline: () => void;
  /** Called once, when the stream ends for any reason, so the owner can release what it holds. */
  readonly onClosed: () => void;
};

export type AgUiSink = {
  readonly response: Response;
  /** Whether the stream has ended; a write after that is dropped. */
  readonly closed: boolean;
  /** Writes an event that opens the stream. Never counted against the live buffer. */
  writeOpening(event: Event, cursor?: string): void;
  /** Writes a live event; `false` when the unread backlog exceeded the live buffer, in which case nothing was written. */
  writeLive(event: Event, cursor?: string): boolean;
  /** Writes the last event the stream carries and ends it, past any backlog. */
  finish(event?: Event, cursor?: string): void;
};

function frameText(event: Event, cursor: string | undefined): string {
  const lines = cursor === undefined ? '' : `id: ${cursor}\n`;
  return `${lines}data: ${JSON.stringify(event)}\n\n`;
}

function frame(event: Event, cursor: string | undefined): Uint8Array {
  return textEncoder.encode(frameText(event, cursor));
}

export function createAgUiSink(options: AgUiSinkOptions): AgUiSink {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let openingChunks = 0;
  let enqueued = 0;
  let cancelDeadline: (() => void) | undefined;
  let cancelKeepAlive: (() => void) | undefined;

  const release = (): void => {
    if (closed) return;
    closed = true;
    if (cancelDeadline !== undefined) {
      cancelDeadline();
      cancelDeadline = undefined;
    }
    if (cancelKeepAlive !== undefined) {
      cancelKeepAlive();
      cancelKeepAlive = undefined;
    }
    options.onClosed();
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      start(streamController) {
        controller = streamController;
      },
      cancel() {
        release();
      },
    },
    new CountQueuingStrategy({ highWaterMark: UNBOUNDED_CAPACITY }),
  );

  const handle = options.timers.setTimeout(() => {
    if (!closed) options.onDeadline();
  }, options.maxStreamDurationMs);
  cancelDeadline = () => options.timers.clearTimeout(handle);

  const queued = (): number => UNBOUNDED_CAPACITY - (controller?.desiredSize ?? UNBOUNDED_CAPACITY);

  // A comment goes out only when nothing is waiting to be read: a reader with
  // events pending is not idle, and one that has stopped reading would otherwise
  // be handed a backlog of comments.
  const keepAlive = options.timers.setInterval(() => {
    if (closed || queued() > 0) return;
    try {
      controller?.enqueue(KEEP_ALIVE_FRAME);
      enqueued += 1;
    } catch {
      release();
    }
  }, options.keepAliveMs);
  cancelKeepAlive = () => options.timers.clearInterval(keepAlive);

  /** The opening chunks the reader has not read yet. Chunks are read in the order written. */
  const unreadOpening = (): number => Math.max(0, openingChunks - (enqueued - queued()));

  const enqueue = (event: Event, cursor: string | undefined): void => {
    try {
      controller?.enqueue(frame(event, cursor));
      enqueued += 1;
    } catch {
      // The reader went away between the check and the write.
      release();
    }
  };

  return {
    response: new Response(stream, { headers: AG_UI_RESPONSE_HEADERS }),
    get closed() {
      return closed;
    },
    writeOpening(event, cursor) {
      if (closed) return;
      openingChunks += 1;
      enqueue(event, cursor);
    },
    writeLive(event, cursor) {
      if (closed) return true;
      if (queued() - unreadOpening() > options.liveBufferSize) return false;
      enqueue(event, cursor);
      return true;
    },
    finish(event, cursor) {
      if (closed) return;
      if (event !== undefined) enqueue(event, cursor);
      release();
      try {
        controller?.close();
      } catch {
        // Already ended by the reader.
      }
    },
  };
}

/**
 * A stream that carries one event and ends: how a door refusal is answered on
 * the three streaming routes, with HTTP 200, so a client that reads events (and
 * turns a non-2xx response into a thrown error instead) sees why.
 */
export function singleEventResponse(event: Event): Response {
  return new Response(frameText(event, undefined), { headers: AG_UI_RESPONSE_HEADERS });
}
