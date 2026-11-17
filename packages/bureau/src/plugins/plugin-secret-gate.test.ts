/**
 * COR-1879 — a plugin missing a declared secret loads `needs-setup`, its contributions refuse until
 * the host's `watch` reports the secret saved, and refuse again once it is removed, with no restart.
 */
import {
  definePlugin,
  type PluginContributions,
  type PluginGuardrailFactory,
  type PluginTriggerContext,
} from '@lostgradient/interborough-plugin';
import {
  createAgent,
  createInputGuardrail,
  createOutputGuardrail,
  createToolCallGuardrail,
  guardrailOf,
  hasDefinitionResolver,
  type InputDetector,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  type OutputValidator,
  type ToolCallValidator,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import type { AgentDefinitions } from '../agent-catalog';
import { INTERCEPTOR_POINTS } from '../agent-contributions';
import { createBureau } from '../create-bureau';
import { DiagnosticEvent } from '../events';
import { waitForCondition } from '../test';
import type { Bureau } from '../bureau-types/facade';
import type { HookActionKindRegistration } from '../hooks/hook-types';
import type { BureauDiagnostic } from '../bureau-types/options';
import { composePlugins } from './compose-plugins';
import {
  createPluginSecretGate,
  gatedContributions,
  PLUGIN_NEEDS_SETUP_CATEGORY,
  PluginNeedsSetupError,
  type PluginSecretGate,
} from './plugin-secret-gate';
import type { BureauPluginSecrets } from './plugin-types';
import { listedPlugins } from '../testing/plugin-listing.test-support';
import { listenForReports } from '../workflow-trigger-reports';

const SECRET = 'sk-live-gate-0123456789';
const KEY = 'kit-api-key';

/** For a test that does not read the diagnostics a gate sends. */
const ignoreDiagnostics = () => undefined;

/** A secrets reader the test saves to and removes from, notifying watchers as a host would. */
function secretsStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const watchers = new Map<string, Set<() => void>>();
  const notify = (key: string) => {
    for (const listener of watchers.get(key) ?? []) listener();
  };
  const reader: BureauPluginSecrets & {
    save(key: string, value: string): void;
    remove(key: string): void;
    watching(key: string): number;
  } = {
    get: async (key) => values.get(key),
    watch(key, listener) {
      const set = watchers.get(key) ?? new Set();
      set.add(listener);
      watchers.set(key, set);
      return () => set.delete(listener);
    },
    save(key, value) {
      values.set(key, value);
      notify(key);
    },
    remove(key) {
      values.delete(key);
      notify(key);
    },
    watching: (key) => watchers.get(key)?.size ?? 0,
  };
  return reader;
}

const bureaus: Bureau<AgentDefinitions>[] = [];
const stops: (() => void)[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  for (const stop of stops.splice(0)) stop();
});

const event = { kind: 'run.settled', bureauId: 'b', emittedAtMs: 0, payload: {} };

describe('a plugin missing a declared secret', () => {
  it('loads needs-setup with secret-missing, and its contributions work once watch reports the secret, with no restart', async () => {
    const secrets = secretsStore();
    const kit = definePlugin({
      name: 'kit',
      version: '1.0.0',
      description: 'Needs an API key.',
      secrets: [KEY],
      setup: () => ({
        tools: [
          createTool({ name: 'lookup', description: 'Looks up', execute: async () => 'found' }),
        ],
        formatters: [
          { name: 'fmt', eventKinds: ['run.settled'], format: () => ({ title: 'Formatted' }) },
        ],
      }),
    });
    const bureau = await createBureau<AgentDefinitions>({
      plugins: [{ descriptor: kit, source: 'package', location: '@example/kit' }],
      pluginSecrets: secrets,
    });
    bureaus.push(bureau);

    const statusOf = async () => {
      const [listing] = await listedPlugins(bureau);
      return listing?.status;
    };
    const [missing] = await listedPlugins(bureau);
    expect(missing?.status).toBe('needs-setup');
    // Its contributions are registered, so a tool call of it is named `kit:lookup` all the same.
    expect(bureau.plugins.registered()).toEqual(['bureau', 'kit']);
    expect(missing?.problems).toEqual([
      { code: 'secret-missing', key: KEY, contributions: ['kit:lookup@1.0.0', 'kit:fmt'] },
    ]);
    expect(missing?.contributions.map(({ id }) => id)).toEqual(['kit:lookup@1.0.0', 'kit:fmt']);
    // Registered at construction, refusing until the secret is saved: the default title.
    expect(bureau.formatEvent(event).title).toBe('run.settled');

    secrets.save(KEY, SECRET);
    await waitForCondition(
      async () => (await statusOf()) === 'running',
      'the plugin did not run after its secret was saved',
    );
    const [running] = await listedPlugins(bureau);
    expect(running?.problems).toEqual([]);
    expect(bureau.formatEvent(event).title).toBe('Formatted');
    expect(JSON.stringify(await bureau.plugins.list())).not.toContain(SECRET);

    secrets.remove(KEY);
    await waitForCondition(
      async () => (await statusOf()) === 'needs-setup',
      'the plugin kept running after its secret was removed',
    );
    expect(bureau.formatEvent(event).title).toBe('run.settled');

    await bureau.dispose();
    bureaus.length = 0;
    expect(secrets.watching(KEY)).toBe(0);
  });

  it('refuses to start a code agent through bureau.tasks.start until the secret is saved', async () => {
    const secrets = secretsStore();
    let generated = 0;
    const kit = definePlugin({
      name: 'kit',
      version: '1.0.0',
      description: 'Needs an API key.',
      secrets: [KEY],
      setup: () => ({
        agents: [
          {
            name: 'writer',
            agent: createAgent({
              generate: async () => {
                generated += 1;
                return { content: 'done', toolCalls: [] };
              },
            }),
          },
        ],
      }),
    });
    const bureau = await createBureau<AgentDefinitions>({
      plugins: [{ descriptor: kit, source: 'package', location: '@example/kit' }],
      pluginSecrets: secrets,
    });
    bureaus.push(bureau);

    // Bureau starts a catalog agent through its definition resolver, not `run`: the refusal is
    // the resolver's, and it reaches the caller before the model is ever called.
    const refusal = await rejectionOf(bureau.tasks.start('kit:writer', 'Go.'));
    expect(refusal).toBeInstanceOf(PluginNeedsSetupError);
    expect(generated).toBe(0);

    secrets.save(KEY, SECRET);
    await waitForCondition(async () => {
      const [listing] = await listedPlugins(bureau);
      return listing?.status === 'running';
    }, 'the plugin did not run after its secret was saved');
    const task = await bureau.tasks.start('kit:writer', 'Go.');
    await task.result();
    expect(generated).toBe(1);
  });

  it('gates a contributed tool and reports an embedder’s availability through composition', async () => {
    const secrets = secretsStore();
    const composed = await composePlugins({
      plugins: [
        {
          descriptor: definePlugin({
            name: 'kit',
            version: '1.0.0',
            description: 'Needs an API key.',
            secrets: [{ key: KEY, generated: true }],
            setup: () => ({
              tools: [
                createTool({
                  name: 'lookup',
                  description: 'Looks up',
                  input: z.object({}),
                  execute: async () => 'found',
                }),
              ],
              embedders: [
                {
                  name: 'small',
                  model: 'small-model',
                  dimensions: 2,
                  embed: async (texts) => texts.map(() => [1, 0]),
                },
              ],
            }),
          }),
          source: 'package',
          location: '@example/kit',
        },
      ],
      pluginSecrets: secrets,
      memory: ({ embedders }) => ({ embedders }) as never,
    });
    stops.push(composed.watchSecrets());
    const tool = composed.tools['kit:lookup'];
    const [embedder] = (
      composed.options.memory as unknown as { embedders: { availability?: () => string }[] }
    ).embedders;
    // Armorer reports a tool's failure as an error carrying its message.
    expect(String(await rejectionOf(tool!.execute({})))).toContain('plugin "kit" needs setup');
    expect(embedder?.availability?.()).toBe('needs-setup');

    secrets.save(KEY, SECRET);
    await waitForCondition(
      () => embedder?.availability?.() === 'available',
      'the embedder stayed needs-setup after the secret was saved',
    );
    expect(await tool!.execute({})).toBe('found');
  });
});

describe('a reaction’s registration (COR-2176)', () => {
  it('exposes its plugin gate’s availability and when it changes, and a plugin with no secret has none', async () => {
    const secrets = secretsStore();
    const reaction = (name: string) => ({
      name,
      description: 'Pages.',
      configuration: z.object({}),
      run: async () => undefined,
    });
    const composed = await composePlugins({
      plugins: [
        {
          descriptor: definePlugin({
            name: 'kit',
            version: '1.0.0',
            description: 'Needs an API key.',
            secrets: [KEY],
            setup: () => ({ reactions: [reaction('page')] }),
          }),
          source: 'package',
          location: '@example/kit',
        },
        {
          descriptor: definePlugin({
            name: 'plain',
            version: '1.0.0',
            description: 'Needs nothing.',
            setup: () => ({ reactions: [reaction('ping')] }),
          }),
          source: 'package',
          location: '@example/plain',
        },
      ],
      pluginSecrets: secrets,
      hooks: {},
    });
    stops.push(composed.watchSecrets());
    const hooks = composed.options.hooks as
      { readonly actionKinds?: readonly HookActionKindRegistration[] } | undefined;
    const registrations = hooks?.actionKinds ?? [];
    const kit = registrations.find((registration) => registration.plugin === 'kit');
    const plain = registrations.find((registration) => registration.plugin === 'plain');
    expect(plain?.availability).toBeUndefined();
    expect(plain?.onAvailabilityChange).toBeUndefined();

    expect(kit?.availability?.()).toBe('needs-setup');
    let changes = 0;
    const stop = kit?.onAvailabilityChange?.(() => {
      changes += 1;
    });
    secrets.save(KEY, SECRET);
    await waitForCondition(
      () => kit?.availability?.() === 'available',
      'the kind stayed unavailable',
    );
    expect(changes).toBeGreaterThanOrEqual(1);
    stop?.();
    secrets.remove(KEY);
    await waitForCondition(
      () => kit?.availability?.() === 'needs-setup',
      'the kind stayed available',
    );
  });
});

/** A gate over one key, with the store that drives it. */
async function gateOver(initial: Record<string, string> = {}): Promise<{
  gate: PluginSecretGate;
  secrets: ReturnType<typeof secretsStore>;
}> {
  const secrets = secretsStore(initial);
  const gate = await createPluginSecretGate('kit', [KEY], secrets);
  stops.push(gate.watch());
  return { gate, secrets };
}

async function settleTo(gate: PluginSecretGate, available: boolean): Promise<void> {
  await waitForCondition(
    () => gate.available() === available,
    `the gate did not become ${String(available)}`,
  );
}

describe('the secret-gating outcome matrix', () => {
  it('refuses every gated callable while missing, calls through once saved, and refuses again once removed', async () => {
    const { gate, secrets } = await gateOver();
    const called: string[] = [];
    const note =
      <R>(name: string, value: R) =>
      async () => {
        called.push(name);
        return value;
      };
    const gatedResult = gatedContributions<PluginContributions>(
      {
        activities: [
          {
            name: 'fetch',
            title: 'Fetch',
            inputSchema: z.object({}),
            execute: note('activity', 'fetched'),
            verify: note('activity-verify', true),
            compensate: note('activity-compensate', undefined),
            retry: { maxAttempts: 3, initialBackoff: 1, backoffMultiplier: 1, maxBackoff: 1 },
          },
        ],
        validators: [
          {
            identity: { name: 'tidy', version: '1' },
            validate: note('validator', { status: 'met' }) as never,
          },
        ],
        guardrails: {
          // Wrapped with an action of its own, which the gate keeps (COR-2104).
          input: [
            {
              guardrail: {
                name: 'scan',
                description: 'A test guardrail.',
                detect: note('guardrail-input', {}) as never,
              },
              action: 'warn',
            },
          ],
          output: [
            {
              name: 'check',
              description: 'A test guardrail.',
              validate: note('guardrail-output', {}) as never,
            },
          ],
          tools: [
            {
              name: 'cap',
              description: 'A test guardrail.',
              action: 'block',
              validate: note('guardrail-tools', {}) as never,
            },
          ],
          memory: [
            {
              name: 'tags',
              description: 'A test guardrail.',
              gates: ['recall'],
              detect: note('memory-detector', {}) as never,
            },
          ],
        },
        // A handler at every point of the hook map, each of which must refuse.
        interceptors: [
          {
            name: 'audit',
            ...Object.fromEntries(
              INTERCEPTOR_POINTS.map((point) => [point, note('interceptor', undefined)]),
            ),
          },
        ],
        reactions: [
          {
            name: 'page',
            description: 'Pages',
            configuration: z.object({}),
            run: note('reaction', undefined),
            // COR-2183: a test delivery runs `dryRun`, which is gated as `run` is.
            dryRun: note('reaction-dry-run', undefined),
            maxAttempts: 4,
          },
        ],
        embedders: [
          { name: 'small', model: 'small-model', dimensions: 1, embed: note('embedder', [[1]]) },
        ],
        scorers: [
          {
            name: 'judge',
            version: '1',
            score: note('scorer', { outcome: 'pass' as const, score: 1, message: '' }),
          },
        ],
        formatters: [
          {
            name: 'fmt',
            eventKinds: ['run.settled'],
            format: () => {
              called.push('formatter');
              return { title: 'Formatted' };
            },
          },
        ],
        agents: [
          {
            name: 'writer',
            agent: createAgent({ generate: async () => ({ content: 'done', toolCalls: [] }) }),
          },
        ],
      },
      gate,
      (name) => `kit:${name}`,
      ignoreDiagnostics,
    );
    const calls: Record<string, () => unknown> = {
      activity: () => gatedResult.activities?.[0]?.execute({}, {} as never),
      'activity-verify': () => gatedResult.activities?.[0]?.verify?.('fetched', {} as never),
      'activity-compensate': () => gatedResult.activities?.[0]?.compensate?.({}, 'fetched'),
      validator: () =>
        gatedResult.validators?.[0]?.validate({} as never, new AbortController().signal),
      'guardrail-input': () =>
        (guardrailOf(gatedResult.guardrails!.input![0]!) as InputDetector).detect('x', {} as never),
      'guardrail-output': () =>
        (guardrailOf(gatedResult.guardrails!.output![0]!) as OutputValidator).validate(
          'x',
          {} as never,
        ),
      'guardrail-tools': () =>
        (gatedResult.guardrails?.tools?.[0] as ToolCallValidator | undefined)?.validate(
          {} as never,
          {} as never,
        ),
      ...Object.fromEntries(
        INTERCEPTOR_POINTS.map((point) => [
          `interceptor ${point}`,
          () =>
            (
              gatedResult.interceptors?.[0]?.[point] as
                ((...args: unknown[]) => unknown) | undefined
            )?.({}, {}),
        ]),
      ),
      reaction: () => gatedResult.reactions?.[0]?.run({} as never),
      'reaction-dry-run': () => gatedResult.reactions?.[0]?.dryRun?.({} as never),
      embedder: () => gatedResult.embedders?.[0]?.embed(['x']),
      'memory-detector': () => gatedResult.guardrails?.memory?.[0]?.detect('x', {} as never),
      scorer: () => gatedResult.scorers?.[0]?.score({} as never, new AbortController().signal),
      formatter: () => gatedResult.formatters?.[0]?.format(event),
      agent: () => gatedResult.agents?.[0]?.agent.run('Go.'),
      // The definition resolver Bureau starts, recovers and claims a durable run through.
      'code-agent-resolver': () => {
        const agent = gatedResult.agents?.[0]?.agent;
        if (agent === undefined || !hasDefinitionResolver(agent)) return 'no resolver';
        return agent[OPERATIVE_RESOLVE_RUN_OPTIONS]('Go.', {});
      },
    };
    // Synchronous callables (a formatter, a code agent's `run`) throw; the rest reject. A memory
    // detector is not run instead: it answers that it detected nothing, without calling `detect`.
    const outcomeOf = async (call: () => unknown): Promise<'refused' | 'called' | 'not run'> => {
      try {
        const value: unknown = await call();
        const notRun =
          typeof value === 'object' &&
          value !== null &&
          Reflect.get(value, 'category') === PLUGIN_NEEDS_SETUP_CATEGORY;
        return notRun ? 'not run' : 'called';
      } catch (error) {
        if (error instanceof PluginNeedsSetupError) return 'refused';
        throw error;
      }
    };
    const outcomes = async () => {
      const result: Record<string, string> = {};
      for (const [name, call] of Object.entries(calls)) result[name] = await outcomeOf(call);
      return result;
    };
    const all = (outcome: string) =>
      Object.fromEntries(Object.keys(calls).map((name) => [name, outcome]));
    const missing = { ...all('refused'), 'memory-detector': 'not run' };

    expect(await outcomes()).toEqual(missing);
    expect(called).toEqual([]);
    // The gated memory guardrail still says where it runs, and a gated guardrail keeps its action.
    expect(gatedResult.guardrails?.memory?.[0]?.gates).toEqual(['recall']);
    expect(gatedResult.guardrails?.input?.[0]).toMatchObject({ action: 'warn' });
    expect(gatedResult.guardrails?.tools?.[0]).toMatchObject({ name: 'cap', action: 'block' });
    // A gated reaction keeps what it declares beside `run` and `dryRun`.
    expect(gatedResult.reactions?.[0]).toMatchObject({ name: 'page', maxAttempts: 4 });
    expect(await gatedResult.guardrails?.memory?.[0]?.detect('x', {} as never)).toMatchObject({
      triggered: false,
      confidence: 0,
    });
    // A refused activity is not retried: the refusal names an error the retry policy skips.
    expect(gatedResult.activities?.[0]?.retry?.nonRetryableErrors).toEqual([
      'PluginNeedsSetupError',
    ]);

    secrets.save(KEY, SECRET);
    await settleTo(gate, true);
    expect(await outcomes()).toEqual(all('called'));

    secrets.remove(KEY);
    await settleTo(gate, false);
    expect(await outcomes()).toEqual(missing);
  });

  it('gates the object form of a hook as it gates the function, and keeps what the object declares', async () => {
    const { gate, secrets } = await gateOver();
    const called: string[] = [];
    const onError = () => 'continue' as const;
    const declared = Object.fromEntries(
      INTERCEPTOR_POINTS.map((point) => [
        point,
        {
          handler: async () => {
            called.push(point);
          },
          replay: 'safe' as const,
          onError,
          priority: 7,
        },
      ]),
    );
    const [interceptor] =
      gatedContributions<PluginContributions>(
        { interceptors: [{ name: 'audit', ...declared }] },
        gate,
        (name) => `kit:${name}`,
        ignoreDiagnostics,
      ).interceptors ?? [];
    const handlerOf = (point: (typeof INTERCEPTOR_POINTS)[number]) => {
      const hook = interceptor?.[point];
      if (typeof hook !== 'object') throw new Error(`Expected ${point} to stay an object.`);
      return hook;
    };

    for (const point of INTERCEPTOR_POINTS) {
      const hook = handlerOf(point);
      expect(hook).toMatchObject({ replay: 'safe', onError, priority: 7 });
      expect(await rejectionOf((hook.handler as () => Promise<void>)())).toBeInstanceOf(
        PluginNeedsSetupError,
      );
    }
    expect(called).toEqual([]);

    secrets.save(KEY, SECRET);
    await settleTo(gate, true);
    for (const point of INTERCEPTOR_POINTS)
      await (handlerOf(point).handler as () => Promise<void>)();
    expect(called).toEqual([...INTERCEPTOR_POINTS]);
  });

  it('starts a trigger kind once the secret is saved, stops it on removal, and starts it again on a second save', async () => {
    const { gate, secrets } = await gateOver();
    const log: string[] = [];
    const received: PluginTriggerContext[] = [];
    const [kind] =
      gatedContributions<PluginContributions>(
        {
          triggers: [
            {
              name: 'inbox',
              description: 'Mail arrives.',
              configuration: z.object({}),
              start: async (given) => {
                received.push(given);
                log.push('start');
                return () => {
                  log.push('stop');
                };
              },
            },
          ],
        },
        gate,
        (name) => `kit:${name}`,
        ignoreDiagnostics,
      ).triggers ?? [];
    const controller = new AbortController();
    const context: PluginTriggerContext = {
      configuration: {},
      workflowId: 'watcher',
      storage: new MemoryStorage(),
      fire: async () => ({ outcome: 'started', runId: 'run-1' }),
      signal: controller.signal,
    };
    const reports: string[] = [];
    listenForReports(context, (report) => void reports.push(report.state));
    const stop = await kind!.start!(context);
    expect(log).toEqual([]);
    expect(reports).toEqual(['waiting-for-secret']);

    secrets.save(KEY, SECRET);
    await waitForCondition(
      () => log.length === 1,
      'the trigger did not start once the secret was saved',
    );
    secrets.remove(KEY);
    await waitForCondition(
      () => log.length === 2,
      'the trigger was not stopped once the secret was removed',
    );
    secrets.save(KEY, SECRET);
    await waitForCondition(() => log.length === 3, 'the trigger did not start again');
    await stop();
    expect(log).toEqual(['start', 'stop', 'start', 'stop']);
    // The gate follows the listener: waiting, then listening, waiting, listening; its own stop is
    // the host's doing, and reports nothing.
    expect(reports).toEqual(['waiting-for-secret', 'listening', 'waiting-for-secret', 'listening']);

    // Each start got its own context, the file and the storage the host gave, a signal that is
    // not the host's, and a `fire` that is the host's until the secret goes.
    const [first, second] = received;
    expect(received).toHaveLength(2);
    expect(first).not.toBe(context);
    expect(first!.workflowId).toBe('watcher');
    expect(first!.storage).toBe(context.storage);
    expect(first!.configuration).toBe(context.configuration);
    expect(first!.signal).not.toBe(context.signal);
    // Removing the secret aborted the first listener's signal, and fenced its fire. The second
    // was stopped by the host's own stop, which aborts nothing of the host's.
    expect(first!.signal.aborted).toBe(true);
    expect(await first!.fire({})).toEqual({ outcome: 'skipped', reason: 'stopped' });
    expect(controller.signal.aborted).toBe(false);
    expect(second!.signal.aborted).toBe(true);
    expect(await second!.fire({})).toEqual({ outcome: 'skipped', reason: 'stopped' });
  });

  it('M3: gates the receive of a receive-only kind, leaves its start undefined, and calls nothing while a secret is missing', async () => {
    const { gate, secrets } = await gateOver();
    const calls: string[] = [];
    const [kind] =
      gatedContributions<PluginContributions>(
        {
          triggers: [
            {
              name: 'inbox',
              description: 'Mail arrives.',
              configuration: z.object({}),
              receive: async (request, given) => {
                calls.push(`${request.method}:${given.workflowId}`);
                return new Response('seen', { status: 202 });
              },
            },
          ],
        },
        gate,
        (name) => `kit:${name}`,
        ignoreDiagnostics,
      ).triggers ?? [];
    expect(kind!.start).toBeUndefined();
    expect(Object.hasOwn(kind!, 'start')).toBe(false);
    const context: PluginTriggerContext = {
      configuration: {},
      workflowId: 'watcher',
      storage: new MemoryStorage(),
      fire: async () => ({ outcome: 'started', runId: 'run-1' }),
      signal: new AbortController().signal,
    };
    const request = new Request('https://hooks.example.test/triggers/watcher', { method: 'POST' });
    const refused = await rejectionOf(kind!.receive!(request, context));
    expect(refused).toBeInstanceOf(PluginNeedsSetupError);
    expect(refused).toMatchObject({ plugin: 'kit', contribution: 'kit:inbox', keys: [KEY] });
    expect(calls).toEqual([]);

    secrets.save(KEY, SECRET);
    await waitForCondition(() => gate.available(), 'the gate did not open');
    const answer = await kind!.receive!(request, context);
    expect(answer.status).toBe(202);
    expect(calls).toEqual(['POST:watcher']);

    secrets.remove(KEY);
    await waitForCondition(() => !gate.available(), 'the gate did not close');
    expect(await rejectionOf(kind!.receive!(request, context))).toBeInstanceOf(
      PluginNeedsSetupError,
    );
    expect(calls).toEqual(['POST:watcher']);
  });

  it('M4: gates both the start and the receive of a kind that has both', async () => {
    const { gate, secrets } = await gateOver();
    const log: string[] = [];
    const [kind] =
      gatedContributions<PluginContributions>(
        {
          triggers: [
            {
              name: 'inbox',
              description: 'Mail arrives.',
              configuration: z.object({}),
              start: async () => {
                log.push('start');
                return () => undefined;
              },
              receive: async () => {
                log.push('receive');
                return new Response(null, { status: 204 });
              },
            },
          ],
        },
        gate,
        (name) => `kit:${name}`,
        ignoreDiagnostics,
      ).triggers ?? [];
    const context: PluginTriggerContext = {
      configuration: {},
      workflowId: 'watcher',
      storage: new MemoryStorage(),
      fire: async () => ({ outcome: 'started', runId: 'run-1' }),
      signal: new AbortController().signal,
    };
    const reports: string[] = [];
    listenForReports(context, (report) => void reports.push(report.state));
    const request = new Request('https://hooks.example.test/triggers/watcher', { method: 'POST' });
    const stop = await kind!.start!(context);
    expect(reports).toEqual(['waiting-for-secret']);
    expect(await rejectionOf(kind!.receive!(request, context))).toBeInstanceOf(
      PluginNeedsSetupError,
    );
    expect(log).toEqual([]);
    secrets.save(KEY, SECRET);
    await waitForCondition(() => log.length === 1, 'the trigger did not start');
    const answered = await kind!.receive!(request, context);
    expect(answered.status).toBe(204);
    expect(log).toEqual(['start', 'receive']);
    await stop();
  });

  it('delegates a fire to the host while the listener runs, and aborts the listener with the host’s signal', async () => {
    const { gate, secrets } = await gateOver({ [KEY]: SECRET });
    const received: PluginTriggerContext[] = [];
    const [kind] =
      gatedContributions<PluginContributions>(
        {
          triggers: [
            {
              name: 'inbox',
              description: 'Mail arrives.',
              configuration: z.object({}),
              start: async (given) => {
                received.push(given);
                return () => undefined;
              },
            },
          ],
        },
        gate,
        (name) => `kit:${name}`,
        ignoreDiagnostics,
      ).triggers ?? [];
    const controller = new AbortController();
    const fired: unknown[] = [];
    const context: PluginTriggerContext = {
      configuration: {},
      workflowId: 'watcher',
      storage: new MemoryStorage(),
      fire: async (payload) => {
        fired.push(payload);
        return { outcome: 'started', runId: 'run-1' };
      },
      signal: controller.signal,
    };
    await kind!.start!(context);
    expect(await received[0]!.fire({ n: 1 })).toEqual({ outcome: 'started', runId: 'run-1' });
    expect(fired).toEqual([{ n: 1 }]);

    // The host stopped the listener: its signal follows, and the fire is the host's answer.
    controller.abort();
    expect(received[0]!.signal.aborted).toBe(true);
    secrets.remove(KEY);
    await waitForCondition(() => gate.missing().length === 1, 'the secret was not removed');
    expect(await received[0]!.fire({ n: 2 })).toEqual({ outcome: 'started', runId: 'run-1' });
    expect(fired).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('reports a start that throws after the secret is saved again, and throws the first one to the host', async () => {
    const { gate, secrets } = await gateOver();
    let failing = true;
    const [kind] =
      gatedContributions<PluginContributions>(
        {
          triggers: [
            {
              name: 'inbox',
              description: 'Mail arrives.',
              configuration: z.object({}),
              start: async () => {
                if (failing) throw new Error('the mailbox refused the connection');
                return () => undefined;
              },
            },
          ],
        },
        gate,
        (name) => `kit:${name}`,
        ignoreDiagnostics,
      ).triggers ?? [];
    const context: PluginTriggerContext = {
      configuration: {},
      workflowId: 'watcher',
      storage: new MemoryStorage(),
      fire: async () => ({ outcome: 'skipped', reason: 'stopped' }),
      signal: new AbortController().signal,
    };
    const reports: Array<{ state: string; error?: unknown }> = [];
    listenForReports(context, (report) => void reports.push(report));
    await kind!.start!(context);
    expect(reports).toEqual([{ state: 'waiting-for-secret' }]);

    // The secret is saved, and the plugin's own start throws: reported, not swallowed.
    secrets.save(KEY, SECRET);
    await waitForCondition(() => reports.length === 2, 'the failed start was not reported');
    expect(reports[1]).toMatchObject({ state: 'failed' });
    expect((reports[1]!.error as Error).message).toBe('the mailbox refused the connection');

    // The first transition's failure is the host's to see, as a `start` that throws, unreported.
    const secondContext = { ...context, signal: new AbortController().signal };
    const secondReports: string[] = [];
    listenForReports(secondContext, (report) => void secondReports.push(report.state));
    expect(await rejectionOf(kind!.start!(secondContext))).toMatchObject({
      message: 'the mailbox refused the connection',
    });
    expect(secondReports).toEqual([]);
    failing = false;
  });

  it('applies only the latest read of a key, so a save then an immediate removal ends missing', async () => {
    const OTHER = 'kit-signing-key';
    const values = new Map<string, string>();
    const pending: { resolve: () => void }[] = [];
    let held = false;
    const watchers = new Map<string, () => void>();
    const reader: BureauPluginSecrets = {
      get: (key) => {
        const value = values.get(key);
        if (!held) return Promise.resolve(value);
        return new Promise((resolve) => pending.push({ resolve: () => resolve(value) }));
      },
      watch: (key, listener) => {
        watchers.set(key, listener);
        return () => watchers.delete(key);
      },
    };
    const gate = await createPluginSecretGate('kit', [KEY, OTHER], reader);
    held = true;
    stops.push(gate.watch());
    // The reads `watch` makes at once, both answered as missing.
    await waitForCondition(() => pending.length === 2, 'the gate did not read each key on watch');
    for (const read of pending.splice(0)) read.resolve();

    values.set(KEY, SECRET);
    watchers.get(KEY)?.();
    values.delete(KEY);
    watchers.get(KEY)?.();
    await waitForCondition(() => pending.length === 2, 'the gate did not read the key twice');
    const [save, removal] = pending.splice(0);
    // The removal's read answers first, then the save's slower one: the save must not win.
    removal?.resolve();
    save?.resolve();
    // A later change to the other key settles after both reads of the first have.
    values.set(OTHER, SECRET);
    watchers.get(OTHER)?.();
    await waitForCondition(() => pending.length === 1, 'the gate did not read the other key');
    pending.shift()?.resolve();
    await waitForCondition(
      () => !gate.missing().includes(OTHER),
      'the gate did not apply the other key',
    );
    expect(gate.missing()).toEqual([KEY]);
  });
});

/**
 * COR-2104, COR-2300 — a needs-setup plugin's tool-call validator follows the guardrail rule: its
 * `validate` refuses, and the tool-call guardrail fails closed on the refusal, so the call is
 * refused. Once the secret is saved it judges calls again.
 */
describe('a needs-setup plugin’s tool-call validator', () => {
  it('fails closed while its plugin needs setup, and judges calls once the secret is saved', async () => {
    const { gate, secrets } = await gateOver();
    const gatedResult = gatedContributions<PluginContributions>(
      {
        guardrails: {
          tools: [
            {
              name: 'cap',
              description: 'A test guardrail.',
              action: 'block',
              validate: async () => ({ valid: true, category: 'limit', confidence: 0 }),
            },
          ],
        },
      },
      gate,
      (name) => `kit:${name}`,
      ignoreDiagnostics,
    );
    const hook = createToolCallGuardrail({
      validators: (gatedResult.guardrails?.tools ?? []) as readonly ToolCallValidator[],
    });
    const call = { id: 'call-1', name: 'refund', arguments: { amount: 150 } };
    const judge = () =>
      hook({ conversation: new Conversation(), step: 0, toolCalls: [call], refuse: () => {} });

    expect(await judge()).toEqual([]);

    secrets.save(KEY, SECRET);
    await settleTo(gate, true);
    expect(await judge()).toEqual([call]);
  });
});

/**
 * COR-2300 — a needs-setup plugin's input and output guardrails fail closed too: the gate's refusal
 * is a `detector-failure` finding that blocks, where Armorer's pipeline used to swallow it.
 */
describe('a needs-setup plugin’s input and output guardrails', () => {
  it('block the input and the reply while its plugin needs setup, and judge them once the secret is saved', async () => {
    const { gate, secrets } = await gateOver();
    const gatedResult = gatedContributions<PluginContributions>(
      {
        guardrails: {
          input: [
            {
              name: 'scan-in',
              description: 'A test guardrail.',
              detect: async () => ({ triggered: false, confidence: 0, category: 'none' }),
            },
          ],
          output: [
            {
              name: 'scan-out',
              description: 'A test guardrail.',
              validate: async () => ({ valid: true, category: 'none', confidence: 0 }),
            },
          ],
        },
      },
      gate,
      (name) => `kit:${name}`,
      ignoreDiagnostics,
    );
    const conversation = new Conversation();
    conversation.appendUserMessage('hello');
    const context = { conversation, step: 0 } as never;
    const inputHook = createInputGuardrail({
      detectors: [guardrailOf(gatedResult.guardrails!.input![0]!) as InputDetector],
      action: 'warn',
    });
    const outputHook = createOutputGuardrail({
      validators: [guardrailOf(gatedResult.guardrails!.output![0]!) as OutputValidator],
      action: 'warn',
    });
    const response = { content: 'hi', toolCalls: [] };

    const inputRefusal = await inputHook(context);
    const outputRefusal = await outputHook(response, context);
    expect(inputRefusal?.content).toContain('blocked by input guardrail');
    expect(outputRefusal?.content).toContain('blocked by output guardrail');

    secrets.save(KEY, SECRET);
    await settleTo(gate, true);
    expect(await inputHook(context)).toBeUndefined();
    expect(await outputHook(response, context)).toBeUndefined();
  });
});

/**
 * COR-2118 — a needs-setup plugin's guardrail factory follows the guardrail rule: `create` runs, so
 * an agent that configures the guardrail stays valid and builds, and the guardrail it builds refuses
 * until the secret is saved, as a detector or validator does.
 */
describe('a needs-setup plugin’s guardrail factory', () => {
  it('builds while its plugin needs setup, and what it builds refuses until the secret is saved', async () => {
    const { gate, secrets } = await gateOver();
    const built: number[] = [];
    const gatedResult = gatedContributions<PluginContributions>(
      {
        guardrails: {
          output: [
            {
              guardrail: {
                name: 'grounding',
                description: 'A test guardrail.',
                configuration: z.object({ threshold: z.number().default(0.8) }),
                create: (configuration: { threshold: number }) => {
                  built.push(configuration.threshold);
                  return {
                    name: 'grounding',
                    validate: async () => ({ valid: true, category: 'x', confidence: 0 }),
                  };
                },
              },
              action: 'warn',
            },
          ],
        },
      },
      gate,
      (name) => `kit:${name}`,
      ignoreDiagnostics,
    );
    const entry = gatedResult.guardrails!.output![0]!;
    expect(entry).toMatchObject({ action: 'warn' });
    const factory = guardrailOf(entry) as PluginGuardrailFactory<OutputValidator>;
    const validator = factory.create({ threshold: 0.5 });
    expect(built).toEqual([0.5]);

    expect(await rejectionOf(validator.validate('x', {} as never))).toBeInstanceOf(
      PluginNeedsSetupError,
    );
    secrets.save(KEY, SECRET);
    await settleTo(gate, true);
    expect(await validator.validate('x', {} as never)).toEqual({
      valid: true,
      category: 'x',
      confidence: 0,
    });
  });
});

/** COR-2185 — a gated embedder passes the caller's options, and so its signal, to the embedder it wraps. */
describe('a gated embedder', () => {
  it('forwards every argument it is called with once its plugin is available', async () => {
    const { gate, secrets } = await gateOver();
    const calls: { texts: string[]; signal: AbortSignal | undefined }[] = [];
    const gatedResult = gatedContributions<PluginContributions>(
      {
        embedders: [
          {
            name: 'small',
            model: 'small-model',
            dimensions: 1,
            embed: async (texts, options) => {
              calls.push({ texts, signal: options?.signal });
              return texts.map(() => [1]);
            },
          },
        ],
      },
      gate,
      (name) => `kit:${name}`,
      ignoreDiagnostics,
    );
    const embed = gatedResult.embedders![0]!.embed;
    const controller = new AbortController();

    expect(await rejectionOf(embed(['x'], { signal: controller.signal }))).toBeInstanceOf(
      PluginNeedsSetupError,
    );
    secrets.save(KEY, SECRET);
    await settleTo(gate, true);
    await embed(['x', 'y'], { signal: controller.signal });
    await embed(['z']);

    expect(calls).toEqual([
      { texts: ['x', 'y'], signal: controller.signal },
      { texts: ['z'], signal: undefined },
    ]);
  });
});

/**
 * COR-2191 — a needs-setup plugin's memory guardrail is skipped without a word, so the first skipped
 * call of each guardrail sends one `warn` to scope `memory`, and a recovery re-arms it. No
 * diagnostic carries the content that was scanned.
 */
describe('a needs-setup plugin’s memory guardrail diagnostics', () => {
  const CONTENT = 'The customer card number is 4111-1111-1111-1111.';

  async function gatedMemory() {
    const { gate, secrets } = await gateOver();
    const diagnostics: BureauDiagnostic[] = [];
    const scanned: string[] = [];
    const named = (name: string) => ({
      name,
      description: 'A test guardrail.',
      detect: async (input: string) => {
        scanned.push(input);
        return { triggered: false, confidence: 0, category: 'none' };
      },
    });
    const gatedResult = gatedContributions<PluginContributions>(
      { guardrails: { memory: [named('first'), named('second')] } },
      gate,
      (name) => `kit:${name}`,
      (diagnostic) => diagnostics.push(diagnostic),
    );
    const [first, second] = gatedResult.guardrails?.memory ?? [];
    if (first === undefined || second === undefined) throw new Error('Two guardrails expected.');
    return { gate, secrets, diagnostics, scanned, first, second };
  }

  it('warns once per guardrail at its first skipped call, and says nothing afterwards', async () => {
    const { diagnostics, first, second, scanned } = await gatedMemory();

    for (let call = 0; call < 3; call += 1) await first.detect(CONTENT, {} as never);
    expect(diagnostics).toEqual([
      {
        level: 'warn',
        scope: 'memory',
        message: expect.stringContaining('"kit:first" is not available: plugin "kit" needs setup'),
      },
    ]);
    expect(diagnostics[0]?.message).toContain('The memory guardrail was skipped.');

    // Each guardrail has its own first call.
    await second.detect(CONTENT, {} as never);
    await second.detect(CONTENT, {} as never);
    expect(diagnostics.map(({ message }) => message.includes('"kit:second"'))).toEqual([
      false,
      true,
    ]);
    expect(scanned).toEqual([]);
  });

  it('warns again after the plugin was available and needs setup again, even with no call in between', async () => {
    const { gate, secrets, diagnostics, first, scanned } = await gatedMemory();
    await first.detect(CONTENT, {} as never);
    expect(diagnostics).toHaveLength(1);

    secrets.save(KEY, SECRET);
    await settleTo(gate, true);
    secrets.remove(KEY);
    await settleTo(gate, false);

    await first.detect(CONTENT, {} as never);
    await first.detect(CONTENT, {} as never);
    expect(diagnostics).toHaveLength(2);

    // While available the guardrail runs and sends nothing.
    secrets.save(KEY, SECRET);
    await settleTo(gate, true);
    await first.detect(CONTENT, {} as never);
    expect(diagnostics).toHaveLength(2);
    expect(scanned).toEqual([CONTENT]);
  });

  it('reaches the host’s diagnostic sink through composePlugins, from each memory gate', async () => {
    const secrets = secretsStore();
    const diagnostics: BureauDiagnostic[] = [];
    const handed: { admission: readonly InputDetector[]; recall: readonly InputDetector[] }[] = [];
    const composed = await composePlugins({
      plugins: [
        {
          descriptor: definePlugin({
            name: 'kit',
            version: '1.0.0',
            description: 'Needs an API key.',
            secrets: [KEY],
            setup: () => ({
              guardrails: {
                memory: [
                  {
                    name: 'scan',
                    description: 'A test guardrail.',
                    detect: async () => ({ triggered: false, confidence: 0, category: 'none' }),
                  },
                ],
              },
            }),
          }),
          source: 'package',
          location: '@example/kit',
        },
      ],
      pluginSecrets: secrets,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      memory: (contributions) => {
        handed.push(contributions.guardrails);
        return undefined as never;
      },
    });
    stops.push(composed.watchSecrets());

    // One wrapper serves both gates, and the guardrail's warning is sent once for the pair.
    await handed[0]?.admission[0]?.detect(CONTENT, {} as never);
    await handed[0]?.recall[0]?.detect(CONTENT, {} as never);
    expect(diagnostics).toEqual([
      {
        level: 'warn',
        scope: 'memory',
        message: expect.stringContaining('"kit:scan" is not available'),
      },
    ]);
  });

  it('reaches the host’s sink exactly once, and the event feed as a diagnostic event, through createBureau', async () => {
    const secrets = secretsStore();
    const diagnostics: BureauDiagnostic[] = [];
    const events: Event[] = [];
    const handed: { admission: readonly InputDetector[]; recall: readonly InputDetector[] }[] = [];
    const kit = definePlugin({
      name: 'kit',
      version: '1.0.0',
      description: 'Needs an API key.',
      secrets: [KEY],
      setup: () => ({
        guardrails: {
          memory: [
            {
              name: 'scan',
              description: 'A test guardrail.',
              detect: async () => ({ triggered: false, confidence: 0, category: 'none' }),
            },
          ],
        },
      }),
    });
    const bureau = await createBureau<AgentDefinitions>({
      plugins: [{ descriptor: kit, source: 'package', location: '@example/kit' }],
      pluginSecrets: secrets,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      onEvent: (emitted) => {
        events.push(emitted);
      },
      memory: (contributions) => {
        handed.push(contributions.guardrails);
        return undefined as never;
      },
    });
    bureaus.push(bureau);

    await handed[0]?.admission[0]?.detect(CONTENT, {} as never);
    await handed[0]?.recall[0]?.detect(CONTENT, {} as never);

    const reported = diagnostics.filter(({ scope }) => scope === 'memory');
    expect(reported).toEqual([
      {
        level: 'warn',
        scope: 'memory',
        message: expect.stringContaining('"kit:scan" is not available'),
      },
    ]);
    const onFeed = events.filter(
      (emitted): emitted is DiagnosticEvent =>
        emitted instanceof DiagnosticEvent && emitted.scope === 'memory',
    );
    expect(onFeed.map(({ level, scope }) => ({ level, scope }))).toEqual([
      { level: 'warn', scope: 'memory' },
    ]);
    expect(JSON.stringify(onFeed)).not.toContain('4111');
  });

  it('never carries the scanned content', async () => {
    const { diagnostics, first, second } = await gatedMemory();
    await first.detect(CONTENT, {} as never);
    await second.detect(CONTENT, {} as never);

    expect(diagnostics).toHaveLength(2);
    for (const diagnostic of diagnostics) {
      expect(JSON.stringify(diagnostic)).not.toContain('4111');
      expect(diagnostic.cause).toBeUndefined();
    }
  });
});
