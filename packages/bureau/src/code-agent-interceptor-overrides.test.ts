/**
 * COR-2253 — a code agent's override set names `interceptors: [plugin:name]`, the key an agent file
 * names them under (COR-2126): the next run of a built-in agent or a running plugin's agent applies
 * them in its own hook tier, as it does for a file agent (COR-2127). A set that also applies to
 * every agent registers once; one whose plugin needs setup refuses the run that chose it and no
 * other; a save that names an id no plugin contributes, or one twice, writes nothing; and a record
 * stored without the key, under a version 1 or version 2 key, still reads.
 */
import { definePlugin, type PluginInterceptor } from '@lostgradient/interborough-plugin';
import { createAgent } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import { AgentFileError } from './agent-file';
import {
  type AgentOverrides,
  agentOverrideVersionKey,
  createAgentOverrideStore,
  hashAgentOverrides,
  legacyAgentOverrideVersionKey,
} from './agent-override-store';
import { agentOverridesOutputSchema, overridesView } from './http/management/agent-overrides-wire';
import type { BureauPluginSecrets } from './plugins/plugin-types';
import { runTask } from './test';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import { demoPlugin, seen as echoSeen } from './testing/demo-plugin-agents.test-support';

const REPLY = 'replier-done';

/** An interceptor, applied to the agents that choose it, recording the content of each step. */
function stepRecorder(name: string, steps: string[], every = false): PluginInterceptor {
  return {
    name,
    ...(every ? { appliesTo: 'every-agent' as const } : {}),
    onStep: {
      handler: async (step) => {
        steps.push(step.content);
      },
      replay: 'safe',
    },
  };
}

/**
 * A plugin whose every-agent `onStep` records into `witnessed`, behind every other at a lower
 * priority: a step it has seen is one the others have had their turn at, the positive signal a
 * "did not run" assertion waits on first.
 */
function witnessPlugin(witnessed: string[]) {
  return {
    descriptor: definePlugin({
      name: 'witness',
      version: '1.0.0',
      description: 'Records that a step settled.',
      setup: () => ({
        interceptors: [
          {
            name: 'step-witness',
            appliesTo: 'every-agent' as const,
            onStep: {
              handler: async (step) => {
                witnessed.push(step.content);
              },
              replay: 'safe' as const,
              priority: -1,
            },
          },
        ],
      }),
    }),
    source: 'package' as const,
    location: '@example/witness',
  };
}

/** A plugin `audit` with no agents, whose interceptors are `interceptors`, behind a secret if asked. */
function auditPlugin(interceptors: readonly PluginInterceptor[], secret?: string) {
  return {
    descriptor: definePlugin({
      name: 'audit',
      version: '1.0.0',
      description: 'Audits steps.',
      ...(secret === undefined ? {} : { secrets: [secret] }),
      setup: () => ({ interceptors }),
    }),
    source: 'package' as const,
    location: '@example/audit',
  };
}

const harnesses: FileBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
  echoSeen.length = 0;
});

async function start(
  plugins: readonly ReturnType<typeof auditPlugin>[],
  options: { readonly pluginSecrets?: BureauPluginSecrets; readonly storage?: MemoryStorage } = {},
): Promise<FileBureauHarness> {
  const harness = await startFileBureau({
    agents: {
      replier: createAgent({
        name: 'replier',
        generate: async () => ({ content: REPLY, toolCalls: [] }),
      }),
      bystander: createAgent({
        name: 'bystander',
        generate: async () => ({ content: 'bystander-done', toolCalls: [] }),
      }),
    },
    overrides: {
      plugins: [...plugins],
      ...(options.pluginSecrets === undefined ? {} : { pluginSecrets: options.pluginSecrets }),
      ...(options.storage === undefined ? {} : { storage: options.storage }),
    },
  });
  harnesses.push(harness);
  return harness;
}

async function save(harness: FileBureauHarness, id: string, overrides: AgentOverrides) {
  const { hash } = (await harness.bureau.agents.overrides.get(id))!;
  return harness.bureau.agents.overrides.save(id, overrides, { expectedHash: hash });
}

async function refusalOf(harness: FileBureauHarness, id: string, overrides: AgentOverrides) {
  const error = await save(harness, id, overrides).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(AgentFileError);
  return error as AgentFileError;
}

describe('a code agent’s interceptors override (COR-2253)', () => {
  it('applies the set to the next run of a built-in agent, and stops when a save drops it', async () => {
    const steps: string[] = [];
    const witnessed: string[] = [];
    const harness = await start([
      auditPlugin([stepRecorder('step-audit', steps)]),
      witnessPlugin(witnessed),
    ]);

    await runTask(harness.bureau, 'replier', 'Hi');
    await waitUntil(() => witnessed.length === 1, { message: 'the first step to settle' });
    expect(steps).toEqual([]);

    await save(harness, 'replier', { interceptors: ['audit:step-audit'] });
    await runTask(harness.bureau, 'replier', 'Hi');
    await runTask(harness.bureau, 'replier', 'Hi again');
    await waitUntil(() => witnessed.length === 3, { message: 'the next two steps to settle' });
    // Once per step of each run: the hooks are built for the run, not added to a shared registry.
    expect(steps).toEqual([REPLY, REPLY]);

    await save(harness, 'replier', {});
    await runTask(harness.bureau, 'replier', 'Hi once more');
    await waitUntil(() => witnessed.length === 4, {
      message: 'the step after the set was dropped',
    });
    expect(steps).toEqual([REPLY, REPLY]);
  });

  it('applies the set to the agents that chose it and no other', async () => {
    const steps: string[] = [];
    const witnessed: string[] = [];
    const harness = await start([
      auditPlugin([stepRecorder('step-audit', steps)]),
      witnessPlugin(witnessed),
    ]);
    await save(harness, 'replier', { interceptors: ['audit:step-audit'] });

    await runTask(harness.bureau, 'bystander', 'Hi');
    await waitUntil(() => witnessed.includes('bystander-done'), { message: 'bystander’s step' });

    expect(steps).toEqual([]);
  });

  it('applies the set to the next run of a running plugin’s agent', async () => {
    const steps: string[] = [];
    const harness = await start([
      demoPlugin({ interceptors: [stepRecorder('watch', steps)] }),
    ] as never);

    await save(harness, 'demo:echo', { interceptors: ['demo:watch'] });
    await runTask(harness.bureau, 'demo:echo', 'Hello.');

    await waitUntil(() => steps.length > 0, { message: 'the plugin agent’s onStep' });
    expect(steps).toEqual(['echo answered']);
  });

  it('registers an every-agent set the override also lists once', async () => {
    const steps: string[] = [];
    const witnessed: string[] = [];
    const harness = await start([
      auditPlugin([stepRecorder('step-audit', steps, true)]),
      witnessPlugin(witnessed),
    ]);
    await save(harness, 'replier', { interceptors: ['audit:step-audit'] });

    await runTask(harness.bureau, 'replier', 'Hi');

    await waitUntil(() => witnessed.length === 1, { message: 'the step to settle' });
    expect(steps).toEqual([REPLY]);
  });

  it('refuses the run that chose a set whose plugin needs setup, and not another agent’s', async () => {
    const steps: string[] = [];
    const witnessed: string[] = [];
    const secrets: BureauPluginSecrets = {
      get: async () => undefined,
      watch: () => () => {},
    };
    const harness = await start(
      [auditPlugin([stepRecorder('step-audit', steps)], 'audit-api-key'), witnessPlugin(witnessed)],
      { pluginSecrets: secrets },
    );
    await save(harness, 'replier', { interceptors: ['audit:step-audit'] });

    const chosen = await runTask(harness.bureau, 'replier', 'Hi');
    const other = await runTask(harness.bureau, 'bystander', 'Hi');

    expect(chosen.finishReason).toBe('error');
    expect(other.finishReason).not.toBe('error');
    await waitUntil(() => witnessed.includes('bystander-done'), { message: 'bystander’s step' });
    expect(steps).toEqual([]);
  });

  it('refuses an id no plugin contributes, naming it, and writes nothing', async () => {
    const harness = await start([auditPlugin([stepRecorder('step-audit', [])])]);
    const before = await harness.bureau.agents.overrides.get('replier');

    const error = await refusalOf(harness, 'replier', {
      interceptors: ['audit:step-audit', 'audit:missing'],
    });

    expect(error.code).toBe('reference-unresolved');
    expect(error.problem?.issues).toEqual([
      {
        path: 'interceptors.1',
        message: '"audit:missing" is not a contributed interceptor',
        reference: 'audit:missing',
      },
    ]);
    expect(await harness.bureau.agents.overrides.get('replier')).toEqual(before);
  });

  it('refuses an interceptor listed twice, naming the id', async () => {
    const harness = await start([auditPlugin([stepRecorder('step-audit', [])])]);

    const error = await refusalOf(harness, 'replier', {
      interceptors: ['audit:step-audit', 'audit:step-audit'],
    });

    expect(error.code).toBe('invalid-frontmatter');
    expect(error.problem?.issues).toEqual([
      {
        path: 'interceptors.1',
        message: '"audit:step-audit" is listed more than once; list each interceptor once',
      },
    ]);
  });

  it('restores a version that named a set as a new version, and applies it', async () => {
    const steps: string[] = [];
    const witnessed: string[] = [];
    const harness = await start([
      auditPlugin([stepRecorder('step-audit', steps)]),
      witnessPlugin(witnessed),
    ]);
    await save(harness, 'replier', { interceptors: ['audit:step-audit'] });
    await save(harness, 'replier', {});
    const { hash } = (await harness.bureau.agents.overrides.get('replier'))!;

    const restored = await harness.bureau.agents.overrides.restore('replier', 1, {
      expectedHash: hash,
    });
    await runTask(harness.bureau, 'replier', 'Hi');

    expect(restored.version).toBe(3);
    await waitUntil(() => witnessed.length === 1, { message: 'the step to settle' });
    expect(steps).toEqual([REPLY]);
  });
});

describe('a stored override record without interceptors (COR-2253)', () => {
  const record = (overrides: Record<string, unknown>) => ({
    version: 1,
    hash: hashAgentOverrides(overrides),
    savedAt: '2026-10-01T00:00:00.000Z',
    savedBy: 'anonymous:local',
    owner: 'anonymous:local',
    overrides,
    changedKeys: Object.keys(overrides),
  });

  it.each([
    ['version 1', legacyAgentOverrideVersionKey],
    ['version 2', agentOverrideVersionKey],
  ] as const)('still reads a %s record, with its hash, and applies it', async (_, keyOf) => {
    const storage = new MemoryStorage();
    const overrides = { instructions: 'Reply briefly.', guardrails: ['x:limit'] };
    await textValueStore(storage).set(keyOf('replier', 1), JSON.stringify(record(overrides)));

    const store = createAgentOverrideStore({
      store: textValueStore(storage),
      nowISO: () => '2026-11-09T00:00:00.000Z',
    });
    const current = await store.current('replier');

    expect(current).toEqual({
      version: 1,
      hash: hashAgentOverrides(overrides),
      overrides,
    });
    expect(Object.hasOwn(current.overrides, 'interceptors')).toBe(false);
    // On the wire every key is present, so a record from before the key shows it as not overridden.
    const view = overridesView(current.overrides);
    expect(view).toMatchObject({ instructions: 'Reply briefly.', interceptors: null });
    expect(agentOverridesOutputSchema.parse(view)).toEqual(view);
  });

  it('keeps the hash of an override set that names no interceptors', () => {
    // The key is left out of a set's encoding when it is not set, so no stored hash moved.
    expect(hashAgentOverrides({ instructions: 'Reply briefly.' })).toBe(
      hashAgentOverrides({ instructions: 'Reply briefly.', interceptors: undefined }),
    );
    expect(hashAgentOverrides({})).not.toBe(hashAgentOverrides({ interceptors: ['a:b'] }));
  });

  it('reads back a record that does name them, in the overrides and its changed keys', async () => {
    const store = createAgentOverrideStore({
      store: textValueStore(new MemoryStorage()),
      nowISO: () => '2026-11-09T00:00:00.000Z',
    });
    await store.save(
      'replier',
      { interceptors: ['audit:step-audit'] },
      {
        expectedHash: hashAgentOverrides({}),
        savedBy: 'anonymous:local',
        owner: 'anonymous:local',
      },
    );

    const [saved] = await store.list('replier');

    expect(saved?.overrides).toEqual({ interceptors: ['audit:step-audit'] });
    expect(saved?.changedKeys).toEqual(['interceptors']);
  });
});
