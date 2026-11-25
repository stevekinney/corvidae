/**
 * The Host and Origin forms the guard accepts for a listener's port, including the default port
 * that a client leaves out (`request-guard.ts`).
 */
import { describe, expect, test } from 'bun:test';

import {
  createRequestGuard,
  createSharedWebGuard,
  isAmbiguousPath,
  PUBLIC_TRIGGERS_PATH_PREFIX,
  rawPathOf,
} from './request-guard.ts';

test('shared web sockets require the configured origin and reject ambiguous paths', () => {
  const guard = createSharedWebGuard(
    new URL('https://settings.example'),
    () => new Response('fallback', { status: 403 }),
  );
  expect(
    guard(
      new Request('http://localhost/bureau/jsonrpc', {
        headers: { host: 'settings.example', upgrade: 'websocket' },
      }),
    )?.status,
  ).toBe(403);
  expect(
    guard(
      new Request('http://localhost/bureau/jsonrpc', {
        headers: {
          host: 'settings.example',
          upgrade: 'websocket',
          origin: 'https://settings.example',
        },
      }),
    ),
  ).toBeUndefined();
  expect(
    guard(
      new Request('http://localhost/bureau//jsonrpc', { headers: { host: 'settings.example' } }),
    )?.status,
  ).toBe(403);
  expect(
    guard(
      new Request('http://localhost/', {
        headers: { host: 'settings.example', origin: 'https://evil.example' },
      }),
    )?.status,
  ).toBe(403);
  for (const origin of [undefined, 'https://evil.example', 'https://settings.example']) {
    const response = guard(
      new Request('http://localhost/bureau/events', {
        headers: {
          host: 'settings.example',
          accept: 'text/event-stream',
          cookie: 'session=value',
          ...(origin === undefined ? {} : { origin }),
        },
      }),
    );
    expect(response?.status).toBe(origin === 'https://settings.example' ? undefined : 403);
  }
  expect(
    guard(
      new Request('http://localhost/bureau/mcp', {
        headers: {
          host: 'settings.example',
          accept: 'text/event-stream',
          authorization: 'Bearer token',
        },
      }),
    ),
  ).toBeUndefined();
  expect(
    guard(
      new Request('http://localhost/bureau/events', {
        headers: {
          host: 'settings.example',
          accept: 'text/event-stream',
          cookie: 'session=value',
          'sec-fetch-site': 'same-origin',
        },
      }),
    ),
  ).toBeUndefined();
  expect(
    guard(
      new Request('http://localhost/bureau/events', {
        headers: {
          host: 'settings.example',
          accept: 'text/event-stream',
          cookie: 'session=value',
          'sec-fetch-site': 'cross-site',
        },
      }),
    )?.status,
  ).toBe(403);
});

function request(headers: Record<string, string>): Request {
  return new Request('http://127.0.0.1/', { headers });
}

function refused(port: number, headers: Record<string, string>): boolean {
  return createRequestGuard(() => port)(request(headers))?.status === 403;
}

describe('a listener on the default HTTP port', () => {
  test('accepts a Host that omits the port, under either name', () => {
    expect(refused(80, { host: 'localhost' })).toBe(false);
    expect(refused(80, { host: '127.0.0.1' })).toBe(false);
    expect(refused(80, { host: 'localhost:80' })).toBe(false);
  });

  test('accepts the page’s own Origin without a port', () => {
    expect(refused(80, { host: 'localhost', origin: 'http://localhost' })).toBe(false);
    expect(refused(80, { host: '127.0.0.1', origin: 'http://127.0.0.1:80' })).toBe(false);
  });

  test('still refuses another host and another origin', () => {
    expect(refused(80, { host: 'attacker.example' })).toBe(true);
    expect(refused(80, { host: 'localhost', origin: 'http://attacker.example' })).toBe(true);
    expect(refused(80, { host: 'localhost', origin: 'http://localhost.attacker.example' })).toBe(
      true,
    );
  });
});

describe('a listener on any other port', () => {
  test('refuses a Host that omits the port', () => {
    expect(refused(7234, { host: 'localhost' })).toBe(true);
    expect(refused(7234, { host: '127.0.0.1' })).toBe(true);
  });

  test('refuses an Origin that omits the port', () => {
    expect(refused(7234, { host: 'localhost:7234', origin: 'http://localhost' })).toBe(true);
  });

  test('accepts its own port', () => {
    expect(refused(7234, { host: 'localhost:7234', origin: 'http://localhost:7234' })).toBe(false);
  });
});

describe('a guard given a public A2A origin (COR-1904)', () => {
  const publicOrigin = new URL('https://agents.example.test:8443');

  function refusedAt(path: string, headers: Record<string, string>): boolean {
    const guard = createRequestGuard(() => 7234, publicOrigin);
    return guard(new Request(`http://127.0.0.1${path}`, { headers }))?.status === 403;
  }

  test('accepts that origin for an A2A path, under any case, with no Origin or its own', () => {
    expect(refusedAt('/bureau/a2a/open', { host: 'Agents.Example.Test:8443' })).toBe(false);
    expect(
      refusedAt('/bureau/a2a/open', {
        host: 'agents.example.test:8443',
        origin: 'https://agents.example.test:8443',
      }),
    ).toBe(false);
  });

  test('refuses that origin for any other path, another port, or a foreign Origin', () => {
    expect(refusedAt('/bureau/jsonrpc', { host: 'agents.example.test:8443' })).toBe(true);
    expect(refusedAt('/bureau/a2a', { host: 'agents.example.test:8443' })).toBe(true);
    expect(refusedAt('/bureau/a2a/open', { host: 'agents.example.test' })).toBe(true);
    expect(
      refusedAt('/bureau/a2a/open', {
        host: 'agents.example.test:8443',
        origin: 'https://attacker.example',
      }),
    ).toBe(true);
  });

  test('still answers loopback as before', () => {
    expect(refusedAt('/bureau/jsonrpc', { host: 'localhost:7234' })).toBe(false);
    expect(refusedAt('/bureau/a2a/open', { host: 'attacker.example' })).toBe(true);
  });
});

describe('a guard given a public origin on its default port (COR-1904)', () => {
  const guard = createRequestGuard(() => 7234, new URL('https://agents.example.test'));

  function statusAt(path: string, headers: Record<string, string>): number | undefined {
    return guard(new Request(`http://127.0.0.1${path}`, { headers }))?.status;
  }

  test('accepts the name with the default port written out or left out', () => {
    expect(statusAt('/bureau/a2a/open', { host: 'agents.example.test' })).toBeUndefined();
    expect(statusAt('/bureau/a2a/open', { host: 'agents.example.test:443' })).toBeUndefined();
  });

  test('refuses any other port', () => {
    expect(statusAt('/bureau/a2a/open', { host: 'agents.example.test:8443' })).toBe(403);
    expect(statusAt('/bureau/a2a/open', { host: 'agents.example.test:80' })).toBe(403);
  });

  test('lets an asset read through only with a credential, which the Bureau then checks', () => {
    const host = { host: 'agents.example.test' };
    expect(statusAt('/bureau/assets/a/content', { ...host, 'x-api-key': 'k' })).toBeUndefined();
    expect(
      statusAt('/bureau/assets/a/content', { ...host, authorization: 'Bearer k' }),
    ).toBeUndefined();
    expect(statusAt('/bureau/assets/a/content', host)).toBe(401);
    expect(statusAt('/bureau/assets/../jsonrpc', { ...host, 'x-api-key': 'k' })).toBe(403);
  });

  test('leaves an asset read on loopback to the Bureau, credential or not', () => {
    expect(statusAt('/bureau/assets/a/content', { host: 'localhost:7234' })).toBeUndefined();
  });

  test('admits no trigger path: the guard of the Bureau route is not the trigger route’s (COR-2169)', () => {
    const host = { host: 'agents.example.test' };
    expect(statusAt('/triggers/hook', host)).toBe(403);
  });
});

/**
 * COR-2169 — each public surface has a guard of its own, admitting only its own paths, and every
 * public request is judged on its raw target, the path the router matches and the handler behind it
 * is given. A request is built as a plain object because `new Request` resolves dot segments, which
 * is exactly what the raw target must not be.
 */
describe('the guards of the public surfaces (COR-2169)', () => {
  const publicOrigin = new URL('https://agents.example.test');
  const host = { host: 'agents.example.test' };
  const bureau = createRequestGuard(() => 7234, publicOrigin);
  const trigger = createRequestGuard(() => 7234, publicOrigin, ['triggers']);

  /** A request whose `url` is exactly `target`, as the server hands it to a route. */
  function rawRequest(target: string, headers: Record<string, string> = host): Request {
    return { url: target, headers: new Headers(headers) } as unknown as Request;
  }

  const statusOf = (
    guard: (request: Request) => Response | undefined,
    target: string,
    headers?: Record<string, string>,
  ): number | undefined => guard(rawRequest(`http://127.0.0.1${target}`, headers))?.status;

  test('the trigger guard admits /triggers/<one segment> with no credential, under either Host form', () => {
    expect(PUBLIC_TRIGGERS_PATH_PREFIX).toBe('/triggers/');
    expect(statusOf(trigger, '/triggers/hook')).toBeUndefined();
    expect(statusOf(trigger, '/triggers/hook?x=1')).toBeUndefined();
    expect(
      statusOf(trigger, '/triggers/hook', { host: 'agents.example.test:443' }),
    ).toBeUndefined();
    expect(
      statusOf(trigger, '/triggers/hook', { ...host, origin: 'https://agents.example.test' }),
    ).toBeUndefined();
    expect(
      statusOf(trigger, '/triggers/hook', { ...host, 'x-api-key': 'anything' }),
    ).toBeUndefined();
  });

  test('each guard admits only its own surface', () => {
    expect(statusOf(trigger, '/bureau/a2a/open')).toBe(403);
    expect(statusOf(trigger, '/bureau/assets/a/content', { ...host, 'x-api-key': 'k' })).toBe(403);
    expect(statusOf(bureau, '/triggers/hook')).toBe(403);
    expect(statusOf(bureau, '/bureau/a2a/open')).toBeUndefined();
  });

  test('the trigger guard refuses every other shape near a trigger delivery, another port, or a foreign Origin', () => {
    for (const path of [
      '/triggers',
      '/triggers/',
      '/triggers/a/b',
      '/triggers/hook/',
      '/trigger/hook',
      '/Triggers/hook',
      '/api/triggers/hook',
      '/host/status',
      '/',
    ]) {
      expect(statusOf(trigger, path), path).toBe(403);
    }
    expect(statusOf(trigger, '/triggers/hook', { host: 'agents.example.test:8443' })).toBe(403);
    expect(
      statusOf(trigger, '/triggers/hook', { ...host, origin: 'https://attacker.example' }),
    ).toBe(403);
    expect(statusOf(trigger, '/triggers/hook', { ...host, origin: 'http://127.0.0.1:7234' })).toBe(
      403,
    );
  });

  const AMBIGUOUS = [
    '/bureau/../triggers/x',
    '/bureau/a2a/../../triggers/x',
    '/bureau/%2e%2e/triggers/x',
    '/bureau/%2E%2E/triggers/x',
    '/bureau/./a2a/open',
    '/bureau/a2a/./open',
    '/bureau/a2a/open/..',
    '/triggers/../bureau/jsonrpc',
    '/triggers/x/../../bureau/jsonrpc',
    '/triggers/%2e%2e/bureau/jsonrpc',
    '/triggers//x',
    '/bureau//triggers/x',
    '/bureau/a2a//open',
    '/triggers/x%2f..%2f..%2fbureau%2fjsonrpc',
    '/triggers/x%2Fy',
    '/triggers/x%5cy',
    '/triggers/x%5Cy',
    '/triggers/x\\y',
    '/bureau/assets/..%2fjsonrpc',
  ];

  test.each(AMBIGUOUS)('a public request for %p is refused by either guard', (path) => {
    expect(statusOf(trigger, path)).toBe(403);
    expect(statusOf(bureau, path, { ...host, 'x-api-key': 'k' })).toBe(403);
  });

  test('an absolute-form target is judged on its path, not its authority', () => {
    for (const target of [
      'https://agents.example.test/bureau/../triggers/x',
      'https://agents.example.test/triggers/../bureau/jsonrpc',
      'https://agents.example.test/triggers//x',
    ]) {
      expect(trigger(rawRequest(target))?.status, target).toBe(403);
      expect(bureau(rawRequest(target, { ...host, 'x-api-key': 'k' }))?.status, target).toBe(403);
    }
    expect(trigger(rawRequest('https://agents.example.test/triggers/x'))).toBeUndefined();
    expect(rawPathOf(rawRequest('https://agents.example.test'))).toBe('/');
    expect(rawPathOf(rawRequest('https://agents.example.test/a/../b?c=/../#d'))).toBe('/a/../b');
  });

  test('a loopback request is not judged by the public rules', () => {
    expect(
      statusOf(trigger, '/triggers/../bureau/jsonrpc', { host: 'localhost:7234' }),
    ).toBeUndefined();
    expect(isAmbiguousPath('/bureau/jsonrpc')).toBe(false);
    expect(isAmbiguousPath('/bureau/assets/a-b_c.d/content')).toBe(false);
  });

  test('refuses a trigger path on a public origin the guard was not given', () => {
    const plain = createRequestGuard(() => 7234);
    const request = new Request('http://127.0.0.1/triggers/hook', {
      headers: { host: 'agents.example.test' },
    });
    expect(plain(request)?.status).toBe(403);
  });
});
