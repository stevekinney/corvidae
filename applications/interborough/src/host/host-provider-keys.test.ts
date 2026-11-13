/**
 * COR-2009 (`host:provider-keys`): a provider's key is its plugin's own secret, whichever page
 * stores it. Models › Connect writes it through the provider route, Plugins › Add the key through
 * the plugin's secret route, and either way the provider's models are offered at once, with no
 * restart (SettingsShell "Models", PageSettingsSections "Plugin problems").
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';

const KEY = 'fixture-gemini-key-2b9c';
const homes: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** A host on a new home with the plugins the workspace ships, none of them keyed. */
async function start(): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-provider-keys-'));
  homes.push(home);
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
  hosts.push(host);
  return host;
}

function geminiRows(host: Host) {
  return host.bureau.models.catalog().descriptors.filter((row) => row.provider === 'gemini');
}

/** The Gemini models a run can use now: rows kept for a missing key are `unavailable`. */
function geminiModels(host: Host): string[] {
  return geminiRows(host)
    .filter((row) => row.availability !== 'unavailable')
    .map((row) => row.model);
}

async function geminiPlugin(host: Host) {
  const response = await fetch(new URL('/host/plugins', host.url));
  const body = (await response.json()) as {
    plugins: {
      descriptor: { name: string };
      status: string;
      restartRequired: boolean;
      secrets: unknown[];
    }[];
  };
  return body.plugins.find((plugin) => plugin.descriptor.name === 'gemini');
}

async function put(host: Host, path: string, body: unknown): Promise<Response> {
  const snapshot = await host.providers.snapshot();
  return fetch(new URL(path, host.url), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(typeof body === 'object' && body !== null ? body : {}),
      operationId: crypto.randomUUID(),
      expectedRevision: snapshot.configurationRevision,
    }),
  });
}

describe('a provider’s key', () => {
  test('starts unset: Gemini needs setup, missing gemini-api-key, and offers no model', async () => {
    const host = await start();
    expect(geminiModels(host)).toEqual([]);
    expect(await geminiPlugin(host)).toMatchObject({
      status: 'needs-setup',
      secrets: [{ key: 'gemini-api-key', set: false }],
    });
  });

  test('keeps its rows unavailable until the key is saved, then flips them with no restart (COR-2143)', async () => {
    const host = await start();
    const unset = geminiRows(host);
    expect(unset.length).toBeGreaterThan(0);
    expect(unset.every((row) => row.availability === 'unavailable')).toBe(true);
    // A row that is kept names its key where a model the catalog lacks would say "no such model".
    expect(() => host.generateFor({ provider: 'gemini', model: unset[0]!.model })).toThrow(
      /needs its API key: save the secret "gemini-api-key"/,
    );
    expect(() => host.generateFor({ provider: 'gemini', model: 'no-such-model' })).toThrow(
      /holds no "no-such-model" model/,
    );

    const response = await put(host, '/host/providers/gemini', { apiKey: KEY });
    expect(response.status).toBe(200);

    const saved = geminiRows(host);
    expect(saved.map((row) => row.model)).toEqual(unset.map((row) => row.model));
    expect(saved.every((row) => row.availability !== 'unavailable')).toBe(true);
    expect(() => host.generateFor({ provider: 'gemini', model: saved[0]!.model })).not.toThrow();
  });

  test('is written by Connect as the Gemini plugin’s gemini-api-key, which runs it with no restart', async () => {
    const host = await start();
    const response = await put(host, '/host/providers/gemini', { apiKey: KEY });
    expect(response.status).toBe(200);
    expect(geminiModels(host).length).toBeGreaterThan(0);
    expect(await geminiPlugin(host)).toMatchObject({
      status: 'running',
      restartRequired: false,
      secrets: [{ key: 'gemini-api-key', set: true }],
    });
  });

  test('saved on the plugin’s secret route offers the provider’s models at once, with no restart', async () => {
    const host = await start();
    const response = await put(host, '/host/plugins/gemini/secrets/gemini-api-key', { value: KEY });
    expect(response.status).toBe(200);
    expect(geminiModels(host).length).toBeGreaterThan(0);
    const read = await fetch(new URL('/host/providers', host.url));
    const providers = (await read.json()) as {
      providers: { name: string; hasKey: boolean }[];
    };
    expect(providers.providers.find((provider) => provider.name === 'gemini')).toMatchObject({
      hasKey: true,
      connected: true,
    });
    expect(await geminiPlugin(host)).toMatchObject({ status: 'running', restartRequired: false });
  });
});
