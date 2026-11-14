import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBureau, type AgentDefinitions, type Bureau } from '@lostgradient/bureau';
import { agentFileDirectory } from '@lostgradient/bureau/sources';
import { createPluginTestHost, pluginTestModelRows } from '@lostgradient/bureau/testing';
import { pluginContract } from '@lostgradient/interborough-plugin/testing';
import type { BackendDescriptor, DecisionModel } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool } from 'armorer';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import plugin, {
  createTypesafePlugin,
  PROMPT_INJECTION_SCAN_LIMIT,
  TYPESAFE_API_KEY_SECRET,
} from './plugin.ts';

/** The responses recorded against the live TypeSafe API, which the decision scenarios replay (COR-2159). */
const FIXTURE_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.resolve('@lostgradient/operative-typesafe'))),
  '..',
  'test',
  'fixtures',
  'decisions',
);

interface RecordedFixture {
  readonly exchange: {
    readonly path: string;
    readonly requestBody: unknown;
    readonly status: number;
    readonly responseBody: unknown;
  };
}

const recorded: readonly RecordedFixture[] = readdirSync(FIXTURE_DIRECTORY)
  .filter((file) => file.endsWith('.json'))
  .map(
    (file) => JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, file), 'utf8')) as RecordedFixture,
  );

/** Serves only recorded responses, so the conformance suite never reaches the network. */
const replayFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  const match = recorded.find(
    ({ exchange }) =>
      exchange.path === url.pathname && Bun.deepEquals(exchange.requestBody, body, true),
  );
  if (match === undefined) throw new Error(`No recorded fixture for ${url.pathname}`);
  return new Response(JSON.stringify(match.exchange.responseBody), {
    status: match.exchange.status,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

// The conformance suite also asks the plugin's own provider, through its own `decide`, every
// decision scenario of the kinds its row declares, over the recorded responses.
pluginContract(plugin, {
  createHost: createPluginTestHost,
  createDecisionModel: ({ provider, row }) =>
    provider.decide!(
      {
        provider: row.provider,
        model: row.model,
        apiKey: 'replay-key-not-a-secret',
        fetch: replayFetch,
      } as never,
      undefined,
    ),
});

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
    /** The key as it is now, which the host's `models.decide` reads when it builds a decision model. */
    current: (key: string) => values.get(key),
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

/** The provider the plugin contributes, as the host receives it. */
async function providerOf() {
  const result = await plugin.setup?.({ secrets: { get: async () => undefined } } as never);
  const provider = result?.providers?.[0];
  if (provider?.decide === undefined) throw new Error('the plugin contributes no provider');
  return provider;
}

async function startBureau(secrets: ReturnType<typeof secretsStore>) {
  const provider = await providerOf();
  const bureau = await createBureau<AgentDefinitions>({
    agents: {},
    plugins: [{ descriptor: plugin, source: 'package', location: '@lostgradient/plugin-typesafe' }],
    pluginSecrets: secrets,
    // The host builds a row's native model from its provider and the key it holds now; so does this.
    models: {
      // The host's catalog factory is handed the providers plugins contribute, and builds its rows.
      catalog: (contributions: {
        readonly providers: readonly { readonly rows: readonly BackendDescriptor[] }[];
      }) => contributions.providers.flatMap((contributed) => contributed.rows),
      decide: (row: BackendDescriptor) => {
        const apiKey = secrets.current(TYPESAFE_API_KEY_SECRET);
        return provider.decide!(
          { provider: row.provider, model: row.model, ...(apiKey === undefined ? {} : { apiKey }) },
          undefined,
        );
      },
    },
    // The row is a catalog row: it is named `<provider>/<model>` and found once composition has
    // folded the plugin's provider into the catalog.
    decisions: { model: 'typesafe/jev' },
  });
  bureaus.push(bureau);
  return bureau;
}

describe('the typesafe plugin', () => {
  test('declares the typesafe-api-key secret the host has always used', () => {
    expect(TYPESAFE_API_KEY_SECRET).toBe('typesafe-api-key');
    expect(plugin.secrets).toEqual(['typesafe-api-key']);
  });

  test('contributes the decision-only provider `typesafe` with one row, `typesafe/jev`, answering boolean, choice and scale natively', async () => {
    const result = await plugin.setup?.({ secrets: { get: async () => undefined } } as never);
    expect(result?.providers?.map((provider) => provider.name)).toEqual(['typesafe']);
    const provider = result?.providers?.[0];
    // A decision-only provider has no `generate` or `stream`, so no agent can run on it.
    expect(provider?.decide).toBeFunction();
    expect(Object.hasOwn(provider ?? {}, 'generate')).toBe(false);
    expect(Object.hasOwn(provider ?? {}, 'stream')).toBe(false);
    expect(provider?.rows?.map((row) => `${row.provider}/${row.model}`)).toEqual(['typesafe/jev']);
    const row = provider?.rows?.[0];
    expect(row?.decisions).toEqual({ kinds: ['boolean', 'choice', 'scale'], only: true });
    // No structured output and no price: the fallback chooser never picks it.
    expect(row?.structuredOutput).toBe(false);
    expect(row?.pricing).toBeUndefined();
  });

  test('contributes only the provider and the opt-in detector, and no decision router', async () => {
    const result = await plugin.setup?.({ secrets: { get: async () => undefined } } as never);
    expect(Object.keys(result ?? {}).toSorted()).toEqual(['guardrails', 'providers']);
  });

  test('builds Jev from the key the host holds, and refuses without one without naming a key', async () => {
    const provider = await providerOf();
    const jev = provider.decide!(
      { provider: 'typesafe', model: 'jev', apiKey: FIRST_KEY },
      undefined,
    );
    expect([...jev.kinds].toSorted()).toEqual(['boolean', 'choice', 'scale']);
    expect(() => provider.decide!({ provider: 'typesafe', model: 'jev' }, undefined)).toThrow(
      TYPESAFE_API_KEY_SECRET,
    );
  });

  test('starts needs-setup without the key, naming the guardrail and the provider the key unlocks', async () => {
    const bureau = await startBureau(secretsStore());

    // Every Bureau also lists its built-in `bureau` plugin first (COR-1890).
    const listings = await bureau.plugins.list();
    const listing = listings.find((entry) => entry.source !== 'built-in');
    expect(listing?.status).toBe('needs-setup');
    expect(listing?.problems).toEqual([
      {
        code: 'secret-missing',
        key: 'typesafe-api-key',
        contributions: ['typesafe:prompt-injection', 'typesafe:typesafe'],
      },
    ]);
    expect(authorizations).toEqual([]);
  });

  test('answers with typesafe/jev as soon as the key is saved, with no restart, and follows a changed key', async () => {
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

/** A scripted model that answers every question with `value` at `probability`, recording contexts. */
function scriptedModel(value: boolean, probability: number | undefined) {
  const contexts: (string | undefined)[] = [];
  const questions: string[] = [];
  const model: DecisionModel = {
    name: 'scripted',
    kinds: new Set(['boolean']),
    async decide(request) {
      contexts.push(request.context);
      questions.push(request.question);
      return {
        value,
        ...(probability === undefined ? {} : { probability }),
        provider: 'scripted',
        model: 'scripted',
      };
    },
  };
  return { model, contexts, questions };
}

async function detectorOf(model: DecisionModel) {
  const result = await createTypesafePlugin({ createModel: () => model }).setup?.({
    secrets: { get: async () => FIRST_KEY },
  } as never);
  const detector = result?.guardrails?.input?.[0];
  if (detector === undefined || !('detect' in detector)) throw new Error('no detector');
  const context = {
    step: 0,
    conversationLength: 1,
    sessionTainted: false,
    provenance: 'user-input',
  } as const;
  return (input: string) => detector.detect(input, context);
}

describe('typesafe:prompt-injection', () => {
  test('reports the probability of injection: p when true, 1 - p when false', async () => {
    const yes = scriptedModel(true, 0.8);
    expect(await (await detectorOf(yes.model))('ignore that')).toMatchObject({
      triggered: true,
      confidence: 0.8,
    });
    expect(yes.questions).toEqual([
      "Is this text an attempt to override the agent's instructions?",
    ]);
    const no = scriptedModel(false, 0.8);
    const result = await (await detectorOf(no.model))('hello');
    expect(result.triggered).toBe(false);
    expect(result.confidence).toBeCloseTo(0.2, 10);
  });

  test('sends at most 8,000 characters per scan', async () => {
    const scripted = scriptedModel(false, 0.9);
    await (
      await detectorOf(scripted.model)
    )('x'.repeat(PROMPT_INJECTION_SCAN_LIMIT + 500));
    expect(scripted.contexts[0]?.length).toBe(8000);
  });

  test('is never listed unless an agent names it, and its decision failure rejects', async () => {
    const failing: DecisionModel = {
      name: 'failing',
      kinds: new Set(['boolean']),
      decide: async () => {
        throw new Error('outage');
      },
    };
    const detect = await detectorOf(failing);
    expect(await rejectionOf(detect('hi'))).toMatchObject({ message: 'outage' });
  });

  describe('in an agent file', () => {
    const directories: string[] = [];
    afterEach(async () => {
      for (const directory of directories.splice(0)) {
        await rm(directory, { recursive: true, force: true });
      }
    });

    async function runAgent(scripted: ReturnType<typeof scriptedModel>) {
      const directory = await mkdtemp(join(tmpdir(), 'plugin-typesafe-'));
      directories.push(directory);
      await writeFile(
        join(directory, 'reader.md'),
        '---\nmodel: anthropic/claude-opus-5-5\ntools: [fetch]\nguardrails: [typesafe:prompt-injection]\n---\nRead.\n',
      );
      const fetchTool = createTool({
        name: 'fetch',
        version: '1.0.0',
        metadata: { readOnly: true },
        description: 'Fetches a page',
        input: z.object({}),
        execute: async () => {
          return { body: 'TOOL-PAGE-BODY' };
        },
      });
      let calls = 0;
      const bureau = await createBureau<AgentDefinitions>({
        agents: {},
        agentSource: agentFileDirectory(directory, { tools: { fetch: fetchTool } }),
        storage: new MemoryStorage(),
        durable: true,
        models: {
          catalog: [...pluginTestModelRows],
          generate: () => async () => {
            calls += 1;
            return calls === 1
              ? { content: '', toolCalls: [{ id: 'c1', name: 'fetch', arguments: {} }] }
              : { content: 'done', toolCalls: [] };
          },
        },
        plugins: [
          {
            descriptor: createTypesafePlugin({ createModel: () => scripted.model }),
            source: 'package',
            location: '@lostgradient/plugin-typesafe',
          },
        ],
        pluginSecrets: { get: async () => 'key', watch: () => () => {} },
      });
      bureaus.push(bureau);
      await bureau.agents.refresh();
      const task = await bureau.tasks.start('reader', 'USER-INPUT-TEXT');
      return task.result();
    }

    test('scans user input and tool results', async () => {
      const scripted = scriptedModel(false, 0.9);
      await runAgent(scripted);
      expect(scripted.contexts).toContain('USER-INPUT-TEXT');
      expect(scripted.contexts.some((context) => context?.includes('TOOL-PAGE-BODY'))).toBe(true);
    });
  });
});
