/**
 * COR-2228 — a running plugin's code agent takes overrides as a built-in agent does, at its own
 * `agent:` + percent-encoded identifier key, and every agent the catalog cannot apply an override
 * to refuses and writes no record: an agent file, the agent of a plugin that is not running, and
 * an agent with no definition resolver. The plugin's secret gate still refuses a run of an
 * overridden agent while the plugin is `needs-setup`.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterEach, describe, expect, it } from 'bun:test';

import { hashAgentOverrides } from './agent-override-store';
import { PluginNeedsSetupError } from './plugins/plugin-secret-gate';
import type { BureauPluginSecrets } from './plugins/plugin-types';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { DEMO_SECRET_KEY, demoPlugin, seen } from './testing/demo-plugin-agents.test-support';
import { listedPlugins } from './testing/plugin-listing.test-support';
import { runTask, waitForCondition } from './test';

const NO_OVERRIDES = hashAgentOverrides({});

/** A secrets reader the test saves to and removes from, notifying watchers as a host would. */
function secretsStore(): BureauPluginSecrets & {
  save(key: string, value: string): void;
  remove(key: string): void;
} {
  const values = new Map<string, string>();
  const watchers = new Map<string, Set<() => void>>();
  const notify = (key: string) => {
    for (const listener of watchers.get(key) ?? []) listener();
  };
  return {
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
  };
}

const harnesses: FileBureauHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
  seen.length = 0;
});

async function start(
  options: {
    readonly enabled?: boolean;
    readonly secret?: boolean;
    readonly pluginSecrets?: BureauPluginSecrets;
    readonly storage?: MemoryStorage;
  } = {},
) {
  const storage = options.storage ?? new MemoryStorage();
  const harness = await startFileBureau({
    overrides: {
      storage,
      plugins: [demoPlugin({ secret: options.secret === true })],
      ...(options.enabled === false ? { pluginConfiguration: { demo: { enabled: false } } } : {}),
      ...(options.pluginSecrets === undefined ? {} : { pluginSecrets: options.pluginSecrets }),
    },
  });
  harnesses.push(harness);
  return { harness, storage, kv: textValueStore(storage) };
}

async function overrideKeys(kv: ReturnType<typeof textValueStore>): Promise<string[]> {
  const keys = await kv.list('bureau-agent-override-version:');
  return keys.toSorted();
}

describe('a running plugin’s code agent', () => {
  it('takes overrides: a v2 record at the percent-encoded key, and the next run starts with them', async () => {
    const { harness, kv } = await start();
    const { bureau } = harness;
    expect(bureau.agents.list().find(({ id }) => id === 'demo:echo')?.state).toBe('ready');
    expect(await bureau.agents.overrides.get('demo:echo')).toMatchObject({ version: null });

    const saved = await bureau.agents.overrides.save(
      'demo:echo',
      { instructions: 'You echo in capitals.' },
      { expectedHash: NO_OVERRIDES },
    );

    expect(saved).toMatchObject({ id: 'demo:echo', version: 1 });
    expect(await overrideKeys(kv)).toEqual([
      'bureau-agent-override-version:v2:agent:demo%3Aecho:1',
    ]);
    expect(await bureau.agents.overrides.versions('demo:echo')).toHaveLength(1);
    await runTask(bureau, 'demo:echo', 'Hello.');
    expect(seen.map(({ agent, system }) => [agent, system])).toEqual([
      ['echo', 'You echo in capitals.'],
    ]);
    // The agent’s detail is the agent as its runs get it.
    const detail = await bureau.agents.detail('demo:echo');
    expect(detail?.codeDefinition).toMatchObject({
      instructions: 'You echo in capitals.',
    });
  });

  it('reads its overrides in force again when the Bureau starts over the same store', async () => {
    const storage = new MemoryStorage();
    const first = await start({ storage });
    await first.harness.bureau.agents.overrides.save(
      'demo:echo',
      { instructions: 'You echo in capitals.' },
      { expectedHash: NO_OVERRIDES },
    );
    await first.harness.dispose();
    harnesses.splice(harnesses.indexOf(first.harness), 1);

    const second = await start({ storage });
    await runTask(second.harness.bureau, 'demo:echo', 'Hello.');

    expect(seen.map(({ system }) => system)).toEqual(['You echo in capitals.']);
  });

  it('passes the tool check for its own tool by catalog name, and offers the tool to a run', async () => {
    const { harness } = await start();
    const { bureau } = harness;

    const saved = await bureau.agents.overrides.save(
      'demo:echo',
      { tools: ['demo:lookup'] },
      { expectedHash: NO_OVERRIDES },
    );
    expect(saved.version).toBe(1);
    const refused = bureau.agents.overrides.save(
      'demo:echo',
      { tools: ['lookup'] },
      { expectedHash: saved.hash },
    );
    expect(await rejectionOf(refused)).toMatchObject({ code: 'unknown-tool' });

    await runTask(bureau, 'demo:echo', 'Hello.');
    // The agent's own toolbox is empty, so only the override brings the plugin's tool.
    expect(seen[0]?.tools).toContain('lookup');
  });

  it('refuses an agent with no definition resolver, and writes no record', async () => {
    const { harness, kv } = await start();

    const refused = harness.bureau.agents.overrides.save(
      'demo:scripted',
      { instructions: 'Anything.' },
      { expectedHash: NO_OVERRIDES },
    );

    expect(await rejectionOf(refused)).toMatchObject({ code: 'agent-not-overridable' });
    expect(await overrideKeys(kv)).toEqual([]);
  });
});

describe('the agents that take no override', () => {
  it('refuses the agent of a disabled plugin as unavailable, and writes no record', async () => {
    const { harness, kv } = await start({ enabled: false });
    const { bureau } = harness;
    expect(bureau.agents.list().find(({ id }) => id === 'demo:echo')?.state).toBe('unavailable');

    const refused = bureau.agents.overrides.save(
      'demo:echo',
      { instructions: 'You echo in capitals.' },
      { expectedHash: NO_OVERRIDES },
    );

    expect(await rejectionOf(refused)).toMatchObject({ code: 'agent-unavailable' });
    expect(await bureau.agents.overrides.get('demo:echo')).toBeUndefined();
    expect(await overrideKeys(kv)).toEqual([]);
  });

  it('refuses an agent file as read-only, and writes no record', async () => {
    const { harness, kv } = await start();
    await harness.put(
      'researcher.md',
      agentFileText({ name: 'Researcher', model: KNOWN_MODEL }, 'You are careful.\n'),
    );
    await harness.bureau.agents.refresh();

    const refused = harness.bureau.agents.overrides.save(
      'researcher',
      { instructions: 'Anything.' },
      { expectedHash: NO_OVERRIDES },
    );

    expect(await rejectionOf(refused)).toMatchObject({ code: 'agent-file-read-only' });
    expect(await overrideKeys(kv)).toEqual([]);
  });
});

describe('an overridden plugin agent while its plugin needs setup', () => {
  it('is refused by the secret gate, and runs with its overrides once the secret is saved', async () => {
    const secrets = secretsStore();
    const { harness } = await start({ secret: true, pluginSecrets: secrets });
    const { bureau } = harness;
    const statusOf = async () => {
      const [listing] = await listedPlugins(bureau);
      return listing?.status;
    };
    expect(await statusOf()).toBe('needs-setup');

    // The agent is catalogued while the plugin needs setup, so the override saves.
    await bureau.agents.overrides.save(
      'demo:echo',
      { instructions: 'You echo in capitals.' },
      { expectedHash: NO_OVERRIDES },
    );
    const refusal = await rejectionOf(bureau.tasks.start('demo:echo', 'Hello.'));
    expect(refusal).toBeInstanceOf(PluginNeedsSetupError);
    expect(seen).toEqual([]);

    secrets.save(DEMO_SECRET_KEY, 'sk-live-demo-0123456789');
    await waitForCondition(
      async () => (await statusOf()) === 'running',
      'the plugin did not run after its secret was saved',
    );
    await runTask(bureau, 'demo:echo', 'Hello.');
    expect(seen.map(({ system }) => system)).toEqual(['You echo in capitals.']);

    secrets.remove(DEMO_SECRET_KEY);
    await waitForCondition(
      async () => (await statusOf()) === 'needs-setup',
      'the plugin kept running after its secret was removed',
    );
    expect(await rejectionOf(bureau.tasks.start('demo:echo', 'Hello.'))).toBeInstanceOf(
      PluginNeedsSetupError,
    );
    expect(seen).toHaveLength(1);
  });
});
