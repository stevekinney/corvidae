import { describe, expect, test } from 'bun:test';
import { createProtectedHttpHandler } from './http';

describe('protected HTTP listener', () => {
  test('uses current delegation after a delayed request body', async () => {
    let release!: () => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let delegableScopes = ['write'];
    let writes = 0;
    const handler = createProtectedHttpHandler({
      origin: 'https://equipment.example.com',
      resourcePath: '/api/mcp',
      issuer: 'https://login.example.com',
      scopes: ['write'],
      async verifyAccessToken() {
        return {
          issuer: 'https://login.example.com',
          audience: 'https://equipment.example.com/api/mcp',
          expiresAt: Date.now() + 60000,
          subject: 'user',
          scopes: ['write'],
        };
      },
      async resolvePrincipal() {
        return { delegableScopes };
      },
      dispatch(_request, context) {
        const refusal = context.requireScopes(['write']);
        if (refusal) return refusal;
        writes++;
        return new Response('private');
      },
    });
    const request = new Request('https://equipment.example.com/api/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer valid' },
      body: new ReadableStream({
        async pull(controller) {
          started();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          controller.enqueue(new TextEncoder().encode('body'));
          controller.close();
        },
      }),
    });
    const pending = handler(request);
    await reading;
    delegableScopes = [];
    release();
    const response = await pending;
    expect(response.status).toBe(403);
    expect(writes).toBe(0);
    expect(await response.text()).not.toContain('private');
  });

  test('does not enqueue a private chunk when cancellation races the authority check', async () => {
    let release!: () => void;
    let checking!: () => void;
    let checks = 0;
    const blocked = new Promise<void>((resolve) => {
      checking = resolve;
    });
    const abort = new AbortController();
    const handler = createProtectedHttpHandler({
      origin: 'https://equipment.example.com',
      resourcePath: '/api/mcp',
      issuer: 'https://login.example.com',
      scopes: ['read'],
      async verifyAccessToken() {
        return {
          issuer: 'https://login.example.com',
          audience: 'https://equipment.example.com/api/mcp',
          expiresAt: Date.now() + 60000,
          subject: 'user',
          scopes: ['read'],
        };
      },
      async resolvePrincipal() {
        checks++;
        if (checks === 4) {
          checking();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { delegableScopes: ['read'] };
      },
      dispatch(_request, context) {
        return (
          context.requireScopes(['read']) ??
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('private'));
              },
            }),
          )
        );
      },
    });
    const response = await handler(
      new Request('https://equipment.example.com/api/mcp', {
        headers: { authorization: 'Bearer valid' },
        signal: abort.signal,
      }),
    );
    const reader = response.body!.getReader();
    const pending = reader.read();
    await blocked;
    abort.abort();
    release();
    const result = await pending;
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
  });

  test('withholds a pending chunk when the required scope is removed', async () => {
    let release!: () => void;
    let checking!: () => void;
    let checks = 0;
    let delegableScopes = ['read'];
    const blocked = new Promise<void>((resolve) => {
      checking = resolve;
    });
    const handler = createProtectedHttpHandler({
      origin: 'https://equipment.example.com',
      resourcePath: '/api/mcp',
      issuer: 'https://login.example.com',
      scopes: ['read'],
      async verifyAccessToken() {
        return {
          issuer: 'https://login.example.com',
          audience: 'https://equipment.example.com/api/mcp',
          expiresAt: Date.now() + 60000,
          subject: 'user',
          scopes: ['read'],
        };
      },
      async resolvePrincipal() {
        checks++;
        if (checks === 4) {
          checking();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { delegableScopes };
      },
      dispatch(_request, context) {
        return (
          context.requireScopes(['read']) ??
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('private'));
              },
            }),
          )
        );
      },
    });
    const response = await handler(
      new Request('https://equipment.example.com/api/mcp', {
        headers: { authorization: 'Bearer valid' },
      }),
    );
    const pending = response.text();
    await blocked;
    delegableScopes = [];
    release();
    expect(await pending).toBe('');
  });
  test('serves canonical discovery and refuses missing credentials', async () => {
    const handler = createProtectedHttpHandler({
      origin: 'https://equipment.example.com',
      resourcePath: '/api/mcp',
      issuer: 'https://login.example.com',
      scopes: ['read'],
      allowedOrigins: ['https://client.example.com'],
      verifyAccessToken: async () => null,
      resolvePrincipal: async () => null,
      dispatch: () => new Response('private'),
    });
    const server = Bun.serve({ port: 0, fetch: handler });
    try {
      const metadata = await fetch(
        `${server.url.origin}/.well-known/oauth-protected-resource/api/mcp`,
      );
      expect(await metadata.json()).toMatchObject({
        resource: 'https://equipment.example.com/api/mcp',
        authorization_servers: ['https://login.example.com'],
      });
      const response = await fetch(`${server.url.origin}/api/mcp`);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain(
        'https://equipment.example.com/.well-known/oauth-protected-resource/api/mcp',
      );
      const allowed = await fetch(`${server.url.origin}/api/mcp`, {
        headers: { origin: 'https://client.example.com' },
      });
      expect(allowed.headers.get('access-control-allow-origin')).toBe('https://client.example.com');
      const forbidden = await fetch(`${server.url.origin}/api/mcp`, {
        headers: { origin: 'https://attacker.example' },
      });
      expect(forbidden.status).toBe(403);
    } finally {
      server.stop(true);
    }
  });

  test('checks grants, membership, scopes, limits, and forwarded hosts before dispatch', async () => {
    let calls = 0;
    let member = true;
    let delegable = ['read', 'write'];
    const handler = createProtectedHttpHandler({
      origin: 'https://equipment.example.com',
      resourcePath: '/api/mcp',
      issuer: 'https://login.example.com',
      scopes: ['read', 'write'],
      maximumRequestBytes: 8,
      async verifyAccessToken(token) {
        if (token === 'invalid') return null;
        return {
          issuer: token === 'issuer' ? 'https://wrong.example' : 'https://login.example.com',
          audience:
            token === 'audience'
              ? 'https://wrong.example'
              : 'https://equipment.example.com/api/mcp',
          expiresAt: token === 'expired' ? 1 : Date.now() + 60000,
          subject: 'user',
          scopes: ['read'],
        };
      },
      async resolvePrincipal() {
        return member ? { delegableScopes: delegable } : null;
      },
      async dispatch(request, context) {
        const refusal = context.requireScopes([request.headers.get('x-scope') ?? 'read']);
        if (refusal) return refusal;
        if (request.method === 'POST') expect(await request.text()).toBe('hello');
        calls++;
        return new Response('private');
      },
    });
    const server = Bun.serve({ port: 0, fetch: handler });
    const endpoint = `${server.url.origin}/api/mcp`;
    try {
      const discovered = await fetch(
        `${server.url.origin}/.well-known/oauth-protected-resource/api/mcp`,
        { headers: { 'x-forwarded-host': 'attacker.example' } },
      );
      const metadata = await discovered.json();
      expect(metadata.resource).toBe('https://equipment.example.com/api/mcp');
      for (const headers of [
        {},
        { cookie: 'session=valid' },
        { 'x-api-key': 'valid' },
        ...['invalid', 'issuer', 'audience', 'expired'].map((token) => ({
          authorization: `Bearer ${token}`,
        })),
      ]) {
        const response = await fetch(endpoint, { headers });
        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toContain(
          'resource_metadata="https://equipment.example.com/.well-known/oauth-protected-resource/api/mcp"',
        );
        expect(await response.text()).not.toContain('private');
      }
      member = false;
      const removed = await fetch(endpoint, { headers: { authorization: 'Bearer valid' } });
      expect(removed.status).toBe(401);
      member = true;
      const write = await fetch(endpoint, {
        headers: { authorization: 'Bearer valid', 'x-scope': 'write' },
      });
      expect(write.status).toBe(403);
      expect(write.headers.get('www-authenticate')).toContain('scope="write"');
      delegable = ['read'];
      const denied = await fetch(endpoint, {
        headers: { authorization: 'Bearer valid', 'x-scope': 'write' },
      });
      expect(denied.status).toBe(403);
      expect(denied.headers.get('www-authenticate')).toBeNull();
      const tooLarge = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer valid' },
        body: '123456789',
      });
      expect(tooLarge.status).toBe(413);
      const streamed = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer valid' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('123456789'));
            controller.close();
          },
        }),
      });
      expect(streamed.status).toBe(413);
      expect(calls).toBe(0);
      const success = await fetch(endpoint, { headers: { authorization: 'Bearer valid' } });
      expect(await success.text()).toBe('private');
      expect(calls).toBe(1);
      const post = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: 'Bearer valid' },
        body: 'hello',
      });
      expect(await post.text()).toBe('private');
      expect(calls).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test('cancels the upstream observer when the client closes the stream', async () => {
    let notifyCancellation!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      notifyCancellation = resolve;
    });
    const handler = createProtectedHttpHandler({
      origin: 'https://equipment.example.com',
      resourcePath: '/api/mcp',
      issuer: 'https://login.example.com',
      scopes: ['read'],
      async verifyAccessToken() {
        return {
          issuer: 'https://login.example.com',
          audience: 'https://equipment.example.com/api/mcp',
          expiresAt: Date.now() + 60000,
          subject: 'user',
          scopes: ['read'],
        };
      },
      async resolvePrincipal() {
        return { delegableScopes: ['read'] };
      },
      dispatch() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('first'));
            },
            cancel() {
              notifyCancellation();
            },
          }),
        );
      },
    });
    const server = Bun.serve({ port: 0, fetch: handler });
    try {
      const response = await fetch(`${server.url.origin}/api/mcp`, {
        headers: { authorization: 'Bearer valid' },
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe('first');
      await reader.cancel();
      await cancelled;
    } finally {
      server.stop(true);
    }
  });

  test('does not release a pending private chunk after membership is removed', async () => {
    let member = true;
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handler = createProtectedHttpHandler({
      origin: 'https://equipment.example.com',
      resourcePath: '/api/mcp',
      issuer: 'https://login.example.com',
      scopes: ['read'],
      async verifyAccessToken() {
        return {
          issuer: 'https://login.example.com',
          audience: 'https://equipment.example.com/api/mcp',
          expiresAt: Date.now() + 60000,
          subject: 'user',
          scopes: ['read'],
        };
      },
      async resolvePrincipal() {
        return member ? { delegableScopes: ['read'] } : null;
      },
      dispatch() {
        return new Response(
          new ReadableStream({
            async pull(controller) {
              started();
              await new Promise<void>((resolve) => {
                release = resolve;
              });
              controller.enqueue(new TextEncoder().encode('private'));
            },
          }),
        );
      },
    });
    const server = Bun.serve({ port: 0, fetch: handler });
    try {
      const pending = fetch(`${server.url.origin}/api/mcp`, {
        headers: { authorization: 'Bearer valid' },
      });
      await waiting;
      member = false;
      release();
      const response = await pending;
      expect(await response.text()).not.toContain('private');
    } finally {
      server.stop(true);
    }
  });
});
