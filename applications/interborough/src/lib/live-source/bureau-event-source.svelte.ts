/**
 * `BureauEventSource` — the Bureau's own event feed (`bureau.events`, COR-1722): the shell's one
 * connection to `GET /bureau/v1/subscriptions/bureau.events`, resumable with `Last-Event-ID`, so the
 * views that show the Bureau's reviews and runs follow it instead of asking again on a timer.
 *
 * **What it sends subscribers.** Every live envelope, as the Bureau sent it, and two recovery
 * signals the cache layer answers by asking everything again: the feed's own `feed.gap` (the cursor
 * named a position the feed no longer holds, such as one from before a host restart) and
 * `frames.dropped` (this reader fell behind and the feed skipped ahead), and {@link BUREAU_RESYNC_KIND},
 * which this source makes itself.
 *
 * **Replay.** A connection replays what the feed retains after its cursor, up to a thousand events,
 * and a connection with no cursor replays all of it. Those envelopes are not news: a view that asked
 * an hour ago does not need a refetch per event of the hour. They are held back, and the one
 * `replayComplete` ping that ends the replay dispatches a single {@link BUREAU_RESYNC_KIND} frame
 * when any were held, however many reconnects the replay took. Only envelopes after the ping reach a
 * subscriber one by one.
 *
 * **Refusals.** A refused request (a stale cursor, a `bureauId` the host no longer answers to) drops
 * the cursor and the cached `bureauId`, so the next attempt starts over instead of replaying the
 * same refusal, and asks for a resync once it has caught up.
 *
 * **Transport.** The same fetch-stream reader `FleetEventSource` uses (`./sse-reader.ts`); `status`
 * means what it means there, and is `'live'` only while the connection is open and has delivered a
 * frame or the `replayComplete` ping.
 */
import { BUREAU_PATH, getBureauId } from '../bureau-client.ts';
import { computeReconnectDelayMs } from './backoff.ts';
import {
  BUREAU_RESYNC_KIND,
  isRecoveryKind,
  isReplayCompletePing,
  parseBureauEventFrame,
  type BureauEventFrame,
} from './bureau-event-frame.ts';
import { readServerSentEventStream, type ServerSentEventFrame } from './sse-reader.ts';
import type { LiveSource, LiveSourceStatus } from './types.ts';

export interface BureauEventSourceConfig {
  /** Overrides the reconnect backoff curve; tests inject a near-zero function. */
  readonly computeReconnectDelayMs?: (attempt: number) => number;
}

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get('Content-Type');
  if (contentType === null) return false;
  return contentType.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
}

export class BureauEventSource implements LiveSource<BureauEventFrame> {
  status: LiveSourceStatus = $state('closed');

  /** Reconnect attempts since the last frame or ping; `0` while `live`, `connecting` and `closed`. */
  get reconnectAttempt(): number {
    return this.#reconnectAttempt;
  }

  /** True once the current connection's replay has ended (the `replayComplete` ping). Resets at every connect. */
  get caughtUp(): boolean {
    return this.#caughtUp;
  }

  readonly #computeReconnectDelayMs: (attempt: number) => number;
  readonly #subscribers = new Set<(frame: BureauEventFrame) => void>();

  #abortController: AbortController | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempt = 0;
  #caughtUp = $state(false);
  #lastEventId: string | undefined;
  #bureauId: string | undefined;
  /** Whether envelopes were held back, or a cursor dropped, since the last resync was dispatched. */
  #resyncPending = false;
  #closed = false;
  #connected: ReturnType<typeof Promise.withResolvers<void>> = Promise.withResolvers();

  constructor(config: BureauEventSourceConfig = {}) {
    this.#computeReconnectDelayMs = config.computeReconnectDelayMs ?? computeReconnectDelayMs;
    openBureauEventSources.add(this);
  }

  subscribe(onFrame: (frame: BureauEventFrame) => void): () => void {
    this.#subscribers.add(onFrame);
    this.#ensureConnected();

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.#subscribers.delete(onFrame);
      this.#disconnectIfNoSubscribers();
    };
  }

  whenConnected(): Promise<void> {
    return this.#connected.promise;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#subscribers.clear();
    this.#teardownConnection();
    this.status = 'closed';
    this.#connected.resolve();
    openBureauEventSources.delete(this);
  }

  #ensureConnected(): void {
    if (this.#closed || this.#abortController !== null || this.#reconnectTimer !== null) return;
    this.#connected = Promise.withResolvers();
    this.#reconnectAttempt = 0;
    void this.#connect();
  }

  #disconnectIfNoSubscribers(): void {
    if (this.#subscribers.size > 0 || this.#closed) return;
    this.#teardownConnection();
    this.status = 'closed';
  }

  #teardownConnection(): void {
    this.#abortController?.abort();
    this.#abortController = null;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  async #connect(): Promise<void> {
    if (this.#closed) return;
    this.status = this.#reconnectAttempt === 0 ? 'connecting' : 'reconnecting';
    this.#caughtUp = false;

    const controller = new AbortController();
    this.#abortController = controller;
    try {
      const shouldReconnect = await this.#fetchAndDrain(controller);
      if (shouldReconnect) this.#scheduleReconnect();
    } finally {
      if (this.#abortController === controller) this.#abortController = null;
    }
  }

  /** Opens the stream and drains it. Returns whether to schedule a reconnect (false for an explicit close). */
  async #fetchAndDrain(controller: AbortController): Promise<boolean> {
    try {
      this.#bureauId ??= await getBureauId({ signal: controller.signal });
      const response = await fetch(this.#eventsUrl(this.#bureauId), {
        headers: this.#requestHeaders(),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.#startOver();
        return true;
      }
      if (!isEventStreamResponse(response)) return true;

      for await (const frame of readServerSentEventStream(response, controller.signal)) {
        this.#handleFrame(frame);
        if (this.#closed) return false;
      }
      return !controller.signal.aborted;
    } catch {
      return !controller.signal.aborted;
    }
  }

  /** A refusal says the cursor or the id it named may be wrong: ask again from nothing, and resync once caught up. */
  #startOver(): void {
    this.#bureauId = undefined;
    if (this.#lastEventId !== undefined) {
      this.#lastEventId = undefined;
      this.#resyncPending = true;
    }
  }

  #eventsUrl(bureauId: string): string {
    return `${BUREAU_PATH}/v1/subscriptions/bureau.events?${new URLSearchParams({ bureauId }).toString()}`;
  }

  #requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (this.#lastEventId !== undefined) headers['Last-Event-ID'] = this.#lastEventId;
    return headers;
  }

  #handleFrame(frame: ServerSentEventFrame): void {
    if (frame.event === 'ping') {
      this.#reconnectAttempt = 0;
      if (isReplayCompletePing(frame.data)) {
        this.#markLive();
        this.#caughtUp = true;
        this.#flushResync();
      }
      return;
    }
    // `event: error` precedes the server closing the stream; the end of the stream that follows
    // drives the same reconnect path as any other drop.
    if (frame.event === 'error') return;

    const envelope = parseBureauEventFrame(frame.data);
    if (envelope === null) return;
    this.#lastEventId = frame.id ?? envelope.cursor;
    this.#reconnectAttempt = 0;
    this.#markLive();
    if (!this.#caughtUp && !isRecoveryKind(envelope.kind)) {
      // Replay backlog: held back, and answered by one resync when the replay ends.
      this.#resyncPending = true;
      return;
    }
    this.#dispatch(envelope);
  }

  #flushResync(): void {
    if (!this.#resyncPending) return;
    this.#resyncPending = false;
    this.#dispatch({
      kind: BUREAU_RESYNC_KIND,
      sequence: -1,
      cursor: this.#lastEventId ?? '-1',
      emittedAtMs: Date.now(),
      payload: {},
    });
  }

  #markLive(): void {
    this.status = 'live';
    this.#connected.resolve();
  }

  #dispatch(envelope: BureauEventFrame): void {
    for (const subscriber of this.#subscribers) subscriber(envelope);
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#subscribers.size === 0) return;
    this.status = 'reconnecting';
    this.#reconnectAttempt += 1;
    const delay = this.#computeReconnectDelayMs(this.#reconnectAttempt);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connect();
    }, delay);
  }
}

// HMR safety, as `FleetEventSource`: close every open instance before a hot module swap.
const openBureauEventSources = new Set<BureauEventSource>();

import.meta.hot?.dispose(() => {
  for (const source of openBureauEventSources) source.close();
  openBureauEventSources.clear();
});
