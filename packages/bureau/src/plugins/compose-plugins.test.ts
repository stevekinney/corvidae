/**
 * COR-1879 — what a running plugin contributes reaches the option it belongs to.
 */
import { definePlugin, type PluginSetupResult } from '@lostgradient/interborough-plugin';
import { createAgent } from '@lostgradient/operative';
import { createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createVersionedCatalog } from '../versioned-catalog';
import {
  type ComposableOptions,
  composePlugins,
  HOST_HELD_KINDS,
  registersKind,
} from './compose-plugins';
import { createPluginRegistry } from './plugin-registry';
import type { BureauPluginEntry, PluginContributionKind } from './plugin-types';

function pluginEntry(name: string, setup: () => PluginSetupResult): BureauPluginEntry {
  const descriptor = definePlugin({ name, version: '1.0.0', description: name, setup });
  return { descriptor, source: 'package', location: `@example/${name}` };
}

const agent = () => createAgent({ generate: async () => ({ content: '', toolCalls: [] }) });
const judge = (name: string) => ({
  name,
  version: '1',
  evaluate: () => ({ pass: true, score: 1, message: '' }),
});
const actionKind = (name: string) => ({
  name,
  description: 'Pages someone.',
  configuration: z.object({}),
  run: async () => undefined,
});
const formatter = (name: string) => ({ name, eventKinds: [], format: () => ({ title: name }) });

/**
 * For each contribution kind: what a host option holding `p:x` looks like, and what plugin `p`
 * returns to contribute `x`; or why the host has no entry to hold one. Typed over every kind, so a
 * new kind cannot be added without saying which it is.
 */
const HOST_ENTRY: Record<
  PluginContributionKind,
  | {
      readonly host: Partial<ComposableOptions>;
      readonly contribution: PluginSetupResult;
    }
  | { readonly noHostEntry: string }
> = {
  tool: {
    host: {
      agentSource: {
        tools: {
          'p:x': createTool({ name: 'x', description: 'x', execute: async () => 'x' }),
        },
      } as never,
    },
    contribution: {
      tools: [createTool({ name: 'x', description: 'x', execute: async () => 'x' })],
    },
  },
  activity: {
    host: {
      contributionCatalog: (() => {
        const catalog = createVersionedCatalog();
        catalog.register({
          kind: 'activity',
          name: 'p:x',
          version: '1',
          value: {},
          source: { name: 'host', version: '1' },
        });
        return catalog;
      })(),
    },
    contribution: { activities: [{ name: 'x', execute: async () => 'x' }] },
  },
  'trigger-kind': {
    host: {
      contributionCatalog: (() => {
        const catalog = createVersionedCatalog();
        catalog.register({
          kind: 'trigger-kind',
          name: 'p:x',
          version: '1',
          value: {},
          source: { name: 'host', version: '1' },
        });
        return catalog;
      })(),
    },
    contribution: {
      triggerKinds: [
        {
          name: 'x',
          version: '1',
          description: 'x',
          configuration: z.object({}),
          start: async () => () => undefined,
        },
      ],
    },
  },
  validator: {
    host: {
      validators: [
        { identity: { name: 'p:x', version: '1' }, validate: () => ({ status: 'met' }) as never },
      ],
    },
    contribution: {
      validators: [
        { identity: { name: 'x', version: '1' }, validate: () => ({ status: 'met' }) as never },
      ],
    },
  },
  guardrail: {
    host: {
      agentContributions: { guardrails: new Map([['p:x', {} as never]]), runHooks: new Map() },
    },
    contribution: {
      guardrails: { inputDetectors: [{ name: 'x', detect: async () => ({}) as never }] },
    },
  },
  'run-hooks': {
    host: {
      agentContributions: { guardrails: new Map(), runHooks: new Map([['p:x', {} as never]]) },
    },
    contribution: { runHooks: [{ name: 'x' }] },
  },
  'decision-router': {
    host: {
      decisions: {
        models: { 'p:x': { name: 'p:x', kinds: new Set(), decide: async () => ({}) as never } },
      },
    },
    contribution: {
      decisionRouters: [{ name: 'x', kinds: new Set(), decide: async () => ({}) as never }],
    },
  },
  'hook-action': {
    host: { hooks: { actionKinds: [{ plugin: 'p', kind: actionKind('x') }] } },
    contribution: { hookActionKinds: [actionKind('x')] },
  },
  'event-formatter': {
    host: { eventFormatters: [{ plugin: 'p', formatter: formatter('x') }] },
    contribution: { eventFormatters: [formatter('x')] },
  },
  'code-agent': {
    host: { agents: { 'p:x': agent() } },
    contribution: { codeAgents: [{ name: 'x', agent: agent() }] },
  },
  'eval-judge': {
    host: { onlineEvals: { judges: [judge('p:x')], sampleRate: 1 } },
    contribution: { evalJudges: [judge('x')] },
  },
  provider: {
    noHostEntry:
      'A provider is handed to the host’s `models.catalog` factory, which holds no names.',
  },
  'mcp-app': {
    noHostEntry:
      'Bureau has no MCP app option; the host reads them from `bureau.plugins.mcpApps()`.',
  },
  embedder: {
    noHostEntry:
      'The host registers its embedders inside its own memory factory; a plugin id is `p:x`, never `hashing`.',
  },
  'memory-detector': {
    noHostEntry: 'The host passes its detectors inside its own memory factory.',
  },
};

describe('composePlugins', () => {
  it('folds every contribution kind into its Bureau option, under plugin:name', async () => {
    const everything = definePlugin({
      name: 'kit',
      version: '1.2.0',
      description: 'Contributes one of each.',
      setup: () => ({
        activities: [{ name: 'fetch', execute: async () => 'fetched' }],
        triggerKinds: [
          {
            name: 'inbox',
            version: '0.1.0',
            description: 'Mail arrives.',
            configuration: z.object({}),
            start: async () => () => undefined,
          },
        ],
        validators: [
          {
            identity: { name: 'tidy', version: '1' },
            validate: () => ({ status: 'met' }) as never,
          },
        ],
        guardrails: { inputDetectors: [{ name: 'scan', detect: async () => ({}) as never }] },
        runHooks: [{ name: 'audit' }],
        decisionRouters: [{ name: 'router', kinds: new Set(), decide: async () => ({}) as never }],
        hookActionKinds: [
          {
            name: 'page',
            description: 'Pages someone.',
            configuration: z.object({}),
            run: async () => undefined,
          },
        ],
        evalJudges: [
          { name: 'judge', version: '1', evaluate: () => ({ pass: true, score: 1, message: '' }) },
        ],
        codeAgents: [
          {
            name: 'writer',
            agent: createAgent({ generate: async () => ({ content: '', toolCalls: [] }) }),
          },
        ],
      }),
    });
    const given: ComposableOptions = {
      plugins: [{ descriptor: everything, source: 'package', location: '@example/kit' }],
      hooks: {},
      onlineEvals: { judges: [], sampleRate: 1 },
    };
    const { options, records } = await composePlugins(given);

    expect(records[0]?.status).toBe('running');
    expect(options.contributionCatalog?.resolve('activity', 'kit:fetch@1.2.0').ok).toBe(true);
    expect(options.contributionCatalog?.resolve('trigger-kind', 'kit:inbox@0.1.0').ok).toBe(true);
    expect(options.validators?.map(({ identity }) => identity)).toEqual([
      { name: 'kit:tidy', version: '1' },
    ]);
    expect([...(options.agentContributions?.guardrails.keys() ?? [])]).toEqual(['kit:scan']);
    expect([...(options.agentContributions?.runHooks.keys() ?? [])]).toEqual(['kit:audit']);
    expect(Object.keys(options.decisions?.models ?? {})).toEqual(['kit:router']);
    // A delivery of the kind pins the plugin's version, since the kind declares none.
    expect(
      options.hooks?.actionKinds?.map(
        ({ plugin, kind, version }) => `${plugin}/${kind.name}@${String(version)}`,
      ),
    ).toEqual(['kit/page@1.2.0']);
    expect(options.onlineEvals?.judges.map(({ name }) => name)).toEqual(['kit:judge']);
    expect(Object.keys(options.agents ?? {})).toEqual(['kit:writer']);
  });

  it('refuses a plugin that claims a name a host option holds, for every kind a host can hold', async () => {
    const held = Object.entries(HOST_ENTRY).filter(([, entry]) => 'host' in entry);
    expect(new Set(held.map(([kind]) => kind))).toEqual(new Set(HOST_HELD_KINDS));
    for (const [kind, entry] of held) {
      if (!('host' in entry)) continue;
      const { records } = await composePlugins({
        // Each kind registers only where its option is given.
        hooks: {},
        onlineEvals: { judges: [], sampleRate: 1 },
        ...entry.host,
        plugins: [pluginEntry('p', () => entry.contribution)],
      });
      expect({ kind, status: records[0]?.status, problems: records[0]?.problems }).toEqual({
        kind,
        status: 'skipped',
        problems: [expect.objectContaining({ code: 'name-clash', name: 'p:x' })],
      });
    }
  });

  it('lists only the contributions whose option the host gave', async () => {
    const contributing = () =>
      pluginEntry('kit', () => ({
        hookActionKinds: [actionKind('page')],
        evalJudges: [judge('judge')],
        embedders: [{ name: 'small', dimensions: 4, embed: async (texts) => texts.map(() => []) }],
        memoryDetectors: [{ name: 'tags', detect: async () => ({}) as never }],
        runHooks: [{ name: 'audit' }],
      }));
    const bare = await composePlugins<ComposableOptions>({ plugins: [contributing()] });
    expect(bare.records[0]?.contributions).toEqual([{ kind: 'run-hooks', id: 'kit:audit' }]);
    expect(bare.options.hooks).toBeUndefined();
    expect(bare.options.onlineEvals).toBeUndefined();

    const given = await composePlugins({
      plugins: [contributing()],
      hooks: {},
      onlineEvals: { judges: [], sampleRate: 1 },
      memory: () => undefined as never,
    });
    expect(given.records[0]?.contributions.map(({ kind }) => kind).toSorted()).toEqual([
      'embedder',
      'eval-judge',
      'hook-action',
      'memory-detector',
      'run-hooks',
    ]);
    for (const kind of ['embedder', 'eval-judge', 'hook-action'] as const) {
      expect(registersKind(kind, {})).toBe(false);
    }
  });

  it('skips a malformed plugin instead of failing composition', async () => {
    const malformed: BureauPluginEntry = {
      // Not through `definePlugin`, which would refuse the name where the plugin is written.
      descriptor: { name: 'Not A Name', version: '1.0.0', description: 'x' } as never,
      source: 'folder',
      location: '/plugins/bad',
    };
    const { records } = await composePlugins({
      plugins: [
        malformed,
        pluginEntry('underscored', () => ({
          tools: [
            createTool({ name: 'has_underscore', description: 'x', execute: async () => 'x' }),
          ],
        })),
        pluginEntry('flat', () => ({
          embedders: [{ name: 'zero', dimensions: 0, embed: async () => [] }],
        })),
        pluginEntry('fine', () => ({ runHooks: [{ name: 'audit' }] })),
      ],
    });
    // Package plugins first, then the folder plugin.
    expect(records.map(({ status, problems }) => [status, problems[0]?.code])).toEqual([
      ['skipped', 'setup-failed'],
      ['skipped', 'setup-failed'],
      ['running', undefined],
      ['skipped', 'setup-failed'],
    ]);
  });

  it('reads the caller’s plugin list and configuration before the first setup awaits', async () => {
    const seen: unknown[] = [];
    const reading = (name: string) =>
      definePlugin({
        name,
        version: '1.0.0',
        description: name,
        configuration: z.object({ limit: z.number() }),
        setup: async ({ configuration }) => {
          await Promise.resolve();
          seen.push(configuration.limit);
          return {};
        },
      });
    const plugins: BureauPluginEntry[] = [
      { descriptor: reading('first'), source: 'package', location: '@example/first' },
      { descriptor: reading('second'), source: 'package', location: '@example/second' },
    ];
    const pluginConfiguration: Record<string, { configuration: { limit: number } }> = {
      first: { configuration: { limit: 1 } },
      second: { configuration: { limit: 2 } },
    };
    const composing = composePlugins({ plugins, pluginConfiguration });
    pluginConfiguration['second'] = { configuration: { limit: 99 } };
    plugins.pop();
    const { records } = await composing;
    expect(records).toHaveLength(2);
    expect(seen).toEqual([1, 2]);
  });
});

describe('MCP apps a plugin contributes', () => {
  const mcpApp = (name: string, uri: string, tool = 'bureau.tasks.inspect') => ({
    name,
    title: name,
    uri,
    entry: new URL(`file:///${name}/app.ts`),
    allowedTools: [tool],
    opensFromTool: tool,
  });

  it('lists the apps of the running plugins, in load order, for the host to serve', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [
        pluginEntry('first', () => ({ mcpApps: [mcpApp('one', 'ui://first/one/v1')] })),
        pluginEntry('second', () => ({ mcpApps: [mcpApp('two', 'ui://second/two/v1')] })),
      ],
      pluginConfiguration: { second: { enabled: false } },
    });
    const { plugins } = createPluginRegistry(records);
    expect(plugins.mcpApps().map(({ plugin, version, app }) => [plugin, version, app.uri])).toEqual(
      [['first', '1.0.0', 'ui://first/one/v1']],
    );
  });

  it('skips a plugin whose app is opened from a tool it may not call', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [
        pluginEntry('a', () => ({
          mcpApps: [{ ...mcpApp('one', 'ui://a/one/v1'), opensFromTool: 'bureau.tasks.cancel' }],
        })),
      ],
    });
    expect(records[0]?.status).toBe('skipped');
  });

  it('skips a plugin whose app has no ui:// URI, or whose URI another plugin holds', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [
        pluginEntry('a', () => ({ mcpApps: [mcpApp('one', 'https://example.test/one')] })),
        pluginEntry('b', () => ({ mcpApps: [mcpApp('one', 'ui://shared/v1', 'tool.b')] })),
        pluginEntry('c', () => ({ mcpApps: [mcpApp('two', 'ui://shared/v1', 'tool.c')] })),
      ],
    });
    expect(records.map(({ status }) => status)).toEqual(['skipped', 'running', 'skipped']);
    expect(records[0]?.problems).toEqual([expect.objectContaining({ code: 'setup-failed' })]);
    expect(records[2]?.problems).toEqual([
      expect.objectContaining({ code: 'name-clash', name: 'ui://shared/v1' }),
    ]);
  });

  it('skips the later plugin whose app opens from a tool an earlier app already opens', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [
        pluginEntry('a', () => ({ mcpApps: [mcpApp('one', 'ui://a/one/v1')] })),
        pluginEntry('b', () => ({ mcpApps: [mcpApp('two', 'ui://b/two/v1')] })),
      ],
    });
    expect(records.map(({ status }) => status)).toEqual(['running', 'skipped']);
    expect(records[1]?.problems).toEqual([
      expect.objectContaining({ code: 'name-clash', name: 'bureau.tasks.inspect' }),
    ]);
    const { plugins } = createPluginRegistry(records);
    expect(plugins.mcpApps().map(({ plugin }) => plugin)).toEqual(['a']);
  });

  it('records a build failure the host reports against the plugin and stops listing the app', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [
        pluginEntry('a', () => ({
          mcpApps: [
            mcpApp('one', 'ui://a/one/v1'),
            mcpApp('two', 'ui://a/two/v1', 'bureau.tasks.events'),
          ],
        })),
      ],
    });
    const registry = createPluginRegistry(records);
    registry.plugins.reportMcpAppFailure('a', 'one', 'The entry does not build.');
    registry.plugins.reportMcpAppFailure('absent', 'one', 'No such plugin.');
    expect(registry.plugins.mcpApps().map(({ app }) => app.name)).toEqual(['two']);
    const [listing] = await registry.plugins.list();
    expect(listing?.status).toBe('running');
    expect(listing?.problems).toEqual([
      { code: 'mcp-app-failed', app: 'one', message: 'The entry does not build.' },
    ]);
  });
});
