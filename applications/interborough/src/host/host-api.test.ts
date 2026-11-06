/**
 * COR-2019 — Interborough's own API on a running host: its description at `/api/openapi.json`, the
 * session at `/host/session` holding every scope, operations answered over the host's Bureau, and
 * Weft's engine operations under `/api/v1` still relayed as before. A host whose session lacks the
 * four write scopes the pages need refuses the Bureau operations and settings routes they gate.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { API_SCOPES, type ApiScope } from '../lib/api-scopes.ts';
import { startHost, type Host } from './host.ts';
import { BUREAU_METHOD_SCOPES } from './scope-gate.ts';

let home: string;
let host: Host;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'interborough-api-'));
  host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
});

afterAll(async () => {
  await host.close();
  await rm(home, { recursive: true, force: true });
});

const call = (path: string, init?: RequestInit) => fetch(new URL(path, host.url), init);

describe('the host’s API', () => {
  test('describes its seven operations at /api/openapi.json, naming the host as the server', async () => {
    const response = await call('/api/openapi.json');
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      servers: { url: string }[];
      paths: Record<string, Record<string, unknown>>;
    };
    expect(document.servers).toEqual([{ url: host.url.origin }]);
    expect(Object.values(document.paths).flatMap((methods) => Object.keys(methods))).toHaveLength(
      7,
    );
  });

  test('says the session is the local person, holding every scope', async () => {
    const session = await call('/host/session');
    expect(await session.json()).toEqual({
      subject: 'anonymous:local',
      scopes: [...API_SCOPES],
    });
  });

  test('answers its operations over the Bureau', async () => {
    const runs = await call('/api/runs');
    expect(runs.status).toBe(200);
    expect(await runs.json()).toEqual({ runs: [], nextOffset: null });

    const agents = await call('/api/agents');
    expect(agents.status).toBe(200);
    expect(await agents.json()).toEqual({ agents: expect.any(Array) });

    const schedules = await call('/api/schedules');
    expect(schedules.status).toBe(200);

    const missing = await call('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'no-such-workflow' }),
    });
    expect(missing.status).toBe(404);
    const nothing = await call('/api/runs/run-nope');
    expect(nothing.status).toBe(404);
  });

  test('keeps relaying Weft’s engine operations under /api/v1', async () => {
    const response = await call('/api/v1/health');
    expect(response.status).toBe(200);
  });

  test('refuses a request from another origin before the operation', async () => {
    const response = await call('/api/runs', { headers: { origin: 'http://evil.example' } });
    expect(response.status).toBe(403);
  });

  test('names in the scope table only operations the Bureau serves', async () => {
    const response = await call('/bureau/openrpc.json');
    expect(response.status).toBe(200);
    const document = (await response.json()) as { methods: { name: string }[] };
    const served = new Set(document.methods.map((method) => method.name));
    expect([...BUREAU_METHOD_SCOPES.keys()].filter((method) => !served.has(method))).toEqual([]);
  });
});

describe('a session without the write scopes the pages need', () => {
  const WITHHELD: readonly ApiScope[] = [
    'schedules:write',
    'agents:write',
    'hooks:write',
    'settings:write',
  ];
  let narrowHome: string;
  let narrow: Host;

  beforeAll(async () => {
    narrowHome = await mkdtemp(join(tmpdir(), 'interborough-api-narrow-'));
    narrow = await startHost({
      environment: { INTERBOROUGH_HOME: narrowHome },
      port: 0,
      apiPrincipal: () => ({
        subject: 'anonymous:local',
        scopes: new Set(API_SCOPES.filter((scope) => !WITHHELD.includes(scope))),
      }),
    });
  });

  afterAll(async () => {
    await narrow.close();
    await rm(narrowHome, { recursive: true, force: true });
  });

  const bureau = async (method: string, params: unknown) => {
    const response = await fetch(new URL('/bureau/jsonrpc', narrow.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
    });
    return (await response.json()) as {
      result?: unknown;
      error?: { code: number; data: { scope?: string } };
    };
  };

  test.each([
    ['bureau.schedules.create', 'schedules:write'],
    ['bureau.agents.definitions.create', 'agents:write'],
    ['bureau.hooks.create', 'hooks:write'],
    ['bureau.settings.update', 'settings:write'],
  ])('refuses %s, naming %s', async (method, scope) => {
    const answer = await bureau(method, {});
    expect(answer.error?.code).toBe(-32011);
    expect(answer.error?.data.scope).toBe(scope);
  });

  test('still answers what it holds the scope for', async () => {
    const answer = await bureau('bureau.schedules.list', {});
    expect(answer.error).toBeUndefined();
    expect(answer.result).toBeDefined();
  });

  test('refuses changing a plugin or a provider, and still lists them', async () => {
    const plugin = await fetch(new URL('/host/plugins/demo', narrow.url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(plugin.status).toBe(403);
    expect(await plugin.json()).toMatchObject({ error: 'forbidden', scope: 'settings:write' });
    const provider = await fetch(new URL('/host/providers/anthropic', narrow.url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-test' }),
    });
    expect(provider.status).toBe(403);
    const listed = await fetch(new URL('/host/plugins', narrow.url));
    expect(listed.status).toBe(200);
  });

  test('says the session holds only the scopes it was given', async () => {
    const response = await fetch(new URL('/host/session', narrow.url));
    const session = (await response.json()) as { scopes: string[] };
    expect(session.scopes).toEqual(API_SCOPES.filter((scope) => !WITHHELD.includes(scope)));
  });
});
