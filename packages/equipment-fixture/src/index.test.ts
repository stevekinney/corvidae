import { expect, test } from 'bun:test';
import { fixtureScopes, publicRequest } from './index.ts';

test('the synthetic role allowlist grants only each subject’s scopes', () => {
  expect(fixtureScopes('reader', 'reader', 'editor')).toEqual(['equipment:read']);
  expect(fixtureScopes('editor', 'reader', 'editor')).toEqual([
    'equipment:read',
    'equipment:write',
  ]);
  expect(fixtureScopes('other', 'reader', 'editor')).toBeNull();
  expect(() => fixtureScopes('same', 'same', 'same')).toThrow();
  expect(() => fixtureScopes('reader', 'reader', '')).toThrow();
});

test.each(['/api/mcp', '/mcp'])(
  'reconstructs the public URL for %s only for its own host',
  async (path) => {
    const incoming = new Request(`http://equipment.example.test${path}?state=one%2Ftwo`, {
      method: 'POST',
      headers: {
        host: 'equipment.example.test',
        origin: 'https://foreign.example',
        cookie: 'session=one',
        'x-forwarded-proto': 'http',
        forwarded: 'host=foreign.example',
      },
      body: 'payload',
    });
    const result = publicRequest(incoming, 'https://equipment.example.test');
    expect(result).toBeInstanceOf(Request);
    if (!(result instanceof Request)) throw new Error('Expected accepted request');
    expect(result.url).toBe(`https://equipment.example.test${path}?state=one%2Ftwo`);
    expect(result.method).toBe('POST');
    expect(result.headers.get('origin')).toBe('https://foreign.example');
    expect(result.headers.get('cookie')).toBe('session=one');
    expect(await result.text()).toBe('payload');
    expect(
      publicRequest(
        new Request('http://foreign.example/', { headers: { host: 'foreign.example' } }),
        'https://equipment.example.test',
      ),
    ).toBeInstanceOf(Response);
  },
);

test.each(['/api/mcp', '/mcp'])(
  'accepts the configured host over HTTP for %s and rejects other authorities',
  async (path) => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(incoming) {
        const request = publicRequest(incoming, 'https://equipment.example.test:8443');
        if (request instanceof Response) return request;
        return Response.json({ url: request.url, origin: request.headers.get('origin') });
      },
    });
    try {
      const accepted = await fetch(new URL(`${path}?key=value`, server.url), {
        headers: {
          host: 'equipment.example.test:8443',
          origin: 'https://foreign.example',
          'x-forwarded-host': 'foreign.example',
        },
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({
        url: `https://equipment.example.test:8443${path}?key=value`,
        origin: 'https://foreign.example',
      });
      const rejected = await fetch(new URL(path, server.url), {
        headers: { host: 'foreign.example', 'x-forwarded-host': 'equipment.example.test:8443' },
      });
      expect(rejected.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  },
);
