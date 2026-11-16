/**
 * COR-2224 — `host.publish`: a plugin publishes an event it declared, as `<plugin>:<name>` with
 * `source: <plugin>`. The declaration is the demo plugin's `greeted` event.
 */
import { definePlugin, type PluginHost } from '@lostgradient/interborough-plugin';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from '../agent-catalog';
import type { BureauEventEnvelope } from '../bureau-event-feed';
import type { Bureau } from '../bureau-types/facade';
import { createBureau } from '../create-bureau';
import { listedPlugins } from '../testing/plugin-listing.test-support';
import { PluginNeedsSetupError } from './plugin-secret-gate';
import type { BureauPluginSecrets } from './plugin-types';

const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

const KEY = 'greeter-key';

/** A Bureau with plugin `demo` that declares `greeted`, and the host API its `setup` was given. */
async function start(pluginSecrets?: BureauPluginSecrets) {
  const held: { host?: PluginHost } = {};
  const demo = definePlugin({
    name: 'demo',
    version: '1.0.0',
    description: 'Declares one event.',
    ...(pluginSecrets === undefined ? {} : { secrets: [KEY] }),
    setup: ({ host }) => {
      held.host = host;
      return {
        events: [
          {
            name: 'greeted',
            description: 'The demo greeted someone.',
            payload: z.object({ greetingId: z.string().meta({ identifier: true }) }),
          },
        ],
      };
    },
  });
  const bureau = await createBureau<AgentDefinitions>({
    plugins: [{ descriptor: demo, source: 'package', location: '@example/demo' }],
    ...(pluginSecrets === undefined ? {} : { pluginSecrets }),
  });
  bureaus.push(bureau);
  await bureau.plugins.ready();
  return { bureau, host: held.host! };
}

/** Every envelope the Bureau's feed retains. */
async function recorded(bureau: Bureau<AgentDefinitions>): Promise<BureauEventEnvelope[]> {
  const envelopes: BureauEventEnvelope[] = [];
  for await (const envelope of bureau.internals.eventFeed.feed.replay()) envelopes.push(envelope);
  return envelopes;
}

const published = (envelopes: readonly BureauEventEnvelope[]) =>
  envelopes.filter(({ kind }) => kind.includes(':'));

describe('host.publish', () => {
  it('publishes p:<name> with source p, carrying the payload the schema accepted', async () => {
    const { bureau, host } = await start();
    const heard: string[] = [];
    bureau.addEventListener('demo:greeted' as never, (event) => heard.push(event.type));

    await host.publish('greeted', { greetingId: 'greeting-1', extra: 'dropped' });

    expect(published(await recorded(bureau))).toMatchObject([
      { kind: 'demo:greeted', source: 'demo', payload: { greetingId: 'greeting-1' } },
    ]);
    expect(published(await recorded(bureau))[0]?.payload).toEqual({ greetingId: 'greeting-1' });
    expect(heard).toEqual(['demo:greeted']);
  });

  it('rejects an undeclared name with a TypeError naming it, and publishes nothing', async () => {
    const { bureau, host } = await start();

    const error = await rejectionOf(host.publish('farewell', { greetingId: 'greeting-1' }));

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain('farewell');
    expect(published(await recorded(bureau))).toEqual([]);
  });

  it('does not take an inherited property for a declared name', async () => {
    const { bureau, host } = await start();

    expect(await rejectionOf(host.publish('constructor', {}))).toBeInstanceOf(TypeError);
    expect(published(await recorded(bureau))).toEqual([]);
  });

  it('rejects a payload that fails the declared schema, and publishes nothing', async () => {
    const { bureau, host } = await start();

    for (const payload of [{}, { greetingId: 3 }, null, 'greeting-1']) {
      expect(await rejectionOf(host.publish('greeted', payload))).toBeInstanceOf(TypeError);
    }

    expect(published(await recorded(bureau))).toEqual([]);
  });

  it('refuses while a secret the plugin declared is not set, and publishes after it is saved', async () => {
    const values = new Map<string, string>();
    const watchers = new Set<() => void>();
    const secrets: BureauPluginSecrets = {
      get: async (key) => values.get(key),
      watch: (_key, listener) => {
        watchers.add(listener);
        return () => watchers.delete(listener);
      },
    };
    const { bureau, host } = await start(secrets);

    const refused = await rejectionOf(host.publish('greeted', { greetingId: 'greeting-1' }));
    expect(refused).toBeInstanceOf(PluginNeedsSetupError);
    expect(published(await recorded(bureau))).toEqual([]);

    values.set(KEY, 'secret-value');
    for (const listener of watchers) listener();
    await waitUntil(async () => (await listedPlugins(bureau))[0]?.status === 'running', {
      message: 'the plugin to leave needs-setup',
    });
    await host.publish('greeted', { greetingId: 'greeting-1' });
    expect(published(await recorded(bureau)).map(({ kind }) => kind)).toEqual(['demo:greeted']);
  });
});
