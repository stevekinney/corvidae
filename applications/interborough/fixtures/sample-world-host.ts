/**
 * How the sample world's seed (`sample-world-seed.ts`) acts on a host: as a person does, over HTTP
 * as the uncredentialed local caller, so the audit log says "You". Each helper is one thing a
 * person or a page does: call the Bureau's or Weft's JSON-RPC plane, send a chat message over
 * AG-UI, find the review a chat waits on, or wait for a chat's run to finish.
 *
 * @module sample-world-host
 */

import { waitUntil } from '@lostgradient/testing/wait-until';

import type { Host } from '../src/host/host.ts';
import type { OffsetRuntime } from '../src/host/offset-runtime.ts';
import type { ShowcasePacing } from '../src/host/showcase-agents.ts';

/** An instant of the story in Central time, from its local date and time and its UTC offset. */
export const central = (local: string, offset: '-05:00' | '-06:00'): number =>
  Date.parse(`${local}${offset}`);

/** A fault the host answered a JSON-RPC call with. */
export class HostFault extends Error {}

/** One JSON-RPC call to `path` on the host, as the local caller; a fault throws. */
async function jsonRpc<T>(
  host: Host,
  path: string,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(new URL(path, host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  });
  const body = (await response.json()) as {
    result?: T;
    error?: { message?: string; data?: unknown };
  };
  if (body.error !== undefined) {
    const data = body.error.data === undefined ? '' : ` ${JSON.stringify(body.error.data)}`;
    throw new HostFault(`${method} answered: ${body.error.message ?? 'no message'}${data}`);
  }
  return body.result as T;
}

/** One JSON-RPC call to the host's Bureau plane, as the local caller; a fault throws. */
export function bureauCall<T>(
  host: Host,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return jsonRpc<T>(host, '/bureau/jsonrpc', method, params);
}

/** One JSON-RPC call to the host's Weft plane (the engine's own API), as the local caller. */
export function weftCall<T>(
  host: Host,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return jsonRpc<T>(host, '/jsonrpc', method, params);
}

/** One call to a host route (`/host/…`) with a JSON body; an answer that isn't 2xx throws. */
export async function hostRequest(
  host: Host,
  method: 'PUT' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(new URL(path, host.url), {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new HostFault(`${method} ${path} answered ${String(response.status)}: ${text}`);
  }
  return text === '' ? null : (JSON.parse(text) as unknown);
}

/**
 * Sends `message` to `agent` in `threadId` over AG-UI, as a person's chat does, and reads the run's
 * stream to its end: the run finished, or parked waiting on a person.
 */
export async function sendChatMessage(
  host: Host,
  agent: string,
  threadId: string,
  message: string,
): Promise<void> {
  const response = await fetch(new URL(`/bureau/ag-ui/agents/${agent}/run`, host.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      threadId,
      runId: `run-${crypto.randomUUID()}`,
      messages: [{ id: `user-${crypto.randomUUID()}`, role: 'user', content: message }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  });
  const stream = await response.text();
  if (response.status !== 200 || stream.includes('RUN_ERROR')) {
    throw new Error(`The run of ${agent} in ${threadId} failed: ${stream.slice(0, 400)}`);
  }
}

/** A review waiting on you, as `bureau.reviews.list` shows it. */
export type ReviewRow = {
  readonly id: string;
  readonly runId: string;
  readonly sessionId?: string;
  readonly round?: number;
};

/** The pending review of the chat `threadId`. */
export async function pendingReviewOf(host: Host, threadId: string): Promise<ReviewRow> {
  const listed = await bureauCall<{ reviews: ReviewRow[] }>(host, 'bureau.reviews.list', {});
  const review = listed.reviews.find((entry) => entry.sessionId === threadId);
  if (review === undefined) throw new Error(`The chat ${threadId} is waiting on no review.`);
  return review;
}

/** Waits until the chat `threadId` has no run in flight and nothing waiting on you. */
export async function waitForIdle(host: Host, threadId: string): Promise<void> {
  await waitUntil(
    async () => {
      const context = await bureauCall<{ activity: string }>(host, 'bureau.contexts.get', {
        contextId: threadId,
      });
      return context.activity === 'idle';
    },
    { message: `the chat ${threadId} to finish its run` },
  );
}

/** A run of the Bureau's engine, as `weft.workflows.list` lists it. */
export type EngineRun = {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly tags?: readonly string[];
};

/** Every run of the host's engine, newest first. */
export async function engineRuns(host: Host): Promise<readonly EngineRun[]> {
  const listed = await weftCall<{ items: EngineRun[] }>(host, 'weft.workflows.list', {
    limit: 500,
  });
  return listed.items;
}

/** The statuses a run of the engine ends in. */
const SETTLED = new Set(['completed', 'failed', 'cancelled']);

/** Waits until the engine holds `count` settled runs that `matches` picks, and answers them. */
export async function waitForSettledRuns(
  host: Host,
  matches: (run: EngineRun) => boolean,
  count: number,
  what: string,
): Promise<readonly EngineRun[]> {
  let found: readonly EngineRun[] = [];
  await waitUntil(
    async () => {
      const runs = await engineRuns(host);
      found = runs.filter((run) => matches(run) && SETTLED.has(run.status));
      return found.length >= count;
    },
    { message: what },
  );
  return found;
}

/**
 * The scene being played: what each scripted answer and goal check waits for while it is on. The
 * seed sets it before the work that needs it and clears it after, so a pace never leaks into the
 * next scene.
 */
export interface Director {
  /** The pace of the scene being played; empty between scenes. */
  scene: ShowcasePacing;
}

/** What a session of the story is handed: its host, the story's clock and the director. */
export interface SessionContext {
  readonly host: Host;
  readonly runtime: OffsetRuntime;
  readonly director: Director;
}
