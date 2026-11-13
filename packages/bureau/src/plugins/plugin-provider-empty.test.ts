/**
 * COR-2145 — a provider that contributes no rows records a `provider-empty` problem on its
 * plugin, which keeps running with its other contributions.
 */
import { definePlugin, type PluginProvider } from '@lostgradient/interborough-plugin';
import { createModelCatalog } from '@lostgradient/operative';
import { createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { composePlugins } from './compose-plugins';
import type { PluginModelContributions } from './plugin-types';

const provider = (name: string, rows?: PluginProvider['rows']): PluginProvider => ({
  name,
  generate: () => async () => ({ content: '', toolCalls: [] }),
  stream: () => async () => ({}) as never,
  ...(rows === undefined ? {} : { rows }),
});

async function compose(providers: readonly PluginProvider[]) {
  let received: PluginModelContributions | undefined;
  const descriptor = definePlugin({
    name: 'lender',
    version: '1.0.0',
    description: 'Contributes a model provider and a tool.',
    setup: () => ({
      providers: [...providers],
      tools: [createTool({ name: 'lend', description: 'Lends.', execute: async () => 'ok' })],
    }),
  });
  const composed = await composePlugins({
    plugins: [{ descriptor, source: 'package', location: '@example/lender' }],
    models: {
      catalog: (contributions) => {
        received = contributions;
        return [];
      },
    },
  });
  const [record] = composed.records;
  return { record, received, tools: Object.keys(composed.tools) };
}

describe('a provider that contributes no rows', () => {
  it('records provider-empty, and the plugin’s other contributions still load', async () => {
    const { record, received, tools } = await compose([provider('nowhere')]);
    expect(record?.status).toBe('running');
    expect(record?.problems).toEqual([{ code: 'provider-empty', provider: 'nowhere' }]);
    expect(record?.contributions.map(({ kind }) => kind)).toContain('tool');
    expect(tools.length).toBeGreaterThan(0);
    expect(received?.providers.map(({ definition }) => definition.name)).toEqual(['nowhere']);
  });

  it('names only the empty provider among several', async () => {
    const [row] = createModelCatalog().descriptors;
    if (row === undefined) throw new Error('the seed catalog has no rows');
    const { record } = await compose([
      provider('nowhere'),
      provider('stocked', [{ ...row, provider: 'stocked' }]),
    ]);
    expect(record?.problems).toEqual([{ code: 'provider-empty', provider: 'nowhere' }]);
  });

  it('records no problem when the provider carries rows', async () => {
    const [row] = createModelCatalog().descriptors;
    if (row === undefined) throw new Error('the seed catalog has no rows');
    const { record } = await compose([provider('stocked', [{ ...row, provider: 'stocked' }])]);
    expect(record?.status).toBe('running');
    expect(record?.problems).toEqual([]);
  });

  it('records no problem when the seed knows the provider’s name', async () => {
    const [row] = createModelCatalog().descriptors;
    if (row === undefined) throw new Error('the seed catalog has no rows');
    const { record } = await compose([provider(row.provider)]);
    expect(record?.problems).toEqual([]);
  });
});
