/**
 * What the route component tests share: a Bureau that answers each JSON-RPC operation from a
 * table, and a happy-dom window with a real origin to navigate in.
 */
import { Window } from 'happy-dom';

import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { router } from '../../lib/router.svelte.ts';

export const CONTEXT = {
  id: 'session-1',
  owner: 'anonymous:local',
  agentName: 'assistant',
  title: 'Plan the week',
  lastMessagePreview: 'Sounds good.',
  parentContextId: null,
  forkedFromMessageId: null,
  model: null,
  effort: null,
  permissionMode: 'on-changes',
  configVersion: 0,
  messageCount: 2,
  createdAt: '2026-10-19T08:00:00.000Z',
  updatedAt: '2026-10-19T09:00:00.000Z',
  activity: 'idle',
};

export const AGENT = {
  name: 'assistant',
  displayName: 'Assistant',
  description: 'Answers every message.',
  definitionRevision: 3,
  kind: 'code',
  a2a: false,
};

export type Call = { method: string; params: Record<string, unknown> };

/** Answers each Bureau operation by name, records the calls, and says no to anything else. */
export function bureau(
  answers: Record<string, (params: Record<string, unknown>) => unknown>,
  other: (url: string, init?: RequestInit) => Response | undefined = () => undefined,
): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const restore = installFetchImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const own = other(url, init);
    if (own !== undefined) return own;
    const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    const method = typeof body === 'object' && body !== null ? Reflect.get(body, 'method') : '';
    const params: unknown =
      typeof body === 'object' && body !== null ? Reflect.get(body, 'params') : {};
    const record: Record<string, unknown> =
      typeof params === 'object' && params !== null
        ? Object.fromEntries(Object.entries(params))
        : {};
    calls.push({ method: String(method), params: record });
    const answer = answers[String(method)];
    if (answer === undefined)
      return Response.json({ error: `unexpected ${String(method)}` }, { status: 500 });
    try {
      return Response.json({ jsonrpc: '2.0', id: method, result: answer(record) });
    } catch (error) {
      // A handler may fail as the Bureau does: a wire fault code, its status and its payload.
      if (!(error instanceof StubFault)) throw error;
      return Response.json({
        jsonrpc: '2.0',
        id: method,
        error: {
          code: -32000,
          message: error.message,
          data: { ...error.data, weftCode: error.weftCode, httpStatus: error.httpStatus },
        },
      });
    }
  });
  return { calls, restore };
}

/** Gives happy-dom's `about:blank` window a real origin, so `pushState` takes effect, at `path`. */
export function landAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}
