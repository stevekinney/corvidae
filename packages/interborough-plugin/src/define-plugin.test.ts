import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  createPluginStorage,
  definePlugin,
  type PluginHost,
  pluginStoragePrefix,
} from './index.ts';

const valid = { name: 'example', version: '1.0.0', description: 'An example plugin.' };

/** A host API no test here calls. */
const unstartedHost: PluginHost = {
  agents: { list: () => [] },
  schedules: { create: async () => undefined, list: async () => undefined },
  goals: { create: async () => ({ outcome: 'rejected' }) },
  publish: async () => undefined,
  decisions: { decide: async () => Promise.reject(new Error('No test here asks a decision.')) },
};

describe('definePlugin', () => {
  test('returns the descriptor it was given', () => {
    const descriptor = { ...valid, secrets: ['example-api-key', { key: 'seed', generated: true }] };
    expect(definePlugin(descriptor)).toBe(descriptor);
  });

  test('types setup configuration from the schema', async () => {
    const plugin = definePlugin({
      ...valid,
      configuration: z.object({ teamKey: z.string().default('COR') }),
      setup: ({ configuration }) => ({
        scorers: [
          {
            name: configuration.teamKey,
            version: '1.0.0',
            score: () => ({ outcome: 'pass', score: 1, message: 'ok' }),
          },
        ],
      }),
    });
    const result = await plugin.setup?.({
      configuration: { teamKey: 'COR' },
      secrets: { get: async () => undefined },
      storage: new MemoryStorage(),
      host: unstartedHost,
      approvals: () => ({}),
    });
    expect(result?.scorers?.[0]?.name).toBe('COR');
  });

  test('types an activity that declares its own version', async () => {
    const plugin = definePlugin({
      ...valid,
      setup: () => ({
        activities: [
          {
            name: 'sync-issue',
            version: '2.1.0',
            title: 'Sync an issue',
            inputSchema: z.object({}),
            execute: async () => ({ synced: true }),
          },
        ],
      }),
    });
    const result = await plugin.setup?.({
      configuration: {},
      secrets: { get: async () => undefined },
      storage: new MemoryStorage(),
      host: unstartedHost,
      approvals: () => ({}),
    });
    expect(result?.activities?.[0]?.version).toBe('2.1.0');
  });

  test.each(['', 'Example', '1example', 'a_b', 'a:b', 'a--', '-a', 'a b'])(
    'refuses the plugin name %p',
    (name) => {
      expect(() => definePlugin({ ...valid, name })).toThrow(/Plugin name/);
    },
  );

  test.each(['a', 'a1', 'a-b', 'demo', 'linear-2'])('accepts the plugin name %p', (name) => {
    expect(definePlugin({ ...valid, name }).name).toBe(name);
  });

  test('accepts a title, and refuses an empty one', () => {
    expect(definePlugin({ ...valid, title: 'Web search' }).title).toBe('Web search');
    expect(() => definePlugin({ ...valid, title: ' ' })).toThrow(/title/);
  });

  test('refuses an empty version or description', () => {
    expect(() => definePlugin({ ...valid, version: ' ' })).toThrow(/version/);
    expect(() => definePlugin({ ...valid, description: '' })).toThrow(/description/);
  });

  test('returns a descriptor with hooks as it was given (COR-2180)', () => {
    const descriptor = {
      ...valid,
      hooks: [
        {
          name: 'Post settled runs',
          events: ['run.settled'],
          reaction: 'post-message',
          configuration: { channel: 'ops' },
          scope: { kind: 'agent' as const, id: 'writer' },
        },
        { name: 'Post started runs', events: ['run.started'], reaction: 'post-message' },
      ],
      setup: () => ({
        reactions: [
          {
            name: 'post-message',
            description: 'Posts the event.',
            configuration: z.object({ channel: z.string() }),
            run: async () => undefined,
          },
        ],
      }),
    };
    const plugin = definePlugin(descriptor);
    expect(plugin).toBe(descriptor);
    expect(plugin.hooks?.map(({ name }) => name)).toEqual([
      'Post settled runs',
      'Post started runs',
    ]);
  });

  test('refuses an empty or repeated secret key', () => {
    expect(() => definePlugin({ ...valid, secrets: [''] })).toThrow(/empty key/);
    expect(() => definePlugin({ ...valid, secrets: ['k', { key: 'k' }] })).toThrow(/twice/);
  });
});

describe('createPluginStorage', () => {
  test('confines keys to plugin:<name>:', async () => {
    await using backing = new MemoryStorage();
    const storage = createPluginStorage(backing, 'example');
    await storage.put('state', new Uint8Array([7]));
    expect(await backing.get('plugin:example:state')).toEqual(new Uint8Array([7]));
    expect(await createPluginStorage(backing, 'other').get('state')).toBeNull();
  });

  test('refuses a name that could reach into another prefix', () => {
    expect(pluginStoragePrefix('example')).toBe('plugin:example:');
    expect(() => pluginStoragePrefix('a:b')).toThrow(TypeError);
  });
});
