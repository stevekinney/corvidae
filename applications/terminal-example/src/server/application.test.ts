import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionSlot } from '@lostgradient/ventriloquist';
import type { CreateProcess, UpgradeServer } from '@lostgradient/ventriloquist/websocket';

import { createApplication, type Application } from './application.ts';
import { ConfigurationError } from './configuration.ts';
import { CONTENT_SECURITY_POLICY } from './content-security-policy.ts';
import type { ProfileContext } from './profiles.ts';
import { SessionStore } from './session-store.ts';

const configuration = { hostname: '127.0.0.1', port: 54299 } as const;
const ORIGIN = 'http://127.0.0.1:54299';
const context: ProfileContext = {
  host: { shell: '/bin/sh', path: undefined, language: undefined },
  user: { username: 'ada', homeDirectory: '/home/ada', shell: undefined },
};
const noProcess: CreateProcess = () => {
  throw new Error('a request test must not start a process');
};

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'terminal-example-application-'));
  await mkdir(join(directory, 'nested'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>example</title>');
  await writeFile(join(directory, 'chunk-abc.js'), 'export {};');
  await writeFile(join(directory, 'nested', 'file.css'), 'body{}');
  await writeFile(join(directory, 'metafile.json'), '{}');
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function fakeServer(upgraded: { data?: unknown }[] = []): UpgradeServer {
  return {
    upgrade: (_request, options) => {
      upgraded.push(options);
      return true;
    },
    requestIP: () => ({ address: '127.0.0.1' }),
  };
}

function build(
  options: {
    store?: SessionStore;
    context?: ProfileContext;
    sessionWaitMilliseconds?: number;
  } = {},
): Promise<Application> {
  return createApplication({
    configuration,
    buildDirectory: directory,
    createProcess: noProcess,
    context: options.context ?? context,
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.sessionWaitMilliseconds === undefined
      ? {}
      : { sessionWaitMilliseconds: options.sessionWaitMilliseconds }),
  });
}

function request(
  path: string,
  init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {},
) {
  return new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: { host: '127.0.0.1:54299', ...init.headers },
  });
}

async function enrolled(application: Application): Promise<string> {
  const response = await application.fetch(request('/'), fakeServer());
  return (response?.headers.get('set-cookie') ?? '').split(';')[0] as string;
}

function sessionRequest(cookie: string, body: unknown, headers: Record<string, string> = {}) {
  return request('/session', {
    method: 'POST',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('starting', () => {
  test('refuses to start without a build, and says what to run', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'terminal-example-empty-'));
    try {
      const failure = await createApplication({
        configuration,
        buildDirectory: empty,
        createProcess: noProcess,
        context,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ConfigurationError);
      expect((failure as Error).message).toContain('bun run build');
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test('the allowed origin is the served origin and only that', async () => {
    const application = await build();
    expect(application.origin).toBe(ORIGIN);
  });
});

describe('serving the page', () => {
  test('serves the build with the policy, and enrolls a browser once', async () => {
    const application = await build();
    const first = (await application.fetch(request('/'), fakeServer())) as Response;
    expect(first.status).toBe(200);
    expect(first.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(first.headers.get('x-content-type-options')).toBe('nosniff');
    expect(first.headers.get('content-type')).toContain('text/html');
    expect(await first.text()).toContain('<title>example</title>');
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0] as string;
    expect(first.headers.get('set-cookie')).toContain('HttpOnly');
    const second = (await application.fetch(
      request('/', { headers: { cookie } }),
      fakeServer(),
    )) as Response;
    expect(second.headers.get('set-cookie')).toBeNull();
    expect(application.store.browserCount).toBe(1);
  });

  test('serves nested build files, and HEAD without a body', async () => {
    const application = await build();
    const nested = (await application.fetch(request('/nested/file.css'), fakeServer())) as Response;
    expect(nested.status).toBe(200);
    expect(nested.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    const head = (await application.fetch(
      request('/chunk-abc.js', { method: 'HEAD' }),
      fakeServer(),
    )) as Response;
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  test('serves only what the build wrote', async () => {
    const application = await build();
    for (const path of [
      '/metafile.json',
      '/nope.js',
      '/../application.ts',
      '/%2e%2e/secret',
      '/nested',
    ]) {
      const response = (await application.fetch(request(path), fakeServer())) as Response;
      expect(response.status, path).toBe(404);
    }
  });

  test('refuses a request for another host name, which is how DNS rebinding arrives', async () => {
    const application = await build();
    const response = (await application.fetch(
      request('/', { headers: { host: 'rebind.example:54299' } }),
      fakeServer(),
    )) as Response;
    expect(response.status).toBe(421);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  test('allows only the methods each route takes', async () => {
    const application = await build();
    const cookie = await enrolled(application);
    const cases: [string, string, number, string][] = [
      ['POST', '/', 405, 'GET, HEAD'],
      ['GET', '/session', 405, 'POST'],
      ['POST', '/session/status', 405, 'GET'],
    ];
    for (const [method, path, status, allow] of cases) {
      const response = (await application.fetch(
        request(path, { method, headers: { cookie } }),
        fakeServer(),
      )) as Response;
      expect(response.status, `${method} ${path}`).toBe(status);
      expect(response.headers.get('allow')).toBe(allow);
    }
  });
});

describe('POST /session', () => {
  test('refuses a request without the cookie', async () => {
    const application = await build();
    const response = (await application.fetch(
      sessionRequest('', { profile: 'shell', readOnly: false }),
      fakeServer(),
    )) as Response;
    expect(response.status).toBe(401);
  });

  test('refuses another origin, a body that is not JSON and one that is too big', async () => {
    const application = await build();
    const cookie = await enrolled(application);
    const send = async (body: unknown, headers: Record<string, string>) =>
      ((await application.fetch(sessionRequest(cookie, body, headers), fakeServer())) as Response)
        .status;
    const valid = { profile: 'shell', readOnly: false };
    expect(await send(valid, { origin: 'http://evil.example' })).toBe(403);
    expect(await send(valid, { origin: 'null' })).toBe(403);
    expect(await send(valid, { 'content-type': 'text/plain' })).toBe(415);
    expect(await send('x'.repeat(2000), {})).toBe(413);
    expect(await send('{', {})).toBe(400);
  });

  test('takes a profile and a mode and nothing else', async () => {
    const application = await build();
    const cookie = await enrolled(application);
    const status = async (body: unknown) =>
      ((await application.fetch(sessionRequest(cookie, body), fakeServer())) as Response).status;
    expect(await status({ profile: 'shell', readOnly: false })).toBe(201);
    expect(await status({ profile: 'rm', readOnly: false })).toBe(400);
    expect(await status({ profile: 'shell' })).toBe(400);
    expect(await status({ profile: 'shell', readOnly: 'yes' })).toBe(400);
    expect(await status({ profile: 'shell', readOnly: false, executable: '/bin/rm' })).toBe(400);
    expect(await status({ profile: 'shell', readOnly: false, argumentList: ['-rf'] })).toBe(400);
    expect(await status({ profile: 'shell', readOnly: false, cwd: '/', env: {} })).toBe(400);
    expect(await status([])).toBe(400);
    expect(await status(null)).toBe(400);
  });

  test('issues a session identity and a ticket, and never repeats either', async () => {
    const application = await build();
    const cookie = await enrolled(application);
    const read = async () =>
      (await (
        (await application.fetch(
          sessionRequest(cookie, { profile: 'fullscreen', readOnly: true }),
          fakeServer(),
        )) as Response
      ).json()) as { sessionId: string; ticket: string };
    const first = await read();
    const second = await read();
    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.ticket).not.toBe(second.ticket);
    expect(first.sessionId).not.toBe(second.sessionId);
  });

  test('says a profile is unavailable when the host has no login shell', async () => {
    const application = await build({
      context: {
        host: { shell: undefined, path: undefined, language: undefined },
        user: { username: 'ada', homeDirectory: '/home/ada', shell: undefined },
      },
    });
    const cookie = await enrolled(application);
    const response = (await application.fetch(
      sessionRequest(cookie, { profile: 'shell', readOnly: false }),
      fakeServer(),
    )) as Response;
    expect(response.status).toBe(503);
  });

  test('limits the tickets outstanding for one browser', async () => {
    const application = await build();
    const cookie = await enrolled(application);
    const statuses: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const response = (await application.fetch(
        sessionRequest(cookie, { profile: 'shell', readOnly: false }),
        fakeServer(),
      )) as Response;
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(201));
    expect(statuses.slice(8)).toEqual([429, 429]);
  });
});

/** A store whose browser already has a session, so a request can meet each state a slot can be in. */
class SlotStore extends SessionStore {
  readonly current: unknown;
  constructor(current: unknown) {
    super();
    this.current = current;
  }
  override slotFor(): SessionSlot {
    return { current: this.current } as SessionSlot;
  }
}

describe('a browser that already has a session', () => {
  const open = { snapshot: { closed: false, quarantined: false } };

  test('waits for the previous session to be cleaned up, then issues a new one', async () => {
    let finish: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const session = { snapshot: { closed: false, quarantined: false }, closed };
    const application = await build({
      store: new SlotStore(session),
      sessionWaitMilliseconds: 5000,
    });
    const cookie = await enrolled(application);
    const pending = application.fetch(
      sessionRequest(cookie, { profile: 'shell', readOnly: false }),
      fakeServer(),
    ) as Promise<Response>;
    session.snapshot.closed = true;
    finish();
    const response = await pending;
    expect(response.status).toBe(201);
  });

  test('answers busy when the previous session is not cleaned up in time', async () => {
    const session = { ...open, closed: new Promise<void>(() => undefined) };
    const application = await build({ store: new SlotStore(session), sessionWaitMilliseconds: 10 });
    const cookie = await enrolled(application);
    const response = (await application.fetch(
      sessionRequest(cookie, { profile: 'shell', readOnly: false }),
      fakeServer(),
    )) as Response;
    expect(response.status).toBe(409);
  });

  test('refuses a replacement while the slot is quarantined', async () => {
    const session = { snapshot: { closed: true, quarantined: true }, closed: Promise.resolve() };
    const application = await build({ store: new SlotStore(session) });
    const cookie = await enrolled(application);
    const response = (await application.fetch(
      sessionRequest(cookie, { profile: 'shell', readOnly: false }),
      fakeServer(),
    )) as Response;
    expect(response.status).toBe(423);
  });

  test('reports the slot: free, busy or quarantined', async () => {
    const states: [unknown, string][] = [
      [undefined, 'free'],
      [{ snapshot: { closed: true, quarantined: false } }, 'free'],
      [open, 'busy'],
      [{ snapshot: { closed: true, quarantined: true } }, 'quarantined'],
    ];
    for (const [current, expected] of states) {
      const application = await build({ store: new SlotStore(current) });
      const cookie = await enrolled(application);
      const response = (await application.fetch(
        request('/session/status', { headers: { cookie } }),
        fakeServer(),
      )) as Response;
      expect(await response.json()).toEqual({ slot: expected });
    }
  });

  test('reports nothing to a browser without the cookie', async () => {
    const application = await build();
    const response = (await application.fetch(
      request('/session/status'),
      fakeServer(),
    )) as Response;
    expect(response.status).toBe(401);
  });
});

describe('the upgrade', () => {
  function upgrade(
    path: string,
    headers: Record<string, string>,
    application: Application,
    upgraded: { data?: unknown }[] = [],
  ) {
    return application.fetch(
      request(path, { headers: { upgrade: 'websocket', connection: 'Upgrade', ...headers } }),
      fakeServer(upgraded),
    );
  }

  test('is admitted from the served origin with the cookie and a profile', async () => {
    const application = await build();
    const cookie = await enrolled(application);
    const upgraded: { data?: unknown }[] = [];
    const response = await upgrade(
      '/terminal?profile=shell',
      { cookie, origin: ORIGIN },
      application,
      upgraded,
    );
    expect(response).toBeUndefined();
    expect(upgraded).toHaveLength(1);
    expect(upgraded[0]?.data).toMatchObject({ profileId: 'shell' });
  });

  test('is denied from any other origin, however valid the cookie', async () => {
    const application = await build();
    const cookie = await enrolled(application);
    for (const origin of ['http://evil.example', 'http://localhost:54299', 'null', '']) {
      const upgraded: { data?: unknown }[] = [];
      const response = await upgrade(
        '/terminal?profile=shell',
        { cookie, origin },
        application,
        upgraded,
      );
      expect(response?.status, origin).toBe(403);
      expect(upgraded).toHaveLength(0);
    }
  });

  test('is denied without the cookie, and with a query that carries anything but the profile', async () => {
    const application = await build();
    const cookie = await enrolled(application);
    const anonymous = await upgrade('/terminal?profile=shell', { origin: ORIGIN }, application);
    expect(anonymous?.status).toBe(401);
    for (const query of ['profile=shell&ticket=x', 'profile=shell&executable=/bin/sh', 'sid=1']) {
      const response = await upgrade(`/terminal?${query}`, { cookie, origin: ORIGIN }, application);
      expect(response?.status, query).toBe(400);
    }
  });
});
