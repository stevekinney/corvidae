import type { ServerLoadEvent } from '@lostgradient/velveteen/server';
import { expect, test } from 'bun:test';
import { load } from '../private-routes/reviews/+page.server.ts';

test('loads only the request principal and the two scoped Reviews pages', async () => {
  const requests: { path: string; method?: string; params?: unknown }[] = [];
  const signal = new AbortController().signal;
  let cacheControl = '';
  const data = await load({
    signal,
    url: new URL('https://example.test/reviews'),
    setHeaders: (headers: Record<string, string>) => (cacheControl = headers['cache-control']!),
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const path = input instanceof Request ? input.url : input.toString();
      if (path === '/api/v1/principal') {
        requests.push({ path });
        return Response.json({
          method: 'browser-session',
          subject: 'alice',
          scopes: ['reviews:read'],
          workspace: { workspaceId: 'one', actorId: 'alice', membershipRevision: '1' },
        });
      }
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON-RPC body');
      const body = JSON.parse(init.body) as { method: string; params: unknown };
      requests.push({ path, method: body.method, params: body.params });
      expect(init?.signal).toBe(signal);
      return Response.json({
        jsonrpc: '2.0',
        id: body.method,
        result: { reviews: [], nextPageToken: null, total: 0 },
      });
    },
  } as unknown as ServerLoadEvent);
  expect(cacheControl).toBe('private, no-store');
  expect(data.seed.scope).toBe(JSON.stringify(['one', 'alice', 'alice', ['reviews:read']]));
  expect(requests).toEqual([
    { path: '/api/v1/principal' },
    { path: '/jsonrpc', method: 'bureau.reviews.list', params: { status: 'pending', limit: 100 } },
    { path: '/jsonrpc', method: 'bureau.reviews.list', params: { status: 'resolved', limit: 25 } },
  ]);
});
