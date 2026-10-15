import { describe, expect, test } from 'bun:test';

import { createDeferred } from '../session/fixtures/deferred.ts';
import { SessionSlot } from '../session/session-slot.ts';
import { createTerminalWebSocketServer, type UpgradeServer } from './websocket-server.ts';
import type { Authentication, TerminalWebSocketServerOptions } from './websocket-types.ts';
import { LAUNCH, ORIGIN, SESSION_COOKIE, scriptedProcess } from './websocket.test-support.ts';

const ACCEPTED: Authentication = { ok: true, subject: 'user-1', expiresInMilliseconds: 60_000 };

type FakeServer = UpgradeServer & {
  readonly upgrades: { readonly request: Request; readonly data: unknown }[];
};

function fakeServer(
  facts: { hostname?: string | undefined; peer?: string | undefined; upgrade?: boolean } = {},
): FakeServer {
  const upgrades: FakeServer['upgrades'] = [];
  return {
    upgrades,
    hostname: 'hostname' in facts ? facts.hostname : '127.0.0.1',
    requestIP: () => {
      const address = 'peer' in facts ? facts.peer : '127.0.0.1';
      return address === undefined ? null : { address };
    },
    upgrade: (request, options) => {
      upgrades.push({ request, data: options.data });
      return facts.upgrade ?? true;
    },
  };
}

function build(overrides: Partial<TerminalWebSocketServerOptions> = {}) {
  const process = scriptedProcess();
  return createTerminalWebSocketServer({
    host: {
      authenticate: () => ACCEPTED,
      authorize: () => ({ allowed: true, grant: 'interactive', launch: LAUNCH }),
    },
    createProcess: () => process.hosted,
    allowedOrigins: [ORIGIN],
    allowInsecureLoopback: true,
    slotFor: () => new SessionSlot(),
    ...overrides,
  });
}

function upgradeRequest(
  options: {
    url?: string;
    origin?: string | null;
    headers?: Record<string, string>;
    method?: string;
  } = {},
): Request {
  const headers = new Headers({ upgrade: 'websocket', connection: 'Upgrade', ...options.headers });
  if (options.origin !== null) headers.set('origin', options.origin ?? ORIGIN);
  return new Request(options.url ?? 'http://127.0.0.1:3000/terminal?profile=shell', {
    method: options.method ?? 'GET',
    headers,
  });
}

async function body(response: Response | undefined): Promise<unknown> {
  return response === undefined ? undefined : JSON.parse(await response.text());
}

describe('handleUpgrade admission', () => {
  test('upgrades an allowlisted, authenticated request and stores only the trusted context on the socket', async () => {
    const server = fakeServer();
    const response = await build().handleUpgrade(upgradeRequest(), server);
    expect(response).toBeUndefined();
    expect(server.upgrades).toHaveLength(1);
    expect(server.upgrades[0]?.data).toEqual({
      subject: 'user-1',
      expiresInMilliseconds: 60_000,
      profileId: 'shell',
    });
  });

  test('hands the host the whole request so it can read its own HttpOnly cookie', async () => {
    let seen: Request | undefined;
    const terminal = build({
      host: {
        authenticate: (request) => {
          seen = request;
          return ACCEPTED;
        },
        authorize: () => ({ allowed: false, denial: 'forbidden' }),
      },
    });
    await terminal.handleUpgrade(
      upgradeRequest({ headers: { cookie: SESSION_COOKIE } }),
      fakeServer(),
    );
    expect(seen?.headers.get('cookie')).toBe(SESSION_COOKIE);
  });

  test.each([
    ['a POST', { method: 'POST' }],
    ['a request without the Upgrade header', { headers: { upgrade: 'h2c' } }],
  ])('answers %s with 426 and never authenticates', async (_name, options) => {
    let authenticated = 0;
    const terminal = build({
      host: {
        authenticate: () => {
          authenticated += 1;
          return ACCEPTED;
        },
        authorize: () => ({ allowed: false, denial: 'forbidden' }),
      },
    });
    const response = await terminal.handleUpgrade(upgradeRequest(options), fakeServer());
    expect(response?.status).toBe(426);
    expect(response?.headers.get('upgrade')).toBe('websocket');
    expect(authenticated).toBe(0);
  });

  test('refuses an Upgrade request with no Upgrade header at all', async () => {
    const request = new Request('http://127.0.0.1/terminal?profile=shell', {
      headers: { origin: ORIGIN },
    });
    const awaited1 = await build().handleUpgrade(request, fakeServer());
    expect(awaited1?.status).toBe(426);
  });

  describe('origin', () => {
    test.each([
      ['a missing Origin', null],
      ['a null Origin', 'null'],
      ['an unlisted Origin', 'https://evil.example'],
      ['an unparseable Origin', 'garbage'],
      ['an Origin with another scheme', 'http://terminal.example'],
    ])('denies %s with 403 before authenticating', async (_name, origin) => {
      let authenticated = 0;
      const terminal = build({
        host: {
          authenticate: () => {
            authenticated += 1;
            return ACCEPTED;
          },
          authorize: () => ({ allowed: false, denial: 'forbidden' }),
        },
      });
      const server = fakeServer();
      const response = await terminal.handleUpgrade(upgradeRequest({ origin }), server);
      expect(response?.status).toBe(403);
      expect(await body(response)).toEqual({ error: 'forbidden' });
      expect(authenticated).toBe(0);
      expect(server.upgrades).toEqual([]);
    });

    test('still applies under the loopback development switch', async () => {
      const server = fakeServer();
      const response = await build({ allowInsecureLoopback: true }).handleUpgrade(
        upgradeRequest({ origin: 'https://evil.example' }),
        server,
      );
      expect(response?.status).toBe(403);
      expect(server.upgrades).toEqual([]);
    });

    test('an empty allowlist cannot build a server', () => {
      expect(() => build({ allowedOrigins: [] })).toThrow(RangeError);
    });
  });

  describe('transport', () => {
    test('plain http is refused by default, even to a loopback listener', async () => {
      const server = fakeServer();
      const response = await build({ allowInsecureLoopback: false }).handleUpgrade(
        upgradeRequest(),
        server,
      );
      expect(response?.status).toBe(403);
      expect(server.upgrades).toEqual([]);
    });

    test('https is admitted without the switch', async () => {
      const server = fakeServer({ hostname: '0.0.0.0', peer: '203.0.113.9' });
      const response = await build({ allowInsecureLoopback: false }).handleUpgrade(
        upgradeRequest({ url: 'https://terminal.example/terminal?profile=shell' }),
        server,
      );
      expect(response).toBeUndefined();
    });

    test.each([
      ['a wildcard listener', { hostname: '0.0.0.0' }],
      ['a remote peer', { peer: '203.0.113.9' }],
      ['an unreadable peer', { peer: undefined }],
      ['a listener with no hostname', { hostname: undefined }],
    ])('the development switch does not apply to %s', async (_name, facts) => {
      const server = fakeServer(facts);
      const response = await build().handleUpgrade(upgradeRequest(), server);
      expect(response?.status).toBe(403);
      expect(server.upgrades).toEqual([]);
    });

    test('a forwarded-protocol header cannot make plain http secure', async () => {
      const response = await build({ allowInsecureLoopback: false }).handleUpgrade(
        upgradeRequest({ headers: { 'x-forwarded-proto': 'https', forwarded: 'proto=https' } }),
        fakeServer(),
      );
      expect(response?.status).toBe(403);
    });
  });

  describe('the URL', () => {
    test.each(['token', 'access_token', 'Authorization', 'API_KEY', 'password', 'secret'])(
      'a %s query parameter is refused unread',
      async (name) => {
        const server = fakeServer();
        const response = await build().handleUpgrade(
          upgradeRequest({ url: `http://127.0.0.1/terminal?profile=shell&${name}=hunter2` }),
          server,
        );
        expect(response?.status).toBe(400);
        expect(await body(response)).toEqual({ error: 'credential-in-url' });
        expect(server.upgrades).toEqual([]);
      },
    );

    test.each([
      ['missing', 'http://127.0.0.1/terminal'],
      ['empty', 'http://127.0.0.1/terminal?profile='],
      ['with a path separator', 'http://127.0.0.1/terminal?profile=../etc'],
      ['with a space', 'http://127.0.0.1/terminal?profile=a%20b'],
      ['leading with punctuation', 'http://127.0.0.1/terminal?profile=.hidden'],
      ['too long', `http://127.0.0.1/terminal?profile=${'a'.repeat(65)}`],
    ])('a %s profile is a 400', async (_name, url) => {
      const response = await build().handleUpgrade(upgradeRequest({ url }), fakeServer());
      expect(response?.status).toBe(400);
      expect(await body(response)).toEqual({ error: 'invalid-profile' });
    });

    test('a profile at the length limit is accepted', async () => {
      const profile = `a${'b'.repeat(63)}`;
      const server = fakeServer();
      await build().handleUpgrade(
        upgradeRequest({ url: `http://127.0.0.1/terminal?profile=${profile}` }),
        server,
      );
      expect(server.upgrades[0]?.data).toMatchObject({ profileId: profile });
    });
  });

  describe('authentication', () => {
    test.each([
      ['unauthenticated', 401],
      ['expired', 401],
      ['forbidden', 403],
      ['unavailable', 503],
    ] as const)(
      'a %s denial is a %d, with a body that names only the reason',
      async (denial, status) => {
        const server = fakeServer();
        const response = await build({
          host: {
            authenticate: () => ({ ok: false, denial }),
            authorize: () => ({ allowed: false, denial: 'forbidden' }),
          },
        }).handleUpgrade(upgradeRequest({ headers: { cookie: SESSION_COOKIE } }), server);
        expect(response?.status).toBe(status);
        expect(await body(response)).toEqual({ error: denial });
        expect(response?.headers.get('cache-control')).toBe('no-store');
        const sent = response === undefined ? '' : JSON.stringify([...response.headers]);
        expect(sent).not.toContain(SESSION_COOKIE);
        expect(server.upgrades).toEqual([]);
      },
    );

    test('a callback that throws admits nothing and leaks nothing', async () => {
      const response = await build({
        host: {
          authenticate: () => {
            throw new Error('database password is hunter2');
          },
          authorize: () => ({ allowed: false, denial: 'forbidden' }),
        },
      }).handleUpgrade(upgradeRequest(), fakeServer());
      expect(response?.status).toBe(503);
      expect(await response?.text()).not.toContain('hunter2');
    });

    test.each([
      ['no subject', { ok: true, subject: '', expiresInMilliseconds: 1_000 }],
      ['a zero lifetime', { ok: true, subject: 'u', expiresInMilliseconds: 0 }],
      ['a negative lifetime', { ok: true, subject: 'u', expiresInMilliseconds: -5 }],
      ['an infinite lifetime', { ok: true, subject: 'u', expiresInMilliseconds: Infinity }],
      ['a NaN lifetime', { ok: true, subject: 'u', expiresInMilliseconds: Number.NaN }],
    ] as const)('an acceptance with %s is not trusted', async (_name, authentication) => {
      const server = fakeServer();
      const response = await build({
        host: {
          authenticate: () => authentication,
          authorize: () => ({ allowed: false, denial: 'forbidden' }),
        },
      }).handleUpgrade(upgradeRequest(), server);
      expect(response?.status).toBe(503);
      expect(server.upgrades).toEqual([]);
    });

    test('an asynchronous host decision is awaited before the upgrade', async () => {
      const decision = createDeferred<Authentication>();
      const server = fakeServer();
      const pending = build({
        host: {
          authenticate: () => decision.promise,
          authorize: () => ({ allowed: false, denial: 'forbidden' }),
        },
      }).handleUpgrade(upgradeRequest(), server);
      await Promise.resolve();
      expect(server.upgrades).toEqual([]);
      decision.resolve(ACCEPTED);
      expect(await pending).toBeUndefined();
      expect(server.upgrades).toHaveLength(1);
    });
  });

  test('a listener that declines the upgrade is a 400', async () => {
    const response = await build().handleUpgrade(upgradeRequest(), fakeServer({ upgrade: false }));
    expect(response?.status).toBe(400);
    expect(await body(response)).toEqual({ error: 'upgrade-failed' });
  });

  test('sockets already upgrading count against the connection limit', async () => {
    const decision = createDeferred<Authentication>();
    const terminal = build({
      host: {
        authenticate: () => decision.promise,
        authorize: () => ({ allowed: false, denial: 'forbidden' }),
      },
      limits: { maximumConnections: 1 },
    });
    const first = terminal.handleUpgrade(upgradeRequest(), fakeServer());
    const second = await terminal.handleUpgrade(upgradeRequest(), fakeServer());
    expect(second?.status).toBe(503);
    expect(second?.headers.get('retry-after')).toBe('5');
    decision.resolve(ACCEPTED);
    expect(await first).toBeUndefined();
    const third = await terminal.handleUpgrade(upgradeRequest(), fakeServer());
    expect(third).toBeUndefined();
  });
});

describe('slotFor is a required host decision', () => {
  test('a server built without it throws, and says what to supply', () => {
    expect(() => build({ slotFor: undefined as never })).toThrow(/slotFor/);
  });
});
