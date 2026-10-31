/**
 * COR-1879 — a plugin missing a declared secret loads `needs-setup`, its contributions refuse until
 * the host's `watch` reports the secret saved, and refuse again once it is removed, with no restart.
 */
import {
  definePlugin,
  type PluginContributions,
  type PluginTriggerContext,
} from '@lostgradient/interborough-plugin';
import { createAgent } from '@lostgradient/operative';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from '../agent-catalog';
import { createBureau } from '../create-bureau';
import { waitForCondition } from '../test';
import type { Bureau } from '../types';
import { composePlugins } from './compose-plugins';
import {
  createPluginSecretGate,
  gatedContributions,
  PluginNeedsSetupError,
  type PluginSecretGate,
} from './plugin-secret-gate';
import type { BureauPluginSecrets } from './plugin-types';

const SECRET = 'sk-live-gate-0123456789';
const KEY = 'kit-api-key';

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

const event = { kind: 'kit.happened', bureauId: 'b', emittedAtMs: 0, payload: {} };

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
        eventFormatters: [
          { name: 'fmt', eventKinds: ['kit.happened'], format: () => ({ title: 'Formatted' }) },
        ],
      }),
    });
    const bureau = await createBureau<AgentDefinitions>({
      plugins: [{ descriptor: kit, source: 'package', location: '@example/kit' }],
      pluginSecrets: secrets,
    });
    bureaus.push(bureau);

    const missing = bureau.plugins.list()[0];
    expect(missing?.status).toBe('needs-setup');
    expect(missing?.problems).toEqual([
      { code: 'secret-missing', key: KEY, contributions: ['kit:lookup@1.0.0', 'kit:fmt'] },
    ]);
    expect(missing?.contributions.map(({ id }) => id)).toEqual(['kit:lookup@1.0.0', 'kit:fmt']);
    // Registered at construction, refusing until the secret is saved: the default title.
    expect(bureau.formatEvent(event).title).toBe('kit.happened');

    secrets.save(KEY, SECRET);
    await waitForCondition(
      () => bureau.plugins.list()[0]?.status === 'running',
      'the plugin did not run after its secret was saved',
    );
    expect(bureau.plugins.list()[0]?.problems).toEqual([]);
    expect(bureau.formatEvent(event).title).toBe('Formatted');
    expect(JSON.stringify(bureau.plugins.list())).not.toContain(SECRET);

    secrets.remove(KEY);
    await waitForCondition(
      () => bureau.plugins.list()[0]?.status === 'needs-setup',
      'the plugin kept running after its secret was removed',
    );
    expect(bureau.formatEvent(event).title).toBe('kit.happened');

    await bureau.dispose();
    bureaus.length = 0;
    expect(secrets.watching(KEY)).toBe(0);
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
                { name: 'small', dimensions: 2, embed: async (texts) => texts.map(() => [1, 0]) },
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

/** A gate over one key, with the store that drives it. */
async function gateOver(): Promise<{
  gate: PluginSecretGate;
  secrets: ReturnType<typeof secretsStore>;
}> {
  const secrets = secretsStore();
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
            execute: note('activity', 'fetched'),
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
          inputDetectors: [{ name: 'scan', detect: note('guardrail-input', {}) as never }],
          outputValidators: [{ name: 'check', validate: note('guardrail-output', {}) as never }],
        },
        runHooks: [{ name: 'audit', onStep: note('run-hooks', undefined) }],
        decisionRouters: [
          { name: 'router', kinds: new Set(), decide: note('decision-router', {}) as never },
        ],
        hookActionKinds: [
          {
            name: 'page',
            description: 'Pages',
            configuration: z.object({}),
            run: note('hook-action', undefined),
          },
        ],
        embedders: [{ name: 'small', dimensions: 1, embed: note('embedder', [[1]]) }],
        memoryDetectors: [{ name: 'tags', detect: note('memory-detector', {}) as never }],
        evalJudges: [
          {
            name: 'judge',
            version: '1',
            evaluate: note('eval-judge', { pass: true, score: 1, message: '' }),
          },
        ],
        eventFormatters: [
          {
            name: 'fmt',
            eventKinds: ['kit.happened'],
            format: () => {
              called.push('event-formatter');
              return { title: 'Formatted' };
            },
          },
        ],
        codeAgents: [
          {
            name: 'writer',
            agent: createAgent({ generate: async () => ({ content: 'done', toolCalls: [] }) }),
          },
        ],
      },
      gate,
      (name) => `kit:${name}`,
    );
    const calls: Record<string, () => unknown> = {
      activity: () => gatedResult.activities?.[0]?.execute({}, {} as never),
      validator: () =>
        gatedResult.validators?.[0]?.validate({} as never, new AbortController().signal),
      'guardrail-input': () =>
        gatedResult.guardrails?.inputDetectors?.[0]?.detect('x', {} as never),
      'guardrail-output': () =>
        gatedResult.guardrails?.outputValidators?.[0]?.validate('x', {} as never),
      'run-hooks': () => gatedResult.runHooks?.[0]?.onStep?.({} as never),
      'decision-router': () => gatedResult.decisionRouters?.[0]?.decide({} as never),
      'hook-action': () => gatedResult.hookActionKinds?.[0]?.run({} as never),
      embedder: () => gatedResult.embedders?.[0]?.embed(['x']),
      'memory-detector': () => gatedResult.memoryDetectors?.[0]?.detect('x', {} as never),
      'eval-judge': () => gatedResult.evalJudges?.[0]?.evaluate({} as never),
      'event-formatter': () => gatedResult.eventFormatters?.[0]?.format(event),
      'code-agent': () => gatedResult.codeAgents?.[0]?.agent.run('Go.'),
    };
    // Synchronous callables (a formatter, a code agent's `run`) throw; the rest reject.
    const outcomeOf = async (call: () => unknown): Promise<'refused' | 'called'> => {
      try {
        await call();
        return 'called';
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

    expect(await outcomes()).toEqual(all('refused'));
    expect(called).toEqual([]);
    // A refused activity is not retried: the refusal names an error the retry policy skips.
    expect(gatedResult.activities?.[0]?.retry?.nonRetryableErrors).toEqual([
      'PluginNeedsSetupError',
    ]);

    secrets.save(KEY, SECRET);
    await settleTo(gate, true);
    expect(await outcomes()).toEqual(all('called'));

    secrets.remove(KEY);
    await settleTo(gate, false);
    expect(await outcomes()).toEqual(all('refused'));
  });

  it('starts a trigger kind once the secret is saved, stops it on removal, and starts it again on a second save', async () => {
    const { gate, secrets } = await gateOver();
    const log: string[] = [];
    const [kind] =
      gatedContributions<PluginContributions>(
        {
          triggerKinds: [
            {
              name: 'inbox',
              description: 'Mail arrives.',
              configuration: z.object({}),
              start: async () => {
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
      ).triggerKinds ?? [];
    const controller = new AbortController();
    const context: PluginTriggerContext = {
      configuration: {},
      fire: async () => undefined,
      signal: controller.signal,
    };
    const stop = await kind!.start(context);
    expect(log).toEqual([]);

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
