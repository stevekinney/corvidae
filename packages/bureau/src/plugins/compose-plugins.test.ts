/**
 * COR-1879 — what a running plugin contributes reaches the option it belongs to.
 */
import {
  definePlugin,
  type PluginSetupContext,
  type PluginSetupResult,
} from '@lostgradient/interborough-plugin';
import { createAgent, guardrailOf } from '@lostgradient/operative';
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
    contribution: {
      activities: [{ name: 'x', title: 'X', inputSchema: z.object({}), execute: async () => 'x' }],
    },
  },
  trigger: {
    host: {
      contributionCatalog: (() => {
        const catalog = createVersionedCatalog();
        catalog.register({
          kind: 'trigger',
          name: 'p:x',
          version: '1',
          value: {},
          source: { name: 'host', version: '1' },
        });
        return catalog;
      })(),
    },
    contribution: {
      triggers: [
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
      agentContributions: {
        guardrails: new Map([['p:x', { inputDetector: { name: 'x' } } as never]]),
        interceptors: new Map(),
      },
    },
    contribution: {
      guardrails: {
        input: [{ name: 'x', description: 'A test guardrail.', detect: async () => ({}) as never }],
      },
    },
  },
  interceptor: {
    host: {
      agentContributions: { guardrails: new Map(), interceptors: new Map([['p:x', {} as never]]) },
    },
    contribution: { interceptors: [{ name: 'x' }] },
  },
  reaction: {
    host: { hooks: { actionKinds: [{ plugin: 'p', kind: actionKind('x') }] } },
    contribution: { reactions: [actionKind('x')] },
  },
  formatter: {
    host: { formatters: [{ plugin: 'p', formatter: formatter('x') }] },
    contribution: { formatters: [formatter('x')] },
  },
  agent: {
    host: { agents: { 'p:x': agent() } },
    contribution: { agents: [{ name: 'x', agent: agent() }] },
  },
  scorer: {
    host: { scorers: { list: [judge('p:x')], sampleRate: 1 } },
    contribution: { scorers: [judge('x')] },
  },
  provider: {
    noHostEntry:
      'A provider is handed to the host’s `models.catalog` factory, which holds no names.',
  },
  panel: {
    noHostEntry: 'Bureau has no panel option; the host reads them from `bureau.plugins.panels()`.',
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
        activities: [
          {
            name: 'fetch',
            title: 'Fetch',
            inputSchema: z.object({}),
            execute: async () => 'fetched',
          },
        ],
        triggers: [
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
        guardrails: {
          input: [
            { name: 'scan', description: 'A test guardrail.', detect: async () => ({}) as never },
          ],
        },
        interceptors: [{ name: 'audit' }],
        reactions: [
          {
            name: 'page',
            description: 'Pages someone.',
            configuration: z.object({}),
            run: async () => undefined,
          },
        ],
        scorers: [
          { name: 'judge', version: '1', evaluate: () => ({ pass: true, score: 1, message: '' }) },
        ],
        agents: [
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
      scorers: { list: [], sampleRate: 1 },
    };
    const { options, records } = await composePlugins(given);

    expect(records[0]?.status).toBe('running');
    expect(options.contributionCatalog?.resolve('activity', 'kit:fetch@1.2.0').ok).toBe(true);
    expect(options.contributionCatalog?.resolve('trigger', 'kit:inbox@0.1.0').ok).toBe(true);
    expect(options.validators?.map(({ identity }) => identity)).toEqual([
      { name: 'kit:tidy', version: '1' },
    ]);
    expect([...(options.agentContributions?.guardrails.keys() ?? [])]).toEqual(['kit:scan']);
    expect([...(options.agentContributions?.interceptors.keys() ?? [])]).toEqual(['kit:audit']);
    // A delivery of the kind pins the plugin's version, since the kind declares none.
    expect(
      options.hooks?.actionKinds?.map(
        ({ plugin, kind, version }) => `${plugin}/${kind.name}@${String(version)}`,
      ),
    ).toEqual(['kit/page@1.2.0']);
    expect(options.scorers?.list.map(({ name }) => name)).toEqual(['kit:judge']);
    expect(Object.keys(options.agents ?? {})).toEqual(['kit:writer']);
  });

  it('gives setup the host’s tool-approval rule for the tools a plugin names, and no others', async () => {
    let hooks: ReturnType<PluginSetupContext['approvals']> | undefined;
    const descriptor = definePlugin({
      name: 'p',
      version: '1.0.0',
      description: 'p',
      setup: ({ approvals }) => {
        hooks = approvals(['governed']);
        return {};
      },
    });
    await composePlugins({ plugins: [{ descriptor, source: 'package', location: '@example/p' }] });

    const decide = (toolName: string) =>
      hooks?.beforeExecute?.({
        toolName,
        metadata: { mutates: true },
        tags: [],
        configuration: { id: toolName },
      } as never);
    // A tool it names that changes something waits for an operator; one it does not name is left to the host.
    expect(await decide('governed')).toMatchObject({ allow: false, status: 'needs_approval' });
    expect(await decide('hosts-own')).toEqual({ allow: true, status: 'allow' });
  });

  it('refuses a plugin that claims a name a host option holds, for every kind a host can hold', async () => {
    const held = Object.entries(HOST_ENTRY).filter(([, entry]) => 'host' in entry);
    expect(new Set(held.map(([kind]) => kind))).toEqual(new Set(HOST_HELD_KINDS));
    for (const [kind, entry] of held) {
      if (!('host' in entry)) continue;
      const { records } = await composePlugins({
        // Each kind registers only where its option is given.
        hooks: {},
        scorers: { list: [], sampleRate: 1 },
        ...entry.host,
        plugins: [pluginEntry('p', () => entry.contribution)],
      });
      expect({ kind, status: records[0]?.status, problems: records[0]?.problems }).toEqual({
        kind,
        status: 'skipped',
        // A guardrail's name is claimed within its family.
        problems: [
          expect.objectContaining({
            code: 'name-clash',
            name: kind === 'guardrail' ? 'p:input/x' : 'p:x',
          }),
        ],
      });
    }
  });

  it('lists only the contributions whose option the host gave', async () => {
    const contributing = () =>
      pluginEntry('kit', () => ({
        reactions: [actionKind('page')],
        scorers: [judge('judge')],
        embedders: [{ name: 'small', dimensions: 4, embed: async (texts) => texts.map(() => []) }],
        guardrails: {
          memory: [
            { name: 'tags', description: 'A test guardrail.', detect: async () => ({}) as never },
          ],
        },
        interceptors: [{ name: 'audit' }],
      }));
    const bare = await composePlugins<ComposableOptions>({ plugins: [contributing()] });
    expect(bare.records[0]?.contributions).toEqual([{ kind: 'interceptor', id: 'kit:audit' }]);
    expect(bare.options.hooks).toBeUndefined();
    expect(bare.options.scorers).toBeUndefined();

    const given = await composePlugins({
      plugins: [contributing()],
      hooks: {},
      scorers: { list: [], sampleRate: 1 },
      memory: () => undefined as never,
    });
    expect(given.records[0]?.contributions.map(({ kind }) => kind).toSorted()).toEqual([
      'embedder',
      'interceptor',
      'memory-detector',
      'reaction',
      'scorer',
    ]);
    for (const kind of ['embedder', 'scorer', 'reaction'] as const) {
      expect(registersKind(kind, {})).toBe(false);
    }
  });

  describe('guardrail families', () => {
    const detect = async () => ({}) as never;
    const validate = async () => ({ valid: true, confidence: 0, category: 'x' });

    it('claims a guardrail name per family, so one name serves input, output and memory', async () => {
      const { options, records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('kit', () => ({
            guardrails: {
              input: [{ name: 'scan', description: 'A test guardrail.', detect }],
              output: [{ name: 'scan', description: 'A test guardrail.', validate }],
              memory: [{ name: 'scan', description: 'A test guardrail.', detect }],
            },
          })),
        ],
        memory: () => undefined as never,
      });

      expect(records[0]?.status).toBe('running');
      expect(records[0]?.contributions.map(({ kind, id }) => `${kind} ${id}`).toSorted()).toEqual([
        'guardrail kit:scan',
        'guardrail kit:scan',
        'memory-detector kit:scan',
      ]);
      // An agent file names `kit:scan`, which selects the input detector and the output validator.
      const chosen = options.agentContributions?.guardrails.get('kit:scan');
      expect([
        chosen?.inputDetector && guardrailOf(chosen.inputDetector).name,
        chosen?.outputValidator && guardrailOf(chosen.outputValidator).name,
      ]).toEqual(['scan', 'scan']);
    });

    it('refuses a name contributed twice within one family', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('kit', () => ({
            guardrails: {
              input: [
                { name: 'scan', description: 'A test guardrail.', detect },
                { name: 'scan', description: 'A test guardrail.', detect },
              ],
            },
          })),
        ],
      });

      expect(records[0]?.status).toBe('skipped');
      expect(records[0]?.problems).toEqual([
        expect.objectContaining({ code: 'name-clash', name: 'kit:input/scan' }),
      ]);
    });

    it('lets a host entry and a plugin hold one name in different families', async () => {
      const held = {
        id: 'kit:scan',
        plugin: 'kit',
        outputValidator: { name: 'scan', description: 'A test guardrail.', validate },
      };
      const { options, records } = await composePlugins<ComposableOptions>({
        agentContributions: {
          guardrails: new Map([['kit:scan', held as never]]),
          interceptors: new Map(),
        },
        plugins: [
          pluginEntry('kit', () => ({
            guardrails: { input: [{ name: 'scan', description: 'A test guardrail.', detect }] },
          })),
        ],
      });

      expect(records[0]?.status).toBe('running');
      const chosen = options.agentContributions?.guardrails.get('kit:scan');
      expect([
        chosen?.inputDetector && guardrailOf(chosen.inputDetector).name,
        chosen?.outputValidator && guardrailOf(chosen.outputValidator).name,
      ]).toEqual(['scan', 'scan']);
    });

    it.each([[[]], [['write']]])('refuses memory gates %j', async (gates) => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('kit', () => ({
            guardrails: {
              memory: [
                { name: 'scan', description: 'A test guardrail.', detect, gates: gates as never },
              ],
            },
          })),
        ],
      });

      expect(records[0]?.status).toBe('skipped');
      expect(records[0]?.problems).toEqual([expect.objectContaining({ code: 'setup-failed' })]);
    });

    it('claims a tool-call validator in the tools family, selectable as plugin:name (COR-2104)', async () => {
      const toolValidator = {
        name: 'scan',
        description: 'A test guardrail.',
        action: 'block' as const,
        validate,
      };
      const { options, records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('kit', () => ({
            guardrails: {
              input: [
                {
                  guardrail: { name: 'scan', description: 'A test guardrail.', detect },
                  action: 'warn',
                },
              ],
              tools: [toolValidator],
            },
          })),
        ],
      });

      expect(records[0]?.status).toBe('running');
      expect(records[0]?.contributions.map(({ kind, id }) => `${kind} ${id}`)).toEqual([
        'guardrail kit:scan',
        'guardrail kit:scan',
      ]);
      const chosen = options.agentContributions?.guardrails.get('kit:scan');
      expect(chosen?.toolValidator).toMatchObject({ name: 'scan', action: 'block' });
      expect(chosen?.inputDetector).toMatchObject({ action: 'warn' });
    });

    it('refuses a tool-call validator name a host entry already holds in that family', async () => {
      const held = {
        id: 'kit:scan',
        plugin: 'kit',
        toolValidator: { name: 'scan', description: 'A test guardrail.', validate },
      };
      const { records } = await composePlugins<ComposableOptions>({
        agentContributions: {
          guardrails: new Map([['kit:scan', held as never]]),
          interceptors: new Map(),
        },
        plugins: [
          pluginEntry('kit', () => ({
            guardrails: { tools: [{ name: 'scan', description: 'A test guardrail.', validate }] },
          })),
        ],
      });

      expect(records[0]?.status).toBe('skipped');
      expect(records[0]?.problems).toEqual([
        expect.objectContaining({ code: 'name-clash', name: 'kit:tools/scan' }),
      ]);
    });

    it.each([
      [
        'an input entry',
        {
          input: [
            {
              guardrail: { name: 'scan', description: 'A test guardrail.', detect },
              action: 'redact',
            },
          ],
        },
      ],
      [
        'an output entry',
        {
          output: [
            {
              guardrail: { name: 'scan', description: 'A test guardrail.', validate },
              action: 'sanitize',
            },
          ],
        },
      ],
      [
        'a tool-call validator',
        { tools: [{ name: 'scan', description: 'A test guardrail.', validate, action: 'redact' }] },
      ],
    ])(
      'skips a plugin whose %s carries an action its family does not have',
      async (_, guardrails) => {
        const { records } = await composePlugins<ComposableOptions>({
          plugins: [pluginEntry('kit', () => ({ guardrails: guardrails as never }))],
        });

        expect(records[0]?.status).toBe('skipped');
        expect(records[0]?.problems).toEqual([expect.objectContaining({ code: 'setup-failed' })]);
      },
    );

    // COR-2118 — every guardrail says what it guards, so a listing can tell them apart; a plugin
    // that returns one that does not (a cast past the type, or plain JavaScript) is skipped.
    it.each([
      ['an input detector', { input: [{ name: 'scan', detect }] }],
      ['an output entry', { output: [{ guardrail: { name: 'scan', validate }, action: 'warn' }] }],
      ['a tool-call validator', { tools: [{ name: 'scan', description: ' ', validate }] }],
      ['a memory guardrail', { memory: [{ name: 'scan', detect }] }],
      [
        'a factory',
        {
          output: [{ name: 'scan', configuration: z.object({}), create: () => ({ validate }) }],
        },
      ],
    ])('skips a plugin whose %s has no description', async (_, guardrails) => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [pluginEntry('kit', () => ({ guardrails: guardrails as never }))],
        memory: () => undefined as never,
      });

      expect(records[0]?.status).toBe('skipped');
      expect(records[0]?.problems).toEqual([
        expect.objectContaining({
          code: 'setup-failed',
          message: expect.stringContaining('without a description'),
        }),
      ]);
    });

    it('skips a plugin whose guardrail factory has no configuration schema', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('kit', () => ({
            guardrails: {
              input: [
                {
                  name: 'scan',
                  description: 'A test guardrail.',
                  configuration: {},
                  create: () => ({ name: 'scan', detect }),
                } as never,
              ],
            },
          })),
        ],
      });

      expect(records[0]?.status).toBe('skipped');
      expect(records[0]?.problems).toEqual([
        expect.objectContaining({
          code: 'setup-failed',
          message: expect.stringContaining('without a configuration schema'),
        }),
      ]);
    });

    // `typeof null` is `'object'`: a factory with a null configuration is malformed, and only its
    // own plugin is skipped.
    it('skips only the plugin whose guardrail factory has a null configuration', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('broken', () => ({
            guardrails: {
              output: [
                {
                  name: 'scan',
                  description: 'A test guardrail.',
                  configuration: null,
                  create: () => ({ name: 'scan', validate }),
                } as never,
              ],
            },
          })),
          pluginEntry('sound', () => ({
            guardrails: { input: [{ name: 'scan', description: 'A test guardrail.', detect }] },
          })),
        ],
      });

      expect(records.map((record) => [record.entry.descriptor.name, record.status])).toEqual([
        ['broken', 'skipped'],
        ['sound', 'running'],
      ]);
      expect(records[0]?.problems).toEqual([
        expect.objectContaining({
          code: 'setup-failed',
          message: expect.stringContaining('without a configuration schema'),
        }),
      ]);
    });

    it('registers a guardrail factory in its family, selectable as plugin:name', async () => {
      const factory = {
        name: 'scan',
        description: 'A test guardrail.',
        configuration: z.object({ level: z.number().default(1) }),
        create: () => ({ name: 'scan', validate }),
      };
      const { options, records } = await composePlugins<ComposableOptions>({
        plugins: [pluginEntry('kit', () => ({ guardrails: { output: [factory] } }))],
      });

      expect(records[0]?.status).toBe('running');
      expect(options.agentContributions?.guardrails.get('kit:scan')?.outputValidator).toBe(factory);
    });
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
        pluginEntry('fine', () => ({ interceptors: [{ name: 'audit' }] })),
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

  it.each([
    ['a priority of NaN', { handler: async () => {}, priority: Number.NaN }, '`priority`'],
    ['an infinite priority', { handler: async () => {}, priority: Infinity }, '`priority`'],
    ['a replay of its own invention', { handler: async () => {}, replay: 'maybe' }, '`replay`'],
    ['an onError that is not a function', { handler: async () => {}, onError: 'x' }, '`onError`'],
    ['a handler that is not a function', { handler: 'nope' }, 'must be a function or an object'],
  ])(
    'skips only the plugin whose interceptor declares %s, and composition succeeds',
    async (_name, onStep, message) => {
      // Once as written, and once for a plugin with a declared secret, whose hooks the secret gate
      // wraps before the plan reads them.
      for (const secrets of [undefined, ['api-key']]) {
        const descriptor = definePlugin({
          name: 'broken',
          version: '1.0.0',
          description: 'broken',
          ...(secrets === undefined ? {} : { secrets }),
          setup: () => ({ interceptors: [{ name: 'audit', onStep } as never] }),
        });
        const { records } = await composePlugins({
          plugins: [
            { descriptor, source: 'package', location: '@example/broken' },
            pluginEntry('fine', () => ({
              interceptors: [{ name: 'audit', onStep: { handler: async () => {}, priority: 5 } }],
            })),
          ],
        });
        expect(records.map(({ status }) => status)).toEqual(['skipped', 'running']);
        expect(records[0]?.problems).toEqual([
          expect.objectContaining({
            code: 'setup-failed',
            message: expect.stringContaining(message),
          }),
        ]);
      }
    },
  );

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
        pluginEntry('first', () => ({ panels: [mcpApp('one', 'ui://first/one/v1')] })),
        pluginEntry('second', () => ({ panels: [mcpApp('two', 'ui://second/two/v1')] })),
      ],
      pluginConfiguration: { second: { enabled: false } },
    });
    const { plugins } = createPluginRegistry(records);
    expect(plugins.panels().map(({ plugin, version, app }) => [plugin, version, app.uri])).toEqual([
      ['first', '1.0.0', 'ui://first/one/v1'],
    ]);
  });

  it('skips a plugin whose app is opened from a tool it may not call', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [
        pluginEntry('a', () => ({
          panels: [{ ...mcpApp('one', 'ui://a/one/v1'), opensFromTool: 'bureau.tasks.cancel' }],
        })),
      ],
    });
    expect(records[0]?.status).toBe('skipped');
  });

  it('skips a plugin whose app has no ui:// URI, or whose URI another plugin holds', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [
        pluginEntry('a', () => ({ panels: [mcpApp('one', 'https://example.test/one')] })),
        pluginEntry('b', () => ({ panels: [mcpApp('one', 'ui://shared/v1', 'tool.b')] })),
        pluginEntry('c', () => ({ panels: [mcpApp('two', 'ui://shared/v1', 'tool.c')] })),
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
        pluginEntry('a', () => ({ panels: [mcpApp('one', 'ui://a/one/v1')] })),
        pluginEntry('b', () => ({ panels: [mcpApp('two', 'ui://b/two/v1')] })),
      ],
    });
    expect(records.map(({ status }) => status)).toEqual(['running', 'skipped']);
    expect(records[1]?.problems).toEqual([
      expect.objectContaining({ code: 'name-clash', name: 'bureau.tasks.inspect' }),
    ]);
    const { plugins } = createPluginRegistry(records);
    expect(plugins.panels().map(({ plugin }) => plugin)).toEqual(['a']);
  });

  it('records a build failure the host reports against the plugin and stops listing the app', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [
        pluginEntry('a', () => ({
          panels: [
            mcpApp('one', 'ui://a/one/v1'),
            mcpApp('two', 'ui://a/two/v1', 'bureau.tasks.events'),
          ],
        })),
      ],
    });
    const registry = createPluginRegistry(records);
    registry.plugins.reportPanelFailure('a', 'one', 'The entry does not build.');
    registry.plugins.reportPanelFailure('absent', 'one', 'No such plugin.');
    expect(registry.plugins.panels().map(({ app }) => app.name)).toEqual(['two']);
    const [listing] = await registry.plugins.list();
    expect(listing?.status).toBe('running');
    expect(listing?.problems).toEqual([
      { code: 'panel-failed', app: 'one', message: 'The entry does not build.' },
    ]);
  });
});
