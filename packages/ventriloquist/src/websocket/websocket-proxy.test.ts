import { describe, expect, test } from 'bun:test';

import { createTerminalWebSocketServer } from './websocket-server.ts';
import { LAUNCH, ORIGIN, SESSION_COOKIE, connect, startHarness } from './websocket.test-support.ts';

/**
 * A listener that speaks plain http, standing behind a proxy that terminates TLS. The peer the
 * listener sees is 127.0.0.1, so whether that address is a trusted proxy is what each test sets.
 */
const behindProxy = (trustedProxies: readonly string[]) =>
  startHarness({ allowInsecureLoopback: false, server: { trustedProxies } });

async function status(
  harness: ReturnType<typeof startHarness>,
  headers: Record<string, string>,
): Promise<number> {
  const response = await fetch(harness.url.replace('ws:', 'http:'), {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      origin: ORIGIN,
      cookie: SESSION_COOKIE,
      ...headers,
    },
  });
  await response.text();
  return response.status;
}

describe('trustedProxies', () => {
  test('a trusted peer that says https is accepted on an http listener, over a real socket', async () => {
    const harness = behindProxy(['127.0.0.1']);
    try {
      const client = connect(harness, { headers: { 'X-Forwarded-Proto': 'https' } });
      expect((await client.handshake()).sessionId).toBeString();
    } finally {
      await harness.stop();
    }
  });

  test('the same header from a peer that is not trusted is refused', async () => {
    const harness = behindProxy(['10.0.0.1']);
    try {
      expect(await status(harness, { 'x-forwarded-proto': 'https' })).toBe(403);
      const client = connect(harness, { headers: { 'X-Forwarded-Proto': 'https' } });
      expect(await client.refused()).toBe(true);
    } finally {
      await harness.stop();
    }
  });

  test('with no trusted proxies, which is the default, the header is never read', async () => {
    const harness = startHarness({ allowInsecureLoopback: false });
    try {
      expect(await status(harness, { 'x-forwarded-proto': 'https' })).toBe(403);
    } finally {
      await harness.stop();
    }
  });

  test.each([
    ['http', { 'x-forwarded-proto': 'http' }],
    ['a missing header', {}],
    ['an unrelated scheme', { 'x-forwarded-proto': 'wss' }],
    ['an empty value', { 'x-forwarded-proto': '' }],
    ['X-Forwarded-For alone', { 'x-forwarded-for': '203.0.113.9' }],
    ['the Forwarded header alone', { forwarded: 'proto=https' }],
    [
      'a client-prepended https before the proxy appended http',
      { 'x-forwarded-proto': 'https, http' },
    ],
  ])('a trusted peer with %s is refused', async (_name, headers) => {
    const harness = behindProxy(['127.0.0.1']);
    try {
      expect(await status(harness, headers)).toBe(403);
    } finally {
      await harness.stop();
    }
  });

  test.each([
    ['mixed case', 'HtTpS'],
    ['a list whose last value, the proxy-appended one, is https', 'http, https'],
    ['padding around the value', '  https  '],
  ])('a trusted peer is honored with %s, by the documented rule', async (_name, value) => {
    const harness = behindProxy(['127.0.0.1']);
    try {
      expect(await status(harness, { 'x-forwarded-proto': value })).toBe(400);
    } finally {
      await harness.stop();
    }
  });

  test('origin and authentication still apply behind a trusted proxy', async () => {
    const harness = behindProxy(['127.0.0.1']);
    try {
      const secure = { 'x-forwarded-proto': 'https' };
      expect(await status(harness, { ...secure, origin: 'https://evil.example' })).toBe(403);
      expect(await status(harness, { ...secure, cookie: 'sid=forged' })).toBe(401);
    } finally {
      await harness.stop();
    }
  });

  test('an IPv4-mapped form of the peer matches the same address', async () => {
    const harness = behindProxy(['::ffff:127.0.0.1']);
    try {
      expect(await status(harness, { 'x-forwarded-proto': 'https' })).toBe(400);
    } finally {
      await harness.stop();
    }
  });

  test.each([
    ['a hostname', 'proxy.internal'],
    ['a CIDR range', '10.0.0.0/8'],
    ['a wildcard', '*'],
    ['an empty entry', ''],
  ])('refuses %s as a proxy address at construction', (_name, entry) => {
    expect(() =>
      createTerminalWebSocketServer({
        host: {
          authenticate: () => ({ ok: false, denial: 'unauthenticated' }),
          authorize: () => ({ allowed: true, grant: 'interactive', launch: LAUNCH }),
        },
        createProcess: () => {
          throw new Error('unused');
        },
        allowedOrigins: [ORIGIN],
        slotFor: () => {
          throw new Error('unused');
        },
        trustedProxies: [entry],
      }),
    ).toThrow(RangeError);
  });
});
