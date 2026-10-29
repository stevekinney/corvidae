/**
 * `WorkflowTailSource` — the per-workflow live event tail (plan §5.1, T1.4):
 * reads `GET /v1/workflows/:id/events/sse` itself and resumes it from its
 * last cursor.
 *
 * **Why not `client.tail(id)`.** `WorkflowEventTail` (from
 * `@lostgradient/weft`) already reconnects internally, but its policy is a
 * FAST, SHORT retry (linear backoff from a 50ms base, capped at 5 attempts)
 * and, once exhausted, the tail closes for good with no way to resume it.
 * Plan §5.1 calls for "exponential backoff capped at 30s" with no attempt
 * ceiling — an operator watching a live incident should not have the tail
 * silently give up after under a second of retries. A second `client.tail()`
 * call is no substitute: it replays the workflow's FULL persisted history,
 * and the `WorkflowEvent` it yields (`{ type, timestamp, data }`) carries no
 * cursor, so a caller could only de-duplicate by position — which this
 * source used to do and no longer does. The cursor lives in the SSE envelope
 * (`cursor`, mirrored in the frame's `id:` field), and `client.tail()`
 * strips it before the caller sees anything.
 *
 * **Cursor resume.** This source therefore owns the transport the way
 * `FleetEventSource` does (`sse-reader.ts` explains why a fetch-stream reader
 * rather than `EventSource`). It remembers the `id:` of the last event frame
 * it delivered and sends it as `Last-Event-ID` on the next request; the
 * server replays strictly after that cursor, so a reconnect delivers every
 * event exactly once — nothing replayed, nothing skipped. The very first
 * request carries no cursor and so replays the full history, as before.
 * Reconnects use the plan §5.1 capped-exponential curve with no attempt
 * ceiling.
 *
 * **Terminal detection.** The source watches each delivered frame's `.type`
 * itself (`isTerminalWorkflowEventType`, shared with `cache-integration.ts`)
 * — once a terminal lifecycle event has been delivered, the workflow is
 * genuinely done and the source settles to `'closed'` instead of
 * reconnecting.
 *
 * **Buffer.** Single-consumer (`subscribe()` throws on a second concurrent
 * caller). The bounded ~500-frame buffer exists ONLY for the pre-attach
 * window — the connection starts in the constructor, before any `subscribe()`
 * call, so frames can arrive before there is anyone to deliver them to. Once
 * a subscriber IS attached, frames go straight to it; there is no
 * steady-state mirror of history sitting behind the buffer (that durability
 * job belongs to the TanStack cache — see plan §5.1 and
 * `cache-integration.ts`). Overflowing the pre-attach buffer means frames
 * were dropped before anyone ever saw them; that's surfaced as `'stale'`.
 *
 * **HMR safety** (plan §2): every live instance is tracked in a
 * module-scope set; `import.meta.hot?.dispose` closes them all before Vite
 * swaps this module out.
 */
import type { WorkflowEvent } from '@lostgradient/weft';

import { computeReconnectDelayMs } from './backoff.ts';
import { readServerSentEventStream, type ServerSentEventFrame } from './sse-reader.ts';
import type { LiveSource, LiveSourceStatus } from './types.ts';
import { isTerminalWorkflowEventType } from './workflow-lifecycle-events.ts';

/** Where to reach the server — the subset of `HttpClient` that `WorkflowTailSource` needs, so a real client satisfies it structurally. */
export interface WorkflowTailConnection {
  /** Same-origin-relative (`''`, `'/api'`) or absolute; never includes `/v1/workflows/...` itself. */
  readonly baseUrl: string;
  readonly headers?: Record<string, string>;
}

/**
 * Options for a workflow tail source: the pre-attach buffer cap and the reconnect backoff curve.
 */
export interface WorkflowTailSourceOptions {
  /** Pre-attach buffer cap. Default 500 (plan §5.1: "bounded ~500 frames"). */
  readonly bufferLimit?: number;
  /** Overrides the reconnect backoff curve. Defaults to `computeReconnectDelayMs` (plan §5.1's capped-exponential curve) — tests inject a near-zero function to avoid waiting on the real 1s+ backoff. */
  readonly computeReconnectDelayMs?: (attempt: number) => number;
}

const DEFAULT_BUFFER_LIMIT = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function isReplayCompletePing(data: string): boolean {
  const parsed = parseJson(data);
  return isRecord(parsed) && parsed['replayComplete'] === true;
}

function buildWorkflowEventsUrl(baseUrl: string, workflowId: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/v1/workflows/${encodeURIComponent(workflowId)}/events/sse`;
}

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get('Content-Type');
  if (contentType === null) return false;
  return contentType.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
}

/** One parsed envelope: the event the subscriber sees, plus the cursor to resume after it. */
interface WorkflowEnvelope {
  readonly event: WorkflowEvent;
  readonly cursor: string;
}

/** Parses one frame's `data:` against the per-workflow envelope wire shape; null for anything that is not an `events` envelope for `workflowId`. */
function parseWorkflowEnvelope(data: string, workflowId: string): WorkflowEnvelope | null {
  const parsed = parseJson(data);
  if (!isRecord(parsed)) return null;
  if (parsed['workflowId'] !== workflowId) return null;
  const { kind, cursor, emittedAtMs, payload } = parsed;
  if (typeof kind !== 'string' || typeof cursor !== 'string') return null;
  if (typeof emittedAtMs !== 'number' || !Number.isFinite(emittedAtMs)) return null;
  if (!Object.hasOwn(parsed, 'payload')) return null;
  return {
    cursor,
    event: {
      type: kind,
      timestamp: emittedAtMs,
      data: isRecord(payload) ? payload : { value: payload },
    },
  };
}

/**
 * The live tail of one workflow's events. It buffers frames until a subscriber attaches and
 * reconnects with a backoff when the stream drops.
 */
export class WorkflowTailSource implements LiveSource<WorkflowEvent> {
  status: LiveSourceStatus = $state('connecting');

  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #workflowId: string;
  readonly #bufferLimit: number;
  readonly #computeReconnectDelayMs: (attempt: number) => number;

  #subscriber: ((frame: WorkflowEvent) => void) | null = null;
  #preAttachBuffer: WorkflowEvent[] = [];
  /** The cursor of the last event delivered, sent as `Last-Event-ID` on the next request so the server replays strictly after it. */
  #lastCursor: string | undefined;

  #abortController: AbortController | null = null;
  #closed = false;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #connected: ReturnType<typeof Promise.withResolvers<void>> = Promise.withResolvers();

  constructor(
    connection: WorkflowTailConnection,
    workflowId: string,
    options?: WorkflowTailSourceOptions,
  ) {
    this.#url = buildWorkflowEventsUrl(connection.baseUrl, workflowId);
    this.#headers = { ...connection.headers };
    this.#workflowId = workflowId;
    this.#bufferLimit = options?.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
    this.#computeReconnectDelayMs = options?.computeReconnectDelayMs ?? computeReconnectDelayMs;
    openWorkflowTailSources.add(this);
    void this.#connect();
  }

  subscribe(onFrame: (frame: WorkflowEvent) => void): () => void {
    if (this.#subscriber !== null) {
      throw new Error(
        `WorkflowTailSource(${this.#workflowId}): only one subscriber is supported at a time — unsubscribe the current one before attaching another.`,
      );
    }
    this.#subscriber = onFrame;
    const buffered = this.#preAttachBuffer;
    this.#preAttachBuffer = [];
    for (const frame of buffered) onFrame(frame);
    if (this.status === 'stale' && this.#abortController !== null) this.status = 'live';

    return () => {
      if (this.#subscriber === onFrame) this.#subscriber = null;
    };
  }

  whenConnected(): Promise<void> {
    return this.#connected.promise;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#abortController?.abort();
    this.#abortController = null;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.status = 'closed';
    this.#connected.resolve();
    openWorkflowTailSources.delete(this);
  }

  async #connect(): Promise<void> {
    if (this.#closed) return;
    this.status = this.#reconnectAttempt === 0 ? 'connecting' : 'reconnecting';

    const controller = new AbortController();
    this.#abortController = controller;
    const sawTerminalEvent = await this.#fetchAndDrain(controller);
    // Draining can end with the response still open (a terminal event, or a close() mid-frame),
    // and releasing the reader does not cancel the request: abort it so the connection and the
    // server's subscription end with this attempt.
    controller.abort();
    if (this.#abortController === controller) this.#abortController = null;
    if (this.#closed) return;

    if (sawTerminalEvent) {
      this.status = 'closed';
      this.#connected.resolve();
      return;
    }
    this.#scheduleReconnect();
  }

  /** Fetches the SSE endpoint, resuming after the last cursor, and drains it. Returns whether a terminal workflow event was delivered. */
  async #fetchAndDrain(controller: AbortController): Promise<boolean> {
    try {
      const response = await fetch(this.#url, {
        headers: this.#requestHeaders(),
        signal: controller.signal,
      });
      if (!response.ok || !isEventStreamResponse(response)) return false;

      for await (const frame of readServerSentEventStream(response, controller.signal)) {
        if (this.#handleFrame(frame)) return true;
        if (this.#closed) return false;
      }
      return false;
    } catch {
      return false;
    }
  }

  #requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = { ...this.#headers, Accept: 'text/event-stream' };
    if (this.#lastCursor !== undefined) headers['Last-Event-ID'] = this.#lastCursor;
    return headers;
  }

  /** Handles one SSE frame. Returns whether it delivered a terminal workflow event. */
  #handleFrame(frame: ServerSentEventFrame): boolean {
    if (frame.event === 'ping') {
      this.#reconnectAttempt = 0;
      if (isReplayCompletePing(frame.data)) this.#markLive();
      return false;
    }
    // `event: error` precedes the server closing the stream; the stream end
    // just after it drives the same reconnect path as any other drop.
    if (frame.event === 'error') return false;

    const envelope = parseWorkflowEnvelope(frame.data, this.#workflowId);
    if (envelope === null) return false;
    this.#lastCursor = frame.id ?? envelope.cursor;
    this.#reconnectAttempt = 0;
    this.#markLive();
    this.#emit(envelope.event);
    return isTerminalWorkflowEventType(envelope.event.type);
  }

  #markLive(): void {
    // Do not overwrite `'stale'`: a dropped pre-attach frame stays reported until a subscriber attaches.
    if (this.status !== 'stale') this.status = 'live';
    // `Promise.withResolvers` resolvers are idempotent past the first settle.
    this.#connected.resolve();
  }

  #emit(frame: WorkflowEvent): void {
    if (this.#subscriber !== null) {
      this.#subscriber(frame);
      return;
    }
    this.#preAttachBuffer.push(frame);
    if (this.#preAttachBuffer.length > this.#bufferLimit) {
      this.#preAttachBuffer.shift();
      this.status = 'stale';
    }
  }

  #scheduleReconnect(): void {
    if (this.#closed) return;
    this.status = 'reconnecting';
    this.#reconnectAttempt += 1;
    const delay = this.#computeReconnectDelayMs(this.#reconnectAttempt);
    // poll-reason: timer
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connect();
    }, delay);
  }
}

// ---------------------------------------------------------------------------
// HMR safety (plan §2): close every open instance before a hot module swap.
// ---------------------------------------------------------------------------

const openWorkflowTailSources = new Set<WorkflowTailSource>();

import.meta.hot?.dispose(() => {
  for (const source of openWorkflowTailSources) source.close();
  openWorkflowTailSources.clear();
});
