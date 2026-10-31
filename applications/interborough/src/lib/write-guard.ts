/**
 * Refuses a write while the server is unreachable, at the one place every write to it passes: the
 * request. A change sent to a server that does not answer would fail after the retries, or worse,
 * be queued by the browser and sent later. The refusal is a `ServerUnreachableError`, which the
 * default mutation handler already tells the person in the words of an unreachable fault.
 *
 * The Bureau's operations go through `callBureau` (`./bureau-client.ts`), which asks `refuseWrite`
 * by operation name. Every other request, the Weft client's REST and JSON-RPC calls included,
 * passes `fetch`, which `armWriteGuard` wraps for as long as the shell is mounted, so a write cannot
 * miss the refusal by being made outside the mutation cache (a run's Cancel, a chat's send).
 *
 * A request is classified by what it does, never by who sends it: a `GET`, `HEAD` or `OPTIONS` is a
 * read, a JSON-RPC call is a read when its operation is one of `READ_OPERATIONS`, a workflow query
 * (a `POST` that only reads) is a read, and everything else is a write. An operation or request
 * nobody classified therefore counts as a write: a new write is refused without anyone listing it,
 * and the worst a new read does is wait for the server to come back.
 */
import { untrack } from 'svelte';

import { ServerUnreachableError } from './faults.ts';

/**
 * The last segment of the operations that only read: `bureau.reviews.get`, `weft.workflows.list`,
 * `bureau.audit.query`. Compared case-insensitively. A segment not here is a write.
 */
export const READ_OPERATIONS: ReadonlySet<string> = new Set([
  'aggregate',
  'capabilities',
  'catalog',
  'chunks',
  'deliveries',
  'diagnostics',
  'events',
  'get',
  'inspect',
  'list',
  'metrics',
  'missed',
  'models',
  'principal',
  'query',
  'registry',
  'rejections',
  'revisions',
  'schema',
  'search',
  'subscribeevents',
  'targets',
  'window',
]);

/** What a request does to the server. */
export type RequestKind = 'read' | 'write';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const WORKFLOW_QUERY_PATH = /\/workflows\/[^/]+\/query\/[^/]+$/;

/** Whether the JSON-RPC operation `name` (`bureau.tasks.get`) only reads. */
export function isReadOperation(name: string): boolean {
  const segment = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return READ_OPERATIONS.has(segment);
}

function operationsOf(body: unknown): string[] | undefined {
  if (typeof body !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  const names: string[] = [];
  for (const call of calls as unknown[]) {
    const method =
      typeof call === 'object' && call !== null ? Reflect.get(call, 'method') : undefined;
    if (typeof method !== 'string') return undefined;
    names.push(method);
  }
  return names;
}

/** What a request to `url` with `method` and `body` does. Unclassified means write. */
export function classifyRequest(url: string, method: string, body?: unknown): RequestKind {
  if (SAFE_METHODS.has(method.toUpperCase())) return 'read';
  const path = new URL(url, 'http://localhost').pathname;
  if (path.endsWith('/jsonrpc')) {
    const names = operationsOf(body);
    return names !== undefined && names.length > 0 && names.every(isReadOperation)
      ? 'read'
      : 'write';
  }
  return WORKFLOW_QUERY_PATH.test(path) ? 'read' : 'write';
}

let refusing: (() => boolean) | undefined;

/** Throws `ServerUnreachableError` when the Bureau operation `name` writes and the server is down. */
export function refuseWrite(name: string): void {
  if (refusing?.() === true && !isReadOperation(name)) throw new ServerUnreachableError();
}

function requestParts(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): { url: string; method: string; body: unknown } {
  if (input instanceof Request) {
    return { url: input.url, method: init?.method ?? input.method, body: init?.body };
  }
  const url = input instanceof URL ? input.href : input;
  return { url, method: init?.method ?? 'GET', body: init?.body };
}

/**
 * Wraps `fetch` so a write to this application's own server is refused while `isUnreachable` says
 * the server does not answer, and arms `refuseWrite` the same way. `fetch` and `callBureau` run
 * inside effects and derivations, so `isUnreachable` is read untracked here: a tracked read would
 * make whatever called `fetch` depend on it and run again, restarting a stream it opened, each time
 * the server stops or starts answering. `ownOrigins` are the origins of the server (the page's and
 * the Weft client's base URL); a request to any other origin passes. Returns the function that puts
 * the previous `fetch` back.
 */
export function armWriteGuard(
  isUnreachable: () => boolean,
  ownOrigins: readonly string[],
  target: { fetch: typeof fetch } = globalThis,
): () => void {
  const previousFetch = target.fetch;
  const previousRefusing = refusing;
  const unreachable = (): boolean => untrack(isUnreachable);
  const own = new Set(ownOrigins);
  const guarded = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (unreachable()) {
        const { url, method, body } = requestParts(input, init);
        const origin = new URL(url, globalThis.location?.href ?? 'http://localhost').origin;
        if (own.has(origin) && classifyRequest(url, method, body) === 'write') {
          return Promise.reject(new ServerUnreachableError());
        }
      }
      return previousFetch(input, init);
    },
    { preconnect: previousFetch.preconnect },
  );
  target.fetch = guarded;
  refusing = unreachable;
  return () => {
    if (target.fetch === guarded) target.fetch = previousFetch;
    refusing = previousRefusing;
  };
}
