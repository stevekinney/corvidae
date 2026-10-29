/**
 * Stands in for the two server-sent event feeds the shell opens, for tests of the code that follows
 * them: the Bureau's (`/bureau/v1/subscriptions/bureau.events`) and the engine's fleet feed
 * (`/v1/events/sse`). A test routes a request to {@link EventStreamHub.handle} from its own `fetch`
 * stub; the hub answers a feed's request with a stream the test then writes to, and records the
 * `Last-Event-ID` and the URL of each request.
 */

export type FeedName = 'bureau' | 'fleet';

export interface FeedRequest {
  readonly url: string;
  readonly lastEventId: string | undefined;
}

interface OpenStream {
  readonly request: FeedRequest;
  push(chunk: string): void;
  end(): void;
}

const FEED_PATHS: ReadonlyArray<readonly [FeedName, string]> = [
  ['bureau', '/bureau/v1/subscriptions/bureau.events'],
  ['fleet', '/v1/events/sse'],
];

export function feedOf(url: string): FeedName | undefined {
  const { pathname } = new URL(url, 'http://localhost');
  return FEED_PATHS.find(([, path]) => pathname === path)?.[0];
}

/** One envelope as a feed writes it: `id`, `event` and `data` lines. */
export function envelopeChunk(envelope: {
  readonly kind: string;
  readonly cursor: string;
  readonly [key: string]: unknown;
}): string {
  const full = { sequence: 1, emittedAtMs: 0, payload: {}, ...envelope };
  return `id: ${envelope.cursor}\nevent: ${envelope.kind}\ndata: ${JSON.stringify(full)}\n\n`;
}

/** The ping that ends a feed's replay. */
export const REPLAY_COMPLETE_CHUNK = `event: ping\ndata: ${JSON.stringify({
  emittedAtMs: 0,
  replayComplete: true,
})}\n\n`;

export class EventStreamHub {
  readonly requests: Record<FeedName, FeedRequest[]> = { bureau: [], fleet: [] };
  /** A status to refuse the next request of a feed with, instead of opening a stream. */
  readonly refusals: Partial<Record<FeedName, number>> = {};
  readonly #open: Record<FeedName, OpenStream[]> = { bureau: [], fleet: [] };
  readonly #encoder = new TextEncoder();

  /** Answers a request to either feed, or returns `undefined` for any other URL. */
  handle(input: RequestInfo | URL, init?: RequestInit): Response | undefined {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const feed = feedOf(url);
    if (feed === undefined) return undefined;
    const request: FeedRequest = {
      url,
      lastEventId: new Headers(init?.headers).get('last-event-id') ?? undefined,
    };
    this.requests[feed].push(request);
    const refusal = this.refusals[feed];
    if (refusal !== undefined) {
      delete this.refusals[feed];
      return Response.json({ error: 'refused' }, { status: refusal });
    }
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      start: (started) => {
        controller = started;
      },
    });
    const close = () => {
      if (closed) return;
      closed = true;
      try {
        controller?.close();
      } catch {
        // Already closed by the reader's abort.
      }
    };
    init?.signal?.addEventListener('abort', close, { once: true });
    this.#open[feed].push({
      request,
      push: (chunk) => {
        if (!closed) controller?.enqueue(this.#encoder.encode(chunk));
      },
      end: close,
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  }

  /** How many streams the feed has been asked for. */
  opened(feed: FeedName): number {
    return this.#open[feed].length;
  }

  /** Writes to the feed's newest stream. */
  write(feed: FeedName, ...chunks: string[]): void {
    const stream = this.#open[feed].at(-1);
    if (stream === undefined) throw new Error(`The ${feed} feed has not been asked for a stream.`);
    for (const chunk of chunks) stream.push(chunk);
  }

  /** Ends the feed's newest stream, as a dropped connection does. */
  end(feed: FeedName): void {
    this.#open[feed].at(-1)?.end();
  }

  /** Ends every stream, so a test leaves nothing open. */
  endAll(): void {
    for (const feed of ['bureau', 'fleet'] as const) {
      for (const stream of this.#open[feed]) stream.end();
    }
  }
}
