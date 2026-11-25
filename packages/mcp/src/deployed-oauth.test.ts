import { throwingRejectionOf } from '@lostgradient/testing';
import { expect, test } from 'bun:test';
import { initializeMcp, prepareOAuth } from './deployed-oauth';
import type { ProbeFetch } from './deployed-smoke';

test('registers a loopback client and sends the configured resource and scopes', async () => {
  const calls: URL[] = [];
  const request: ProbeFetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname.includes('.well-known'))
      return Response.json({
        issuer: url.origin,
        registration_endpoint: `${url.origin}/register`,
        authorization_endpoint: `${url.origin}/authorize`,
        token_endpoint: `${url.origin}/token`,
        revocation_endpoint: `${url.origin}/revoke`,
      });
    if (url.pathname === '/register') {
      expect(JSON.parse(typeof init?.body === 'string' ? init.body : '').redirect_uris).toEqual([
        'http://127.0.0.1:4321/callback',
      ]);
      return Response.json({ client_id: 'client' }, { status: 201 });
    }
    if (url.pathname === '/token') {
      expect(
        (init?.body instanceof URLSearchParams ? init.body : new URLSearchParams()).get('resource'),
      ).toBe('https://example.com/api/mcp');
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    return Response.redirect('https://identity.example/login');
  };
  const result = await prepareOAuth(
    { origin: 'https://example.com', path: '/api/mcp', scopes: ['read', 'write'] },
    'http://127.0.0.1:4321/callback',
    'https://identity.example',
    request,
  );
  expect(result.authorization.searchParams.get('scope')).toBe('read write');
  expect(result.authorization.searchParams.get('resource')).toBe('https://example.com/api/mcp');
  expect(result.authorization.searchParams.get('state')).toBe(result.state);
  expect(calls).toHaveLength(4);
});

test('rejects an unexpected issuer', async () => {
  const request: ProbeFetch = async () => Response.json({ issuer: 'https://other.example' });
  expect(
    await throwingRejectionOf(
      prepareOAuth(
        { origin: 'https://example.com', path: '/mcp', scopes: ['read'] },
        'http://127.0.0.1:4321/callback',
        'https://identity.example',
        request,
      ),
    ),
  ).toThrow('Issuer mismatch');
});

test('requires a valid MCP initialize response over JSON or event streams', async () => {
  const fixture =
    (kind: 'json' | 'event-stream' | 'html' | 'rpc-error'): ProbeFetch =>
    async (_input, init) => {
      if (init?.method !== 'POST') return new Response(null, { status: 405 });
      const message = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
        id?: number;
        method?: string;
      };
      if (message.method !== 'initialize') return new Response(null, { status: 202 });
      if (kind === 'html')
        return new Response('<html>not MCP</html>', { headers: { 'content-type': 'text/html' } });
      const payload =
        kind === 'rpc-error'
          ? { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'failed' } }
          : {
              jsonrpc: '2.0',
              id: message.id,
              result: {
                protocolVersion: '2025-03-26',
                capabilities: {},
                serverInfo: { name: 'fixture', version: '1' },
              },
            };
      return new Response(
        kind === 'event-stream'
          ? `event: message\ndata: ${JSON.stringify(payload)}\n\n`
          : JSON.stringify(payload),
        {
          headers: {
            'content-type': kind === 'event-stream' ? 'text/event-stream' : 'application/json',
          },
        },
      );
    };
  await initializeMcp('https://example.com/mcp', 'test-token', fixture('json'));
  await initializeMcp('https://example.com/mcp', 'test-token', fixture('event-stream'));
  expect(
    await throwingRejectionOf(
      initializeMcp('https://example.com/mcp', 'test-token', fixture('html')),
    ),
  ).toThrow();
  expect(
    await throwingRejectionOf(
      initializeMcp('https://example.com/mcp', 'test-token', fixture('rpc-error')),
    ),
  ).toThrow();
});
