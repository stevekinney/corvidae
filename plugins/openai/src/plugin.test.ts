import { createPluginTestHost } from '@lostgradient/bureau/testing';
import { pluginContract } from '@lostgradient/interborough-plugin/testing';
import { describe, expect, test } from 'bun:test';

import plugin from './plugin.ts';

pluginContract(plugin, { createHost: createPluginTestHost });

const secrets = { get: async () => undefined };

describe('the openai plugin', () => {
  test('declares exactly the openai API key the host has always used', () => {
    expect(plugin.secrets).toEqual(['openai-api-key']);
  });

  test("contributes the openai provider with Operative's catalog rows", async () => {
    const result = await plugin.setup?.({ secrets } as never);
    expect(result?.providers?.map((provider) => provider.name)).toEqual(['openai']);
    expect(result?.providers?.[0]?.rows).toBeUndefined();
  });

  test('takes an allowlist of models, and nothing else, as its configuration', () => {
    expect(plugin.configuration?.safeParse({ models: ['a'] }).success).toBe(true);
    expect(plugin.configuration?.safeParse({}).success).toBe(true);
    expect(plugin.configuration?.safeParse({ models: [] }).success).toBe(false);
    expect(plugin.configuration?.safeParse({ other: 1 }).success).toBe(false);
  });

  test('contributes an embedder that reads the key when it embeds, and refuses without one', async () => {
    const result = await plugin.setup?.({ secrets } as never);
    const embedder = result?.embedders?.[0];
    expect(embedder?.name).toBe('text-embedding-3-small');
    expect(embedder?.dimensions).toBe(1536);
    const failure = await Promise.resolve(embedder?.embed(['text'])).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(String(failure)).toContain('openai-api-key');
  });
});
