import { describe, expect, mock, test } from 'claude-code/testing';

import type { CompanionHost } from '../hooks/connection';
import { backoffDelay, createPoller, isLoopbackUrl } from '../hooks/connection';
import { PROTOCOL_VERSION, SERVICE_NAME } from '../hooks/protocol';

const RUNTIME_FILE = JSON.stringify({
  url: 'http://127.0.0.1:47615',
  token: 'test-token',
  protocolVersion: PROTOCOL_VERSION,
  pid: 4242,
});

const HEALTHY = JSON.stringify({ service: SERVICE_NAME, protocolVersion: PROTOCOL_VERSION });

const BAND = {
  plugin: 'attention-queue',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const;

const PANE = {
  plugin: 'attention-queue',
  component: 'Pane',
  requestId: 'attention-queue',
  props: {
    title: 'Attention',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const;

type Request = {
  url: string;
  method: string;
  authorization: string | undefined;
  body: string | undefined;
};

/** A stand-in for the service, answering the mod's `$.http.fetch` calls from memory. */
function fakeService(health = HEALTHY) {
  const requests: Request[] = [];
  const acknowledged = new Set<string>();
  const records = [
    {
      id: 'ci-1',
      kind: 'failed-check',
      title: 'unit tests failed on main',
      source: 'ci',
      createdAt: 2,
      acknowledgedAt: null,
    },
    {
      id: 'approval-7',
      kind: 'approval',
      title: 'deploy to staging',
      source: 'ops',
      createdAt: 1,
      acknowledgedAt: null,
    },
  ];
  const answer = (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: unknown } | undefined,
  ) => {
    const method = init?.method ?? 'GET';
    requests.push({
      url,
      method,
      authorization: init?.headers?.authorization,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const { pathname } = new URL(url);
    if (pathname === '/health') return { status: 200, ok: true, headers: {}, text: health };
    if (pathname === '/v1/items') {
      const items = records.map((record) => ({
        ...record,
        acknowledgedAt: acknowledged.has(record.id) ? 9 : null,
      }));
      return {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify({ items, generatedAt: 10 }),
      };
    }
    const acknowledgement = /^\/v1\/items\/([^/]+)\/acknowledge$/.exec(pathname);
    if (acknowledgement !== null && method === 'POST') {
      acknowledged.add(decodeURIComponent(acknowledgement[1] ?? ''));
      return { status: 200, ok: true, headers: {}, text: '{"status":"acknowledged"}' };
    }
    if (pathname.startsWith('/v1/presence/'))
      return { status: 200, ok: true, headers: {}, text: '{"status":"recorded"}' };
    return { status: 404, ok: false, headers: {}, text: '{}' };
  };
  return { requests, answer };
}

describe('connection', () => {
  test('backs off exponentially up to a cap, with jitter in the upper half', () => {
    expect(backoffDelay(1, () => 0)).toBe(7500);
    expect(backoffDelay(1, () => 1)).toBe(15000);
    expect(backoffDelay(3, () => 1)).toBe(60000);
    expect(backoffDelay(20, () => 1)).toBe(300000);
  });

  test('sends the token only to loopback addresses', () => {
    expect(isLoopbackUrl('http://127.0.0.1:47615')).toBe(true);
    expect(isLoopbackUrl('http://localhost:47615')).toBe(true);
    expect(isLoopbackUrl('https://attention.example.com')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });

  test('a result that arrives after stop() is dropped', async () => {
    let release: (() => void) | undefined;
    const reported: unknown[] = [];
    const host: CompanionHost = {
      readRuntimeFile: async () => RUNTIME_FILE,
      fetch: async (url) => {
        if (url.endsWith('/health')) return { status: 200, ok: true, text: HEALTHY };
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { status: 200, ok: true, text: JSON.stringify({ items: [], generatedAt: 1 }) };
      },
      now: async () => 0,
      after: () => ({ cancel: () => undefined }),
      sessionId: async () => 'session-1',
      random: () => 0.5,
    };
    const poller = createPoller({
      host,
      instanceId: 'instance-1',
      onItems: async (latest) => reported.push(latest),
      onConnection: async (latest) => reported.push(latest),
    });

    const refresh = poller.refreshNow();
    // Every step before the items request is a resolved promise, so a bounded
    // number of microtask turns reaches it without any timer.
    for (let turn = 0; turn < 100 && release === undefined; turn += 1) await Promise.resolve();
    expect(release).toBeDefined();
    poller.stop();
    release?.();
    await refresh;

    expect(reported).toEqual([]);
  });
});

describe('register', () => {
  test('connected: the band summarizes the queue and presence carries this instance', async ($, on) => {
    const clock = mock.clock(on);
    const service = fakeService();
    const statuses: (string | undefined)[] = [];
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('command.register', ($, e) => ({ value: { command: e.name } }));
    on('env.get', () => ({ value: '/home/someone' }));
    on('fs.read', ($, e) =>
      e.path === '/home/someone/.attention-queue/runtime.json'
        ? { value: RUNTIME_FILE }
        : { deny: 'no such file' },
    );
    on('http.fetch', ($, e) => ({ value: service.answer(e.url, e.init) }));
    on('session.id', () => ({ value: 'session-1' }));
    on('ui.status', ($, e) => {
      statuses.push(e.text);
      return { value: undefined };
    });
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e);
      return <Text>another band</Text>;
    });

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
    await clock.advance(0);

    expect(statuses.at(-1)).toBeUndefined();
    const listing = service.requests.find((request) => request.url.endsWith('/v1/items'));
    expect(listing?.authorization).toBe('Bearer test-token');
    const health = service.requests.find((request) => request.url.endsWith('/health'));
    expect(health?.authorization).toBeUndefined();
    const presence = service.requests.find((request) => request.url.includes('/v1/presence/'));
    expect(JSON.parse(presence?.body ?? '{}')).toMatchObject({
      sessionId: 'session-1',
      sequence: 1,
    });

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface });
      expect(
        await ui.find({ type: 'Text', text: 'Attention: 2 waiting (1 approval, 1 failed check)' }),
      ).toBeDefined();
      expect(await ui.find({ type: 'Text', text: 'another band' })).toBeDefined();
      await ui.unmount();
    }
  });

  test('acknowledging from the pane reaches the service and refreshes the queue', async ($, on) => {
    const clock = mock.clock(on);
    const service = fakeService();
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('command.register', ($, e) => ({ value: { command: e.name } }));
    on('env.get', () => ({ value: '/home/someone' }));
    on('fs.read', () => ({ value: RUNTIME_FILE }));
    on('http.fetch', ($, e) => ({ value: service.answer(e.url, e.init) }));
    on('session.id', () => ({ value: 'session-1' }));
    on('ui.status', () => ({ value: undefined }));

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
    await clock.advance(0);

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
    expect(await ui.find({ type: 'Text', text: 'approval: deploy to staging' })).toBeDefined();
    await ui.press({ key: 'acknowledge-approval-7' });

    expect(
      service.requests.some(
        (request) =>
          request.method === 'POST' && request.url.endsWith('/v1/items/approval-7/acknowledge'),
      ),
    ).toBe(true);
    expect(await ui.find({ type: 'Text', text: 'approval: deploy to staging' })).toBeUndefined();
    expect(
      await ui.find({ type: 'Text', text: 'failed check: unit tests failed on main' }),
    ).toBeDefined();
    await ui.unmount();
  });

  test('a different service on the port is refused before any token is sent', async ($, on) => {
    const clock = mock.clock(on);
    const service = fakeService(JSON.stringify({ service: 'something-else', protocolVersion: 1 }));
    const statuses: (string | undefined)[] = [];
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('command.register', ($, e) => ({ value: { command: e.name } }));
    on('env.get', () => ({ value: '/home/someone' }));
    on('fs.read', () => ({ value: RUNTIME_FILE }));
    on('http.fetch', ($, e) => ({ value: service.answer(e.url, e.init) }));
    on('ui.status', ($, e) => {
      statuses.push(e.text);
      return { value: undefined };
    });

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
    await clock.advance(0);

    expect(statuses.at(-1)).toContain('something other than the attention-queue service answers');
    expect(service.requests.map((request) => new URL(request.url).pathname)).toEqual(['/health']);
  });

  test('without a runtime file the mod makes no request and says so', async ($, on) => {
    const clock = mock.clock(on);
    const service = fakeService();
    const statuses: (string | undefined)[] = [];
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('command.register', ($, e) => ({ value: { command: e.name } }));
    on('env.get', () => ({ value: '/home/someone' }));
    on('fs.read', () => ({ deny: 'no such file' }));
    on('http.fetch', ($, e) => ({ value: service.answer(e.url, e.init) }));
    on('ui.status', ($, e) => {
      statuses.push(e.text);
      return { value: undefined };
    });

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
    await clock.advance(0);

    expect(statuses.at(-1)).toMatch(/service is not running; checking again in \d+s/);
    expect(service.requests).toEqual([]);
  });

  test(
    'a configured runtime file path replaces the default',
    { options: { runtimeFile: '/srv/attention/runtime.json' } },
    async ($, on) => {
      const clock = mock.clock(on);
      const read: string[] = [];
      on('session.start', ($, e) => ({ cwd: e.cwd }));
      on('command.register', ($, e) => ({ value: { command: e.name } }));
      on('env.get', () => ({ value: '/home/someone' }));
      on('fs.read', ($, e) => {
        read.push(e.path);
        return { deny: 'no such file' };
      });
      on('ui.status', () => ({ value: undefined }));

      await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
      await clock.advance(0);

      expect(read).toEqual(['/srv/attention/runtime.json']);
    },
  );
});
