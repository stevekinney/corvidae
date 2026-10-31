import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { createPluginStorage, definePlugin, pluginStoragePrefix } from './index.ts';

const valid = { name: 'example', version: '1.0.0', description: 'An example plugin.' };

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
        evalJudges: [
          {
            name: configuration.teamKey,
            version: '1.0.0',
            evaluate: () => ({ pass: true, score: 1, message: 'ok' }),
          },
        ],
      }),
    });
    const result = await plugin.setup?.({
      configuration: { teamKey: 'COR' },
      secrets: { get: async () => undefined },
      storage: new MemoryStorage(),
    });
    expect(result?.evalJudges?.[0]?.name).toBe('COR');
  });

  test('types an activity that declares its own version', async () => {
    const plugin = definePlugin({
      ...valid,
      setup: () => ({
        activities: [
          { name: 'sync-issue', version: '2.1.0', execute: async () => ({ synced: true }) },
        ],
      }),
    });
    const result = await plugin.setup?.({
      configuration: {},
      secrets: { get: async () => undefined },
      storage: new MemoryStorage(),
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

  test('refuses an empty version or description', () => {
    expect(() => definePlugin({ ...valid, version: ' ' })).toThrow(/version/);
    expect(() => definePlugin({ ...valid, description: '' })).toThrow(/description/);
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
