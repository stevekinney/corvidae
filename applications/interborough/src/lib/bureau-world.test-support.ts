/**
 * A stand-in for the Bureau's tasks and reviews, for the component tests of the Tasks area and of
 * `/reviews`. It holds a list of tasks and a list of reviews, answers each JSON-RPC operation from
 * them (a missing one is the `NotFound` fault the Bureau answers), serves the one subscription a
 * task page follows as a stream the test pushes elements into, and records every call. A test that
 * needs an operation to answer otherwise replaces its handler with `on`. The real Bureau is
 * exercised end to end in the Playwright suite; this is for the components' own branches.
 */
import type { ReviewListEntry } from '@lostgradient/weft';

import { contextDetailFixture } from './bureau-fixtures.test-support.ts';
import type { BureauReview } from './bureau-reviews.ts';
import {
  StubFault,
  urlOf,
  type BureauCall,
  type BureauHandler,
} from './bureau-stub.test-support.ts';
import type { TaskView } from './bureau-tasks.ts';
import { installFetchImplementation } from './live-source/fetch.test-support.ts';

/** One open subscription, and what a test does to it. */
export type StreamControl = {
  readonly taskId: string;
  /** The `Last-Event-ID` the subscription asked to resume from, if it asked for one. */
  readonly lastEventId: string | null;
  /** Sends one element, as the Bureau does: its cursor is the frame's `id`. */
  push(element: Record<string, unknown>): void;
  /** Ends the stream cleanly, as the Bureau does after a task's terminal status. */
  end(): void;
  /** Breaks the connection, as a network drop does. */
  drop(): void;
};

export type BureauWorld = {
  tasks: TaskView[];
  reviews: BureauReview[];
  /**
   * The chat sessions `bureau.contexts.get` knows, by identifier. Left out, every task's
   * `contextId` is one; a catalog task's is its run handle, which no session has.
   */
  contexts?: readonly string[];
  /** The engine's reviews, which `GET /v1/reviews` answers by status. Empty unless a test sets some. */
  weftReviews: ReviewListEntry[];
};

export type BureauWorldStub = {
  readonly calls: BureauCall[];
  callsTo(method: string): BureauCall[];
  /** Replaces what a method answers. */
  on(method: string, handler: BureauHandler): void;
  /** Every request made to the engine's reviews, so a test can say the page never asked. */
  readonly weftRequests: URL[];
  /** Every decision submitted on one of the engine's reviews, by review identifier. */
  readonly weftDecisions: Array<{ reviewId: string; body: unknown }>;
  /** Every subscription the page has opened, in order. */
  readonly streams: StreamControl[];
  /** The task of every subscription the page asked for, answered or not, so a test can say it never asked. */
  readonly streamRequests: string[];
  /** Makes the next subscriptions refuse with this status, or fail to connect when `'offline'`. */
  refuseStreams(status: number | 'offline' | undefined): void;
  restore(): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const notFound = (resource: string, id: string) =>
  new StubFault('NotFound', 404, `No ${resource} with id "${id}"`, { resource, identifier: id });

export function emptyBureauWorld(overrides: Partial<BureauWorld> = {}): BureauWorld {
  return { tasks: [], reviews: [], weftReviews: [], ...overrides };
}

function defaultHandlers(world: BureauWorld): Record<string, BureauHandler> {
  return {
    'bureau.tasks.list': (params) => {
      const limit = typeof params['limit'] === 'number' ? params['limit'] : 50;
      // The token is the position the page starts at: the stub's world does not change mid-listing.
      const offset = typeof params['pageToken'] === 'string' ? Number(params['pageToken']) : 0;
      const matching = world.tasks.filter(
        (task) =>
          (params['contextId'] === undefined || task.contextId === params['contextId']) &&
          (params['agentName'] === undefined || task.agentName === params['agentName']) &&
          (params['status'] === undefined || task.status === params['status']),
      );
      const page = matching.slice(offset, offset + limit);
      return {
        tasks: page,
        nextPageToken: offset + page.length < matching.length ? String(offset + page.length) : null,
      };
    },
    'bureau.tasks.get': (params) => {
      const id = String(params['taskId']);
      const task = world.tasks.find((entry) => entry.id === id);
      if (task === undefined) throw notFound('task', id);
      return task;
    },
    'bureau.contexts.get': (params) => {
      const id = String(params['contextId']);
      const known =
        world.contexts === undefined
          ? world.tasks.some((task) => task.contextId === id)
          : world.contexts.includes(id);
      if (!known) throw notFound('context', id);
      return contextDetailFixture(id);
    },
    'bureau.reviews.list': () => ({
      reviews: world.reviews.filter((review) => review.status === 'pending'),
    }),
    'bureau.reviews.get': (params) => {
      const id = String(params['id']);
      const review = world.reviews.find((entry) => entry.id === id);
      if (review === undefined) throw notFound('review', id);
      return review;
    },
    'bureau.reviews.resolve': (params) => {
      const id = String(params['id']);
      const review = world.reviews.find((entry) => entry.id === id);
      if (review === undefined) throw notFound('review', id);
      world.reviews = world.reviews.filter((entry) => entry.id !== id);
      return { id, kind: review.kind, decision: params['decision'], receipt: 'applied' };
    },
  };
}

/** Installs the stub over `fetch`. Anything it does not serve is answered 404. */
export function installBureauWorld(world: BureauWorld): BureauWorldStub {
  const table = new Map(Object.entries(defaultHandlers(world)));
  const calls: BureauCall[] = [];
  const streams: StreamControl[] = [];
  const streamRequests: string[] = [];
  const weftRequests: URL[] = [];
  const weftDecisions: Array<{ reviewId: string; body: unknown }> = [];
  let refusal: number | 'offline' | undefined;
  const encoder = new TextEncoder();

  const restoreFetch = installFetchImplementation(async (input, init) => {
    const url = new URL(urlOf(input), 'http://localhost');
    if (url.pathname === '/bureau/v1/subscriptions/bureau.tasks.events') {
      if (refusal === 'offline') throw new TypeError('Failed to fetch');
      if (refusal !== undefined) {
        return Response.json({ error: 'The Bureau refused the stream.' }, { status: refusal });
      }
      const taskId = url.searchParams.get('taskId') ?? '';
      streamRequests.push(taskId);
      if (!world.tasks.some((task) => task.id === taskId)) {
        return Response.json({ error: `No task with id "${taskId}"` }, { status: 404 });
      }
      const lastEventId = new Headers(init?.headers).get('last-event-id');
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let closed = false;
      const body = new ReadableStream<Uint8Array>({
        start(started) {
          controller = started;
        },
      });
      const stream: StreamControl = {
        taskId,
        lastEventId,
        push(element) {
          if (closed) return;
          const cursor = typeof element['cursor'] === 'string' ? `id: ${element['cursor']}\n` : '';
          controller?.enqueue(
            encoder.encode(
              `${cursor}event: ${String(element['kind'])}\ndata: ${JSON.stringify(element)}\n\n`,
            ),
          );
        },
        end() {
          if (closed) return;
          closed = true;
          controller?.close();
        },
        drop() {
          if (closed) return;
          closed = true;
          controller?.error(new TypeError('network error'));
        },
      };
      init?.signal?.addEventListener('abort', () => {
        if (closed) return;
        closed = true;
        controller?.error(new DOMException('The request was aborted.', 'AbortError'));
      });
      streams.push(stream);
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    const decision = /\/v1\/reviews\/([^/]+)\/decision$/.exec(url.pathname);
    if (decision !== null && init?.method === 'POST') {
      const reviewId = decodeURIComponent(decision[1] ?? '');
      weftDecisions.push({
        reviewId,
        body: JSON.parse(typeof init.body === 'string' ? init.body : '{}'),
      });
      world.weftReviews = world.weftReviews.filter(
        (entry) => !(entry.status === 'pending' && entry.reviewId === reviewId),
      );
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith('/v1/reviews') && init?.method !== 'POST') {
      weftRequests.push(url);
      const status = url.searchParams.get('status');
      return Response.json({
        items: world.weftReviews.filter((entry) => status === null || entry.status === status),
      });
    }
    if (url.pathname !== '/bureau/jsonrpc' || typeof init?.body !== 'string') {
      return new Response('Not found', { status: 404 });
    }
    const parsed: unknown = JSON.parse(init.body);
    const body = isRecord(parsed) ? parsed : {};
    const method = String(body['method']);
    const params = isRecord(body['params']) ? body['params'] : {};
    calls.push({ method, params });
    const handler = table.get(method);
    if (handler === undefined) {
      return Response.json({ error: `The stub has no handler for ${method}.` }, { status: 500 });
    }
    try {
      return Response.json({ jsonrpc: '2.0', id: body['id'], result: await handler(params) });
    } catch (error) {
      if (!(error instanceof StubFault)) throw error;
      return Response.json({
        jsonrpc: '2.0',
        id: body['id'],
        error: {
          code: -32000,
          message: error.message,
          data: { ...error.data, weftCode: error.weftCode, httpStatus: error.httpStatus },
        },
      });
    }
  });

  return {
    calls,
    callsTo: (method) => calls.filter((call) => call.method === method),
    on: (method, handler) => {
      table.set(method, handler);
    },
    streams,
    streamRequests,
    weftRequests,
    weftDecisions,
    refuseStreams: (status) => {
      refusal = status;
    },
    restore: () => {
      for (const stream of streams) stream.end();
      restoreFetch();
    },
  };
}

/** A `task.status` element, as the Bureau sends one. */
export function statusElement(
  taskId: string,
  cursor: string,
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    taskId,
    cursor,
    emittedAtMs: 1,
    kind: 'task.status',
    status,
    finishReason: null,
    message: null,
    artifact: null,
    ...extra,
  };
}

/** A `task.snapshot` element: its cursor is the snapshot's, which names no position to resume from. */
export function snapshotElement(
  taskId: string,
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    taskId,
    cursor: '-1',
    emittedAtMs: 1,
    kind: 'task.snapshot',
    status,
    finishReason: null,
    message: null,
    ...extra,
  };
}
