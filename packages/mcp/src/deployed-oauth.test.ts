import { expect, test } from 'bun:test';
import { prepareOAuth } from './deployed-oauth';
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
  await expect(
    prepareOAuth(
      { origin: 'https://example.com', path: '/mcp', scopes: ['read'] },
      'http://127.0.0.1:4321/callback',
      'https://identity.example',
      request,
    ),
  ).rejects.toThrow('Issuer mismatch');
});
