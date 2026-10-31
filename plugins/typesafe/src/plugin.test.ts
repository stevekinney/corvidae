import { createBureau, type AgentDefinitions, type Bureau } from '@lostgradient/bureau';
import { createPluginTestHost } from '@lostgradient/bureau/testing';
import { pluginContract } from '@lostgradient/interborough-plugin/testing';
import { typesafeJev } from '@lostgradient/operative-typesafe';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import plugin, { TYPESAFE_API_KEY_SECRET } from './plugin.ts';

pluginContract(plugin, { createHost: createPluginTestHost });

const FIRST_KEY = 'fixture-typesafe-key-first';
const SECOND_KEY = 'fixture-typesafe-key-second';
const realFetch = globalThis.fetch;
let authorizations: (string | null)[] = [];

beforeEach(() => {
  authorizations = [];
  // The TypeSafe endpoint, faked: a recorded boolean answer of the shape the peer reads. Nothing
  // leaves the process.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    authorizations.push(request.headers.get('authorization'));
    return new Response(
      JSON.stringify({
        model: 'jev-1.14.0',
        answers: { decision: { type: 'noul', noul: 0.99 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
});

const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

/** A secrets reader the test saves to and removes from, notifying watchers as the host does. */
function secretsStore() {
  const values = new Map<string, string>();
  const watchers = new Map<string, Set<() => void>>();
  return {
    get: async (key: string) => values.get(key),
    watch(key: string, listener: () => void) {
      const set = watchers.get(key) ?? new Set();
      set.add(listener);
      watchers.set(key, set);
      return () => set.delete(listener);
    },
    save(key: string, value: string) {
      values.set(key, value);
      for (const listener of watchers.get(key) ?? []) listener();
    },
  };
}

async function statusOf(bureau: Bureau<AgentDefinitions>): Promise<string | undefined> {
  // Every Bureau also lists its built-in `bureau` plugin first (COR-1890).
  const listings = await bureau.plugins.list();
  return listings.find((listing) => listing.source !== 'built-in')?.status;
}

async function waitUntilStatus(bureau: Bureau<AgentDefinitions>, status: string): Promise<void> {
  await waitUntil(async () => (await statusOf(bureau)) === status, {
    message: `the plugin to be ${status}`,
  });
}

async function startBureau(secrets: ReturnType<typeof secretsStore>) {
  const bureau = await createBureau<AgentDefinitions>({
    agents: {},
    plugins: [{ descriptor: plugin, source: 'package', location: '@lostgradient/plugin-typesafe' }],
    pluginSecrets: secrets,
    // COR-1879 checks this name after composition, so the plugin's own model can be named.
    decisions: { model: 'typesafe:jev' },
  });
  bureaus.push(bureau);
  return bureau;
}

describe('the typesafe plugin', () => {
  test('declares the typesafe-api-key secret the host has always used', () => {
    expect(TYPESAFE_API_KEY_SECRET).toBe('typesafe-api-key');
    expect(plugin.secrets).toEqual(['typesafe-api-key']);
  });

  test('contributes the Jev model as `jev` serving the kinds Jev serves', async () => {
    const result = await plugin.setup?.({ secrets: { get: async () => undefined } } as never);
    expect(result?.decisionRouters?.map((model) => model.name)).toEqual(['jev']);
    const jev = typesafeJev({ apiKey: FIRST_KEY });
    expect([...(result?.decisionRouters?.[0]?.kinds ?? [])].toSorted()).toEqual(
      [...jev.kinds].toSorted(),
    );
  });

  test('contributes nothing else', async () => {
    const result = await plugin.setup?.({ secrets: { get: async () => undefined } } as never);
    expect(Object.keys(result ?? {})).toEqual(['decisionRouters']);
  });

  test('starts needs-setup without the key, and decisions refuse without reaching TypeSafe', async () => {
    const bureau = await startBureau(secretsStore());

    // Every Bureau also lists its built-in `bureau` plugin first (COR-1890).
    const listings = await bureau.plugins.list();
    const listing = listings.find((entry) => entry.source !== 'built-in');
    expect(listing?.status).toBe('needs-setup');
    expect(listing?.problems).toEqual([
      { code: 'secret-missing', key: 'typesafe-api-key', contributions: ['typesafe:jev'] },
    ]);
    const failure = await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ name: 'PluginNeedsSetupError', plugin: 'typesafe' });
    expect(authorizations).toEqual([]);
  });

  test('answers with typesafe:jev as soon as the key is saved, with no restart, and follows a changed key', async () => {
    const secrets = secretsStore();
    const bureau = await startBureau(secrets);
    expect(await statusOf(bureau)).toBe('needs-setup');

    secrets.save(TYPESAFE_API_KEY_SECRET, FIRST_KEY);
    await waitUntilStatus(bureau, 'running');
    const decision = await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });

    expect(decision).toMatchObject({ value: true, provider: 'typesafe' });
    expect(authorizations).toEqual([`Bearer ${FIRST_KEY}`]);

    secrets.save(TYPESAFE_API_KEY_SECRET, SECOND_KEY);
    await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' });
    expect(authorizations).toEqual([`Bearer ${FIRST_KEY}`, `Bearer ${SECOND_KEY}`]);
  });

  test('never puts the key in a failure', async () => {
    const secrets = secretsStore();
    secrets.save(TYPESAFE_API_KEY_SECRET, FIRST_KEY);
    globalThis.fetch = (async () =>
      new Response('refused', { status: 500 })) as unknown as typeof fetch;
    const bureau = await startBureau(secrets);

    const failure = await bureau.decisions.decide({ kind: 'boolean', question: 'Is it?' }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeDefined();
    expect(String(failure)).not.toContain(FIRST_KEY);
  });
});
