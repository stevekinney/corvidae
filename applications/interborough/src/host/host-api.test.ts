/**
 * COR-2019 — Interborough's own API on a running host: its description at `/api/openapi.json`, the
 * session at `/host/session` holding every scope, operations answered over the host's Bureau, and
 * Weft's engine operations under `/api/v1` still relayed as before.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { API_SCOPES } from '../lib/api-scopes.ts';
import { startHost, type Host } from './host.ts';

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
});
