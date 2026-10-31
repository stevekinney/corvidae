import { createPluginTestHost } from '@lostgradient/bureau/testing';
import { pluginContract } from '@lostgradient/interborough-plugin/testing';
import { describe, expect, test } from 'bun:test';

import plugin from './plugin.ts';

pluginContract(plugin, { createHost: createPluginTestHost });

const secrets = { get: async () => undefined };

describe('the anthropic plugin', () => {
  test('declares exactly the anthropic API key the host has always used', () => {
    expect(plugin.secrets).toEqual(['anthropic-api-key']);
  });

  test("contributes the anthropic provider with Operative's catalog rows", async () => {
    const result = await plugin.setup?.({ secrets } as never);
    expect(result?.providers?.map((provider) => provider.name)).toEqual(['anthropic']);
    expect(result?.providers?.[0]?.rows).toBeUndefined();
  });

  test('takes an allowlist of models, and nothing else, as its configuration', () => {
    expect(plugin.configuration?.safeParse({ models: ['a'] }).success).toBe(true);
    expect(plugin.configuration?.safeParse({}).success).toBe(true);
    expect(plugin.configuration?.safeParse({ models: [] }).success).toBe(false);
    expect(plugin.configuration?.safeParse({ other: 1 }).success).toBe(false);
  });

  test('contributes no embedder', async () => {
    const result = await plugin.setup?.({ secrets } as never);
    expect(result?.embedders).toBeUndefined();
  });
});
