/**
 * COR-1886 — the host's decision model is the typesafe plugin's `typesafe:jev`, the default of the
 * `decisions.model` setting. With the `typesafe-api-key` secret in Bungalow's secrets, Bureau's
 * decisions are answered by Jev for the kinds it serves. Without it the host starts all the same,
 * the plugin is `needs-setup`, and a decision routed to Jev refuses until the key is saved, with no
 * restart. No test reaches the network: `fetch` is replaced for the whole file, and the key is a
 * fixture.
 */
import { openBungalow } from '@lostgradient/bungalow';
import { TYPESAFE_API_KEY_SECRET } from '@lostgradient/plugin-typesafe';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { startHost, type Host } from './host.ts';

const FIXTURE_KEY = 'fixture-typesafe-key-51c9';
const directories: string[] = [];
const hosts: Host[] = [];
const realFetch = globalThis.fetch;
let requests: Request[] = [];

beforeEach(() => {
  requests = [];
  // Any request the decision model makes lands here and is refused, so nothing leaves the process.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return new Response('refused by the test', { status: 500 });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function startWith(secrets: Readonly<Record<string, string>>): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-decisions-'));
  directories.push(home);
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  try {
    for (const [key, value] of Object.entries(secrets)) bungalow.writeSecret(key, value);
  } finally {
    bungalow.close();
  }
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
  hosts.push(host);
  return host;
}

async function typesafeListing(host: Host) {
  const listings = await host.bureau.plugins.list();
  return listings.find(({ descriptor }) => descriptor.name === 'typesafe');
}

const decide = (host: Host, request: Parameters<Host['bureau']['decisions']['decide']>[0]) =>
  host.bureau.decisions.decide(request).then(
    () => undefined,
    (error: unknown) => error,
  );

describe('the TypeSafe decision model', () => {
  test('starts without the typesafe-api-key secret, with the plugin needs-setup and decisions unavailable', async () => {
    const host = await startWith({});

    const listing = await typesafeListing(host);
    expect(listing?.status).toBe('needs-setup');
    const failure = await decide(host, { kind: 'boolean', question: 'Is it?' });

    expect(failure).toMatchObject({ name: 'PluginNeedsSetupError', plugin: 'typesafe' });
    expect(requests).toEqual([]);
  });

  test('uses typesafe:jev for the next decision once the key is saved, with no restart', async () => {
    const host = await startWith({});
    expect(await decide(host, { kind: 'boolean', question: 'Is it?' })).toMatchObject({
      name: 'PluginNeedsSetupError',
    });

    await host.plugins.saveSecret('typesafe', TYPESAFE_API_KEY_SECRET, FIXTURE_KEY);
    // The gate re-reads the key when the host's watch reports it saved; the plugin runs once it has.
    await waitUntil(
      async () => {
        const listing = await typesafeListing(host);
        return listing?.status === 'running';
      },
      {
        message: 'the typesafe plugin to run after its key was saved',
      },
    );
    const failure = await decide(host, { kind: 'boolean', question: 'Is it?' });

    // The refused request is TypeSafe's, not a needs-setup refusal or a fallback's.
    expect(failure).toBeDefined();
    expect(failure).not.toMatchObject({ name: 'PluginNeedsSetupError' });
    expect(requests.length).toBeGreaterThan(0);
    expect(String(failure)).not.toContain(FIXTURE_KEY);
  });

  test('starts with the typesafe-api-key secret and asks TypeSafe for a boolean', async () => {
    const host = await startWith({ [TYPESAFE_API_KEY_SECRET]: FIXTURE_KEY });

    const listing = await typesafeListing(host);
    expect(listing?.status).toBe('running');
    const failure = await decide(host, { kind: 'boolean', question: 'Is it?' });

    // The refused request is TypeSafe's, not a fallback's: the fallback has no row to run.
    expect(failure).toBeDefined();
    expect(failure).not.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(requests.length).toBeGreaterThan(0);
    expect(String(failure)).not.toContain(FIXTURE_KEY);
  });

  test('sends a kind TypeSafe does not serve to the fallback even with the key', async () => {
    const host = await startWith({ [TYPESAFE_API_KEY_SECRET]: FIXTURE_KEY });

    const failure = await decide(host, {
      kind: 'structured',
      question: 'Name it',
      schema: z.object({}),
    });

    expect(failure).toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(requests).toEqual([]);
  });

  test('makes typesafe:jev the default decision model, and `catalog` in the settings sends every kind to the fallback', async () => {
    const host = await startWith({ [TYPESAFE_API_KEY_SECRET]: FIXTURE_KEY });
    const snapshot = await host.bureau.settings.get();
    expect(snapshot.values['decisions.model']).toBe('typesafe:jev');

    const changed = await host.bureau.settings.update(
      { 'decisions.model': 'catalog' },
      { expectedRevision: snapshot.revision },
    );
    expect(changed).toMatchObject({ outcome: 'applied' });
    const failure = await decide(host, { kind: 'boolean', question: 'Is it?' });

    // The next decision no longer asks TypeSafe: the catalog has no row to fall back to.
    expect(failure).toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(requests).toEqual([]);
  });

  test('offers typesafe:jev without the secret, since the plugin contributes it either way', async () => {
    const host = await startWith({});
    const { values } = await host.bureau.settings.get();
    expect(values['decisions.model']).toBe('typesafe:jev');
    const refused = await host.bureau.settings.update(
      { 'decisions.model': 'typesafe' },
      { expectedRevision: 0 },
    );
    expect(refused).toMatchObject({ outcome: 'rejected', reason: 'invalid-value' });
  });

  test('starts with no default decision model when the owner disabled the plugin', async () => {
    const home = await mkdtemp(join(tmpdir(), 'interborough-decisions-'));
    directories.push(home);
    await writeFile(
      join(home, 'configuration.json'),
      JSON.stringify({ plugins: { typesafe: { enabled: false } } }),
    );
    const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
    hosts.push(host);

    const { values } = await host.bureau.settings.get();
    expect(values['decisions.model']).toBeUndefined();
  });
});
