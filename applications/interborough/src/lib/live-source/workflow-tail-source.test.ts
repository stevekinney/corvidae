import { quietFor } from '@lostgradient/testing/wait-until';
import {
  WorkflowCompletedEvent,
  WorkflowStartedEvent,
  type WorkflowEvent,
} from '@lostgradient/weft';
import { waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { installFetchImplementation } from './fetch.test-support.ts';
import { WorkflowTailSource } from './workflow-tail-source.svelte.ts';

interface FetchCall {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** One scripted SSE connection the test drives by hand: `push` writes raw SSE text, `drop` ends the stream the way a severed connection does. */
class ScriptedConnection {
  readonly response: Response;
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  readonly #encoder = new TextEncoder();
  #ended = false;

  constructor(signal: AbortSignal | undefined) {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
        signal?.addEventListener('abort', () => this.drop(), { once: true });
      },
    });
    this.response = new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  }

  push(chunk: string): void {
    if (!this.#ended) this.#controller?.enqueue(this.#encoder.encode(chunk));
  }

  drop(): void {
    if (this.#ended) return;
    this.#ended = true;
    try {
      this.#controller?.close();
    } catch {
      // Already closed or errored.
    }
  }
}

/** Scripts `globalThis.fetch`, recording every request so tests can assert the URL and the `Last-Event-ID` each (re)connect sent. */
class ScriptedFetch {
  readonly calls: FetchCall[] = [];
  readonly connections: ScriptedConnection[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  readonly #restore: () => void;
  #respond: ((signal: AbortSignal | undefined) => Response) | null = null;

  constructor() {
    this.#restore = installFetchImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      this.signals.push(init?.signal ?? undefined);
      this.calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      if (this.#respond !== null) return this.#respond(init?.signal ?? undefined);
      const connection = new ScriptedConnection(init?.signal ?? undefined);
      this.connections.push(connection);
      return connection.response;
    });
  }

  /** Answers every request with `respond` instead of a scripted connection. */
  respondWith(respond: (signal: AbortSignal | undefined) => Response): void {
    this.#respond = respond;
  }

  restore(): void {
    this.#restore();
  }
}

function envelope(cursor: string, kind: string, payload: Record<string, unknown> = {}): string {
  const body = {
    kind,
    workflowId: 'wf_1',
    selector: 'events',
    sequence: Number(cursor.replace(/\D/g, '')),
    cursor,
    emittedAtMs: 1_000,
    payload,
  };
  return `id: ${cursor}\nevent: ${kind}\ndata: ${JSON.stringify(body)}\n\n`;
}

const REPLAY_COMPLETE = `event: ping\ndata: ${JSON.stringify({ emittedAtMs: 0, replayComplete: true })}\n\n`;

let scripted: ScriptedFetch;

function open(options: ConstructorParameters<typeof WorkflowTailSource>[2] = {}) {
  return new WorkflowTailSource(
    { baseUrl: 'http://weft.test/', headers: { Authorization: 'Bearer test' } },
    'wf_1',
    { computeReconnectDelayMs: () => 1, ...options },
  );
}

afterEach(() => {
  scripted.restore();
});

describe('WorkflowTailSource', () => {
  const setup = () => {
    scripted = new ScriptedFetch();
  };

  test('requests the per-workflow SSE URL with the caller headers and no cursor on first connect', async () => {
    setup();
    const source = open();
    await waitFor(() => expect(scripted.calls).toHaveLength(1));
    expect(scripted.calls[0]?.url).toBe('http://weft.test/v1/workflows/wf_1/events/sse');
    expect(scripted.calls[0]?.headers['authorization']).toBe('Bearer test');
    expect(scripted.calls[0]?.headers['accept']).toBe('text/event-stream');
    expect(scripted.calls[0]?.headers['last-event-id']).toBeUndefined();
    expect(source.status).toBe('connecting');
    source.close();
  });

  test('whenConnected resolves and status becomes live once the replay completes', async () => {
    setup();
    const source = open();
    await waitFor(() => expect(scripted.connections).toHaveLength(1));
    scripted.connections[0]?.push(REPLAY_COMPLETE);
    await source.whenConnected();
    expect(source.status).toBe('live');
    source.close();
  });

  test('delivers frames pushed after subscribe, in order, as WorkflowEvents', async () => {
    setup();
    const source = open();
    const received: WorkflowEvent[] = [];
    source.subscribe((frame) => received.push(frame));
    await waitFor(() => expect(scripted.connections).toHaveLength(1));
    scripted.connections[0]?.push(envelope('c1', 'activity:started', { name: 'a' }));
    scripted.connections[0]?.push(envelope('c2', 'activity:completed', { name: 'a' }));

    await waitFor(() => expect(received).toHaveLength(2));
    expect(received).toEqual([
      { type: 'activity:started', timestamp: 1_000, data: { name: 'a' } },
      { type: 'activity:completed', timestamp: 1_000, data: { name: 'a' } },
    ]);
    source.close();
  });

  test('ignores frames for another workflow and malformed frames', async () => {
    setup();
    const source = open();
    const received: WorkflowEvent[] = [];
    source.subscribe((frame) => received.push(frame));
    await waitFor(() => expect(scripted.connections).toHaveLength(1));
    const other = envelope('c1', 'activity:started').replace('"wf_1"', '"wf_other"');
    scripted.connections[0]?.push(other);
    scripted.connections[0]?.push('id: c2\nevent: activity:started\ndata: not json\n\n');
    scripted.connections[0]?.push(envelope('c3', 'activity:completed'));

    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.type).toBe('activity:completed');
    source.close();
  });

  test('buffers frames that arrive before subscribe(), then flushes them in order on subscribe', async () => {
    setup();
    const source = open();
    await waitFor(() => expect(scripted.connections).toHaveLength(1));
    scripted.connections[0]?.push(envelope('c1', 'activity:started'));
    scripted.connections[0]?.push(envelope('c2', 'activity:completed'));
    scripted.connections[0]?.push(REPLAY_COMPLETE);
    await source.whenConnected();
    await waitFor(() => expect(source.status).toBe('live'));

    const received: WorkflowEvent[] = [];
    source.subscribe((frame) => received.push(frame));
    expect(received.map((e) => e.type)).toEqual(['activity:started', 'activity:completed']);
    source.close();
  });

  test('drops the oldest buffered frame and reports "stale" once the pre-attach buffer overflows', async () => {
    setup();
    const source = open({ bufferLimit: 3 });
    await waitFor(() => expect(scripted.connections).toHaveLength(1));
    for (let index = 0; index < 5; index += 1) {
      scripted.connections[0]?.push(envelope(`c${index}`, 'activity:started', { index }));
    }
    await waitFor(() => expect(source.status).toBe('stale'));

    const received: WorkflowEvent[] = [];
    source.subscribe((frame) => received.push(frame));
    // Only the last 3 of 5 survive the bounded buffer.
    expect(received.map((e) => e.data['index'])).toEqual([2, 3, 4]);
    expect(source.status).toBe('live'); // subscribing clears the stale flag
    source.close();
  });

  test('subscribe throws when a subscriber is already attached; unsubscribing frees the slot', () => {
    setup();
    const source = open();
    const unsubscribe = source.subscribe(() => {});
    expect(() => source.subscribe(() => {})).toThrow(/only one subscriber/);

    unsubscribe();
    expect(() => source.subscribe(() => {})).not.toThrow();
    source.close();
  });

  test('reconnects mid-stream from the last cursor: no event is delivered twice and none is skipped', async () => {
    setup();
    const source = open();
    const received: WorkflowEvent[] = [];
    source.subscribe((frame) => received.push(frame));
    await waitFor(() => expect(scripted.connections).toHaveLength(1));
    scripted.connections[0]?.push(envelope('c1', 'step:one'));
    scripted.connections[0]?.push(envelope('c2', 'step:two'));
    scripted.connections[0]?.push(REPLAY_COMPLETE);
    await waitFor(() => expect(received).toHaveLength(2));

    // The connection is severed mid-stream. The server replays strictly after
    // the `Last-Event-ID` it is given, so the second connection carries only
    // what the first never delivered.
    scripted.connections[0]?.drop();
    await waitFor(() => expect(scripted.connections).toHaveLength(2));
    expect(scripted.calls[1]?.headers['last-event-id']).toBe('c2');
    scripted.connections[1]?.push(envelope('c3', 'step:three'));
    scripted.connections[1]?.push(envelope('c4', 'step:four'));
    await waitFor(() => expect(received).toHaveLength(4));

    // A second drop resumes from the newest cursor, not the first reconnect's.
    scripted.connections[1]?.drop();
    await waitFor(() => expect(scripted.connections).toHaveLength(3));
    expect(scripted.calls[2]?.headers['last-event-id']).toBe('c4');
    scripted.connections[2]?.push(envelope('c5', 'step:five'));
    await waitFor(() => expect(received).toHaveLength(5));

    expect(received.map((e) => e.type)).toEqual([
      'step:one',
      'step:two',
      'step:three',
      'step:four',
      'step:five',
    ]);
    source.close();
  });

  test('keeps the cursor of the last delivered event across a reconnect that delivers nothing', async () => {
    setup();
    const source = open();
    source.subscribe(() => {});
    await waitFor(() => expect(scripted.connections).toHaveLength(1));
    scripted.connections[0]?.push(envelope('c7', 'step:one'));
    await waitFor(() => expect(source.status).toBe('live'));
    scripted.connections[0]?.drop();
    await waitFor(() => expect(scripted.connections).toHaveLength(2));
    scripted.connections[1]?.push(REPLAY_COMPLETE);
    scripted.connections[1]?.drop();
    await waitFor(() => expect(scripted.connections).toHaveLength(3));
    expect(scripted.calls.map((call) => call.headers['last-event-id'])).toEqual([
      undefined,
      'c7',
      'c7',
    ]);
    source.close();
  });

  test('settles to closed (does not reconnect) once a terminal workflow event is observed', async () => {
    setup();
    const source = open();
    const received: WorkflowEvent[] = [];
    source.subscribe((frame) => received.push(frame));
    await waitFor(() => expect(scripted.connections).toHaveLength(1));
    scripted.connections[0]?.push(envelope('c1', WorkflowStartedEvent.type));
    scripted.connections[0]?.push(envelope('c2', WorkflowCompletedEvent.type, { result: 'ok' }));

    await waitFor(() => expect(source.status).toBe('closed'));
    await source.whenConnected();
    expect(received.map((e) => e.type)).toEqual([
      WorkflowStartedEvent.type,
      WorkflowCompletedEvent.type,
    ]);
    expect(scripted.calls).toHaveLength(1);
  });

  test('aborts the request once a terminal workflow event ends the tail', async () => {
    setup();
    const source = open();
    source.subscribe(() => {});
    await waitFor(() => expect(scripted.connections).toHaveLength(1));
    expect(scripted.signals[0]?.aborted).toBe(false);
    scripted.connections[0]?.push(envelope('c1', WorkflowCompletedEvent.type));

    await waitFor(() => expect(source.status).toBe('closed'));
    expect(scripted.signals[0]?.aborted).toBe(true);
  });

  test('status is "reconnecting" during the backoff window after a drop', async () => {
    setup();
    const source = open({ computeReconnectDelayMs: () => 60_000 });
    source.subscribe(() => {});
    await waitFor(() => expect(scripted.connections).toHaveLength(1));
    scripted.connections[0]?.push(REPLAY_COMPLETE);
    await source.whenConnected();
    scripted.connections[0]?.drop();

    await waitFor(() => expect(source.status).toBe('reconnecting'));
    source.close();
  });

  test('a non-event-stream or failed response schedules a reconnect instead of crashing', async () => {
    setup();
    scripted.respondWith(() => new Response('nope', { status: 503 }));
    const source = open();
    await waitFor(() => expect(scripted.calls.length).toBeGreaterThanOrEqual(2));
    expect(source.status).toBe('reconnecting');
    source.close();
  });

  test('a fetch that rejects schedules a reconnect instead of crashing', async () => {
    setup();
    scripted.respondWith(() => {
      throw new Error('transient failure opening the stream');
    });
    const source = open();
    await waitFor(() => expect(scripted.calls.length).toBeGreaterThanOrEqual(2));
    source.close();
  });

  test('close() aborts the request, stops reconnecting, and settles whenConnected', async () => {
    setup();
    const source = open();
    await waitFor(() => expect(scripted.connections).toHaveLength(1));
    source.close();
    expect(source.status).toBe('closed');
    await source.whenConnected();
    expect(() => source.close()).not.toThrow();
    await quietFor(50);
    expect(scripted.calls).toHaveLength(1);
  });
});
