/**
 * COR-1884 — the providers a running plugin contributes reach a `models.catalog` factory, with the
 * rows of their models, once setup has run.
 */
import { definePlugin, type PluginSetupResult } from '@lostgradient/interborough-plugin';
import { createModelCatalog, type BackendDescriptor } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { type ComposableOptions, composePlugins } from './compose-plugins';
import type { BureauPluginEntry, PluginModelContributions } from './plugin-types';

const definition = (name: string) => ({
  name,
  generate: () => async () => ({ content: '', toolCalls: [] }) as never,
  stream: () => (async () => ({}) as never) as never,
});

function pluginEntry(name: string, setup: () => PluginSetupResult): BureauPluginEntry {
  const descriptor = definePlugin({ name, version: '1.0.0', description: name, setup });
  return { descriptor, source: 'package', location: `@example/${name}` };
}

/** A catalog row of `provider`, copied from the static catalog and renamed. */
function row(provider: string, model: string): BackendDescriptor {
  const [seed] = createModelCatalog().descriptors;
  if (seed === undefined) throw new Error('The static catalog is empty.');
  return { ...seed, provider, model, aliases: [] };
}

/** The rows composition left in `options.models.catalog`; a factory must be gone by then. */
function resolvedRows(options: ComposableOptions): readonly BackendDescriptor[] | undefined {
  const catalog = options.models?.catalog;
  if (typeof catalog === 'function') throw new Error('The factory was not resolved.');
  return catalog;
}

describe('the models.catalog factory', () => {
  it('receives each contributed provider with its rows, in load order', async () => {
    const received: PluginModelContributions[] = [];
    const alpha = { ...definition('alpha'), rows: [row('alpha', 'alpha-1')] };
    const composed = await composePlugins({
      plugins: [
        pluginEntry('first', () => ({ providers: [alpha] })),
        pluginEntry('second', () => ({ providers: [definition('beta')] })),
      ],
      models: {
        catalog: (contributions) => {
          received.push(contributions);
          return contributions.providers.flatMap((provider) => provider.rows);
        },
      },
    });
    expect(received).toHaveLength(1);
    expect(
      received[0]?.providers.map(({ plugin, definition: found }) => [plugin, found.name]),
    ).toEqual([
      ['first', 'alpha'],
      ['second', 'beta'],
    ]);
    expect(received[0]?.providers[0]?.rows.map((entry) => entry.model)).toEqual(['alpha-1']);
    expect(resolvedRows(composed.options)).toEqual(alpha.rows);
  });

  it('defaults a provider without rows to the static rows of its name', async () => {
    const received: PluginModelContributions[] = [];
    await composePlugins({
      plugins: [pluginEntry('anthropic', () => ({ providers: [definition('anthropic')] }))],
      models: {
        catalog: (contributions) => {
          received.push(contributions);
          return [];
        },
      },
    });
    const expected = createModelCatalog().descriptors.filter(
      (entry) => entry.provider === 'anthropic',
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(received[0]?.providers[0]?.rows.map((entry) => entry.model)).toEqual(
      expected.map((entry) => entry.model),
    );
  });

  it('is called with nothing contributed when no plugin runs, and awaits an async factory', async () => {
    const only = row('x', 'y');
    const composed = await composePlugins({
      models: {
        catalog: async (contributions) => (contributions.providers.length === 0 ? [only] : []),
      },
    });
    expect(resolvedRows(composed.options)).toEqual([only]);
  });

  it('leaves a plugin out of the contributions when it is skipped, and does not touch a list of rows', async () => {
    const given = [row('x', 'y')];
    const composed = await composePlugins({ models: { catalog: given } });
    expect(resolvedRows(composed.options)).toEqual(given);
  });

  it('skips a plugin whose row names another provider', async () => {
    const stray = { ...definition('alpha'), rows: [row('beta', 'beta-1')] };
    const { records } = await composePlugins({
      plugins: [pluginEntry('alpha', () => ({ providers: [stray] }))],
    });
    expect(records[0]?.status).toBe('skipped');
    expect(JSON.stringify(records[0]?.problems)).toContain('catalog row for the provider');
  });
});
