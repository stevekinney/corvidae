/**
 * COR-2244 — a plugin contributes a code workflow (`PluginContributions.workflows`). Composition
 * registers it as `plugin:name` in the versioned catalog under the kind `workflow`, lists it as a
 * `workflow` contribution, refuses one without a `title` or an `inputSchema` with
 * `workflow-field-missing`, and skips a plugin whose workflow name a host code workflow holds.
 */
import { definePlugin, type PluginWorkflow } from '@lostgradient/interborough-plugin';
import { workflow } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { type ComposableOptions, composePlugins } from './plugins/compose-plugins';
import { createVersionedCatalog } from './versioned-catalog';
import { createWorkflowContributions } from './workflow-contributions';

/** Composition over `options`, typed as the options `createBureau` hands it. */
const compose = (options: ComposableOptions) => composePlugins(options);

/** A complete code workflow named `sync`, with `extra` laid over it. */
function syncWorkflow(extra: Record<string, unknown> = {}): PluginWorkflow {
  return {
    ...workflow({ name: 'sync' }).execute(async function* () {
      return 'synced';
    }),
    title: 'Sync issues',
    inputSchema: z.object({ team: z.string() }),
    ...extra,
  } as PluginWorkflow;
}

/** `item` with `field` removed, as a plugin written in JavaScript can leave it. */
function without(field: 'title' | 'inputSchema', value?: unknown): PluginWorkflow {
  const complete: Record<string, unknown> = { ...syncWorkflow() };
  delete complete[field];
  return (value === undefined
    ? complete
    : { ...complete, [field]: value }) as unknown as PluginWorkflow;
}

function pluginOf(name: string, workflows: readonly PluginWorkflow[], version = '1.0.0') {
  return {
    descriptor: definePlugin({
      name,
      version,
      description: 'Contributes a workflow.',
      setup: () => ({ workflows }),
    }),
    source: 'package' as const,
    location: `@example/${name}`,
  };
}

describe('a plugin that contributes a code workflow', () => {
  it('registers it as plugin:name and lists a workflow contribution', async () => {
    const composed = await compose({ plugins: [pluginOf('kit', [syncWorkflow()])] });
    const [record] = composed.records;
    expect(record?.status).toBe('running');
    expect(record?.problems).toEqual([]);
    expect(record?.contributions).toEqual([
      { kind: 'workflow', id: 'kit:sync', title: 'Sync issues' },
    ]);
    const entries = composed.options.contributionCatalog?.entries('workflow') ?? [];
    expect(entries.map((entry) => [entry.name, entry.version, entry.source.name])).toEqual([
      ['kit:sync', '1.0.0', 'kit'],
    ]);
  });

  it('registers a plugin that contributes nothing else (a workflows-only plugin)', async () => {
    const composed = await compose({
      plugins: [pluginOf('only', [syncWorkflow({ name: 'only-one' })])],
    });
    expect(composed.options.contributionCatalog?.entries('workflow')).toHaveLength(1);
  });

  const VERSIONS = [
    { name: 'declares none: the plugin’s', declared: undefined, pinned: '2.3.4' },
    { name: 'declares its own', declared: '7', pinned: '7' },
  ] as const;
  for (const { name, declared, pinned } of VERSIONS) {
    it(`pins the version the workflow ${name}`, async () => {
      const composed = await compose({
        plugins: [
          pluginOf(
            'kit',
            [syncWorkflow(declared === undefined ? {} : { version: declared })],
            '2.3.4',
          ),
        ],
      });
      const contributions = createWorkflowContributions(composed.options.contributionCatalog);
      expect(contributions.workflows.get('kit:sync')?.version).toBe(pinned);
    });
  }

  const REFUSALS = [
    { name: 'no title', item: without('title'), fields: ['title'] },
    { name: 'a blank title', item: without('title', ' '), fields: ['title'] },
    { name: 'no inputSchema', item: without('inputSchema'), fields: ['inputSchema'] },
    {
      name: 'neither',
      item: {
        ...workflow({ name: 'sync' }).execute(async function* () {}),
      } as unknown as PluginWorkflow,
      fields: ['title', 'inputSchema'],
    },
  ] as const;
  for (const { name, item, fields } of REFUSALS) {
    it(`is skipped with workflow-field-missing for ${name}`, async () => {
      const composed = await compose({ plugins: [pluginOf('kit', [item])] });
      const [record] = composed.records;
      expect(record?.status).toBe('skipped');
      expect(record?.problems).toEqual(
        fields.map((field) => ({ code: 'workflow-field-missing', workflow: 'sync', field })),
      );
      expect(composed.options.contributionCatalog?.entries('workflow') ?? []).toEqual([]);
    });
  }

  const SETUP_FAILURES = [
    { name: 'a name that is not a contribution name', item: syncWorkflow({ name: 'Sync' }) },
    { name: 'a name with a double underscore', item: syncWorkflow({ name: 'a__b' }) },
  ] as const;
  for (const { name, item } of SETUP_FAILURES) {
    it(`is skipped with setup-failed for ${name}`, async () => {
      const composed = await compose({ plugins: [pluginOf('kit', [item])] });
      expect(composed.records[0]?.status).toBe('skipped');
      expect(composed.records[0]?.problems[0]?.code).toBe('setup-failed');
    });
  }

  it('is skipped with name-clash when one plugin names two workflows alike', async () => {
    const composed = await compose({
      plugins: [pluginOf('kit', [syncWorkflow(), syncWorkflow()])],
    });
    expect(composed.records[0]?.status).toBe('skipped');
    expect(composed.records[0]?.problems[0]?.code).toBe('name-clash');
  });

  it('is skipped with name-clash when a host code workflow holds the name (first loaded wins)', async () => {
    const host = createVersionedCatalog();
    host.register({
      kind: 'workflow',
      name: 'kit:sync',
      version: '1',
      value: syncWorkflow(),
      source: { name: 'host', version: '1' },
    });
    const composed = await compose({
      contributionCatalog: host,
      plugins: [pluginOf('kit', [syncWorkflow()])],
    });
    expect(composed.records[0]?.status).toBe('skipped');
    expect(composed.records[0]?.problems).toMatchObject([
      { code: 'name-clash', first: { source: 'built-in' } },
    ]);
    expect(composed.options.contributionCatalog?.entries('workflow')).toHaveLength(1);
  });
});

describe('the versioned catalog and the contributed workflows', () => {
  it('holds the kind workflow', () => {
    const catalog = createVersionedCatalog();
    const result = catalog.register({
      kind: 'workflow',
      name: 'kit:sync',
      version: '1',
      value: syncWorkflow(),
      source: { name: 'kit', version: '1' },
    });
    expect(result.ok).toBe(true);
    expect(catalog.resolve('workflow', 'kit:sync@1').ok).toBe(true);
    expect(catalog.resolve('workflow', 'kit:sync@2')).toMatchObject({
      ok: false,
      reason: 'version-mismatch',
    });
  });

  const FIELDS = [
    ['title', without('title'), 'has no title'],
    ['inputSchema', without('inputSchema'), 'has no inputSchema'],
  ] as const;
  for (const [field, item, message] of FIELDS) {
    it(`throws a TypeError naming the workflow when ${field} is missing`, () => {
      const catalog = createVersionedCatalog();
      catalog.register({
        kind: 'workflow',
        name: 'kit:sync',
        version: '1',
        value: item,
        source: { name: 'kit', version: '1' },
      });
      expect(() => createWorkflowContributions(catalog)).toThrow(
        new TypeError(`The workflow "kit:sync" ${message}.`),
      );
    });
  }
});
