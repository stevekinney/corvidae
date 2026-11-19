/**
 * The end-to-end specs rewrite what the Bureau answers the page through
 * `e2e/bureau-answer-support.ts`. Its route has to match the URL the page's generated Bureau
 * client posts to: a route on `/bureau/jsonrpc`, which the page no longer calls, matched nothing,
 * and three specs silently showed the unrewritten world. Playwright does not run on every host, so
 * this holds the route to the transport's own request and drives its handler with a stand-in route.
 */
import { describe, expect, test } from 'bun:test';

import type { Page, Route } from '@playwright/test';

import { bureauTransport } from '../src/lib/bureau-transport.ts';
import { isBureauCall, rewriteBureauAnswer } from './e2e/bureau-answer-support.ts';

const ORIGIN = 'http://127.0.0.1:4100';

/** The URL the generated client's transport posts `method` to, read from the request it makes. */
async function requestedUrl(method: string): Promise<URL> {
  let requested = '';
  const transport = bureauTransport({
    baseUrl: '',
    fetch: (input) => {
      requested = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(Response.json({ jsonrpc: '2.0', id: method, result: {} }));
    },
  });
  await transport(method, {}, undefined);
  return new URL(requested, ORIGIN);
}

type Handler = (route: Route) => Promise<void>;

/** A page that keeps the one route a helper registers, so a test can call its handler. */
function pageKeepingRoute(): { page: Page; handler: () => Handler } {
  let kept: Handler | undefined;
  const page = {
    route: (_matcher: unknown, handler: Handler) => {
      kept = handler;
      return Promise.resolve();
    },
  };
  return {
    page: page as unknown as Page,
    handler: () => {
      if (kept === undefined) throw new Error('No route was registered.');
      return kept;
    },
  };
}

/** A route for a call to `method` whose real answer is `result`, recording what the handler did. */
function routeFor(method: string, result: Record<string, unknown>) {
  const done: { fallback: boolean; fulfilled?: unknown } = { fallback: false };
  const route = {
    request: () => ({ postData: () => JSON.stringify({ jsonrpc: '2.0', id: 1, method }) }),
    fallback: () => {
      done.fallback = true;
      return Promise.resolve();
    },
    fetch: () => Promise.resolve(Response.json({ jsonrpc: '2.0', id: 1, result })),
    fulfill: (options: { json: unknown }) => {
      done.fulfilled = options.json;
      return Promise.resolve();
    },
  };
  return { route: route as unknown as Route, done };
}

describe('the specs’ Bureau answer rewrite', () => {
  test('matches the URL the generated client posts every Bureau call to', async () => {
    for (const method of ['bureau.goals.get', 'bureau.tasks.list', 'bureau.workflows.runs.get']) {
      expect(isBureauCall(await requestedUrl(method))).toBe(true);
    }
  });

  test('does not match the old /bureau/jsonrpc path, or another of the host’s routes', () => {
    expect(isBureauCall(new URL('/bureau/jsonrpc', ORIGIN))).toBe(false);
    expect(isBureauCall(new URL('/bureau/v1/subscriptions/bureau.events', ORIGIN))).toBe(false);
  });

  test('rewrites the named operation’s result and passes every other call on', async () => {
    const { page, handler } = pageKeepingRoute();
    await rewriteBureauAnswer(page, 'bureau.goals.get', (goal) => ({
      ...goal,
      status: 'evaluating',
    }));

    const named = routeFor('bureau.goals.get', { goalRunId: 'goal-1', status: 'canceled' });
    await handler()(named.route);
    expect(named.done.fallback).toBe(false);
    expect(named.done.fulfilled).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { goalRunId: 'goal-1', status: 'evaluating' },
    });

    const other = routeFor('bureau.tasks.list', { tasks: [] });
    await handler()(other.route);
    expect(other.done.fallback).toBe(true);
    expect(other.done.fulfilled).toBeUndefined();
  });
});
