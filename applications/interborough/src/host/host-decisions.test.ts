import { initializeWorkspaceHome } from './workspace-home.test-support.ts';
/**
 * COR-1886, COR-2154, COR-2157 — the host's decision model is the typesafe plugin's catalog row
 * `typesafe/jev`, the default of the `decisions.model` setting. With the `typesafe-api-key` secret
 * in Bungalow's secrets, Bureau's decisions are answered by Jev for the kinds it serves. Without it
 * the host starts all the same, the plugin is `needs-setup`, the row is `unavailable`, and the
 * fallback model answers until the key is saved, with no restart. No test reaches the network:
 * `fetch` is replaced for the whole file, and the keys are fixtures.
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
const ANTHROPIC_KEY = 'fixture-anthropic-key-77d2';
const directories: string[] = [];
const hosts: Host[] = [];
const realFetch = globalThis.fetch;
let requests: Request[] = [];

/** The requests that went to the host a provider names, in order. */
const sentTo = (name: string): Request[] =>
  requests.filter((request) => new URL(request.url).hostname.includes(name));

beforeEach(() => {
  requests = [];
  // Any request a decision model makes lands here, so nothing leaves the process. TypeSafe's is
  // refused. The language model the fallback runs on answers `{"answer":true}`, so a decision the
  // fallback answers settles.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    if (new URL(request.url).hostname.includes('anthropic')) {
      return Response.json({
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        content: [{ type: 'text', text: '{"answer":true}' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 2 },
      });
    }
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
    for (const [key, value] of Object.entries(secrets))
      await bungalow.deploymentSecrets.write(key, value);
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
  test('starts without the typesafe-api-key secret, with the plugin needs-setup, and the fallback answers a boolean decision', async () => {
    const host = await startWith({ 'anthropic-api-key': ANTHROPIC_KEY });

    const listing = await typesafeListing(host);
    expect(listing?.status).toBe('needs-setup');
    const row = host.bureau.models
      .catalog()
      .descriptors.find((candidate) => candidate.provider === 'typesafe');
    expect(row).toMatchObject({ model: 'jev', availability: 'unavailable' });
    const decision = await host.bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });

    // The row is unavailable, so the fallback answers: not a `PluginNeedsSetupError`, and nothing
    // is sent to TypeSafe.
    expect(decision).toMatchObject({ value: true, provider: 'anthropic' });
    expect(sentTo('typesafe')).toEqual([]);
    expect(sentTo('anthropic').length).toBeGreaterThan(0);
  });

  test('uses typesafe/jev for the next decision once the key is saved, with no restart', async () => {
    const host = await startWith({ 'anthropic-api-key': ANTHROPIC_KEY });
    expect(
      await host.bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' }),
    ).toMatchObject({ provider: 'anthropic' });
    expect(sentTo('typesafe')).toEqual([]);

    await host.plugins.saveSecret('typesafe', TYPESAFE_API_KEY_SECRET, FIXTURE_KEY);
    // The plugin runs once the host's watch has reported the key saved, and the row is available.
    await waitUntil(
      async () => {
        const listing = await typesafeListing(host);
        const row = host.bureau.models
          .catalog()
          .descriptors.find((candidate) => candidate.provider === 'typesafe');
        return listing?.status === 'running' && row?.availability !== 'unavailable';
      },
      {
        message: 'the typesafe plugin to run, and its row to be available, after its key was saved',
      },
    );
    const failure = await decide(host, { kind: 'boolean', question: 'Is it?' });

    // The refused request is TypeSafe's, not a needs-setup refusal or a fallback's answer.
    expect(failure).toBeDefined();
    expect(failure).not.toMatchObject({ name: 'PluginNeedsSetupError' });
    expect(sentTo('typesafe').length).toBeGreaterThan(0);
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

  test('makes typesafe/jev the default decision model, and a catalog row with no key in the settings sends every kind to the fallback', async () => {
    const host = await startWith({ [TYPESAFE_API_KEY_SECRET]: FIXTURE_KEY });
    const snapshot = await host.bureau.settings.get();
    expect(snapshot.values['decisions.model']).toBe('typesafe/jev');

    // `catalog` is no longer a choice; a row whose provider has no key saved is unavailable.
    const changed = await host.bureau.settings.update(
      { 'decisions.model': 'anthropic/claude-haiku-5-5' },
      { expectedRevision: snapshot.revision },
    );
    expect(changed).toMatchObject({ outcome: 'applied' });
    const failure = await decide(host, { kind: 'boolean', question: 'Is it?' });

    // The next decision no longer asks TypeSafe: the catalog has no row to fall back to.
    expect(failure).toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(requests).toEqual([]);
  });

  test('accepts typesafe/jev without the secret, since the plugin contributes its row either way, and refuses a name that is no row', async () => {
    const host = await startWith({});
    const { values, revision } = await host.bureau.settings.get();
    expect(values['decisions.model']).toBe('typesafe/jev');
    const refused = await host.bureau.settings.update(
      { 'decisions.model': 'typesafe' },
      { expectedRevision: revision },
    );
    expect(refused).toMatchObject({ outcome: 'rejected', reason: 'invalid-value' });
    const unknown = await host.bureau.settings.update(
      { 'decisions.model': 'nope/none' },
      { expectedRevision: revision },
    );
    expect(unknown).toMatchObject({ outcome: 'rejected', reason: 'invalid-value' });
    const saved = await host.bureau.settings.update(
      { 'decisions.model': 'typesafe/jev' },
      { expectedRevision: revision },
    );
    expect(saved).toMatchObject({ outcome: 'applied' });
  });

  test('starts with no default decision model when the owner disabled the plugin', async () => {
    const home = await mkdtemp(join(tmpdir(), 'interborough-decisions-'));
    await initializeWorkspaceHome(home);
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
