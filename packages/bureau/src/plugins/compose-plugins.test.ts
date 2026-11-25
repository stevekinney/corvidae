/**
 * COR-1879 — what a running plugin contributes reaches the option it belongs to.
 */
import {
  definePlugin,
  type PluginPanel,
  type PluginPanelPlacement,
  type PluginSetupContext,
  type PluginSetupResult,
} from '@lostgradient/interborough-plugin';
import { createAgent, guardrailOf } from '@lostgradient/operative';
import { createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { isPublishedEventKind } from '../bureau-event-catalog';
import { createVersionedCatalog } from '../versioned-catalog';
import {
  type ComposableOptions,
  composePlugins,
  HOST_HELD_KINDS,
  REDACTED_SECRET,
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
  score: () => ({ outcome: 'pass' as const, score: 1, message: '' }),
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
  workflow: {
    host: {
      contributionCatalog: (() => {
        const catalog = createVersionedCatalog();
        catalog.register({
          kind: 'workflow',
          name: 'p:x',
          version: '1',
          value: {},
          source: { name: 'host', version: '1' },
        });
        return catalog;
      })(),
    },
    contribution: {
      workflows: [
        {
          name: 'x',
          title: 'X',
          inputSchema: z.object({}),
          handler: async function* () {
            return 'x';
          },
        },
      ],
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
          {
            name: 'judge',
            version: '1',
            score: () => ({ outcome: 'pass' as const, score: 1, message: '' }),
          },
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

  it('registers a scorer under its namespaced name and hands its score the run, the signal and the run id (COR-2199, COR-2204)', async () => {
    const received: { run: unknown; signal: AbortSignal; context: unknown; self: unknown }[] = [];
    const scorer = {
      name: 'judge',
      version: '1',
      determinism: 'stochastic' as const,
      score(run: unknown, signal: AbortSignal, context: unknown) {
        received.push({ run, signal, context, self: this });
        return { outcome: 'pass' as const, message: 'ok' };
      },
    };
    const given: ComposableOptions = {
      plugins: [pluginEntry('kit', () => ({ scorers: [scorer] }))],
      scorers: { list: [], sampleRate: 1 },
    };
    const { options } = await composePlugins(given);
    const composed = options.scorers?.list[0];
    expect(composed?.name).toBe('kit:judge');
    expect(composed?.determinism).toBe('stochastic');

    const run = { content: 'a run' } as never;
    const signal = new AbortController().signal;
    const context = { runId: 'run-1' };
    await composed?.score(run, signal, context);
    expect(received).toHaveLength(1);
    expect(received[0]?.run).toBe(run);
    expect(received[0]?.signal).toBe(signal);
    expect(received[0]?.context).toBe(context);
    expect(received[0]?.self).toBe(scorer);
  });

  it('registers a scorer in the contribution catalog under the plugin that gave it (COR-2200)', async () => {
    const scorer = {
      name: 'judge',
      version: '2',
      sampleRate: 0.25,
      score: () => ({ outcome: 'pass' as const, message: '' }),
    };
    const bad = { name: 'odd', version: '1@x', score: scorer.score };
    const given: ComposableOptions = {
      plugins: [pluginEntry('kit', () => ({ scorers: [scorer, bad] }))],
      scorers: { list: [], sampleRate: 1 },
    };
    const { options } = await composePlugins(given);

    const found = options.contributionCatalog?.resolve('scorer', {
      name: 'kit:judge',
      version: '2',
    });
    expect(found?.ok).toBe(true);
    expect(found?.ok === true ? found.entry.source : undefined).toEqual({
      name: 'kit',
      version: '1.0.0',
    });
    // An identity the catalog refuses is left out; the scorer still runs.
    expect(options.contributionCatalog?.entries('scorer').map(({ name }) => name)).toEqual([
      'kit:judge',
    ]);
    expect(options.scorers?.list.map(({ name }) => name)).toEqual(['kit:judge', 'kit:odd']);
    // A scorer's own rate (COR-2203) reaches the sampler with the scorer.
    expect(options.scorers?.list[0]?.sampleRate).toBe(0.25);
  });

  it('lists only the contributions whose option the host gave', async () => {
    const contributing = () =>
      pluginEntry('kit', () => ({
        reactions: [actionKind('page')],
        scorers: [judge('judge')],
        embedders: [
          {
            name: 'small',
            model: 'small-model',
            dimensions: 4,
            embed: async (texts) => texts.map(() => []),
          },
        ],
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

  describe('a reaction’s timeoutMilliseconds (COR-2175)', () => {
    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
      'skips only the plugin whose reaction sets %p, naming the reaction and the value, and loads the others',
      async (timeoutMilliseconds) => {
        const { records, options } = await composePlugins<ComposableOptions>({
          plugins: [
            pluginEntry('broken', () => ({
              reactions: [{ ...actionKind('page'), timeoutMilliseconds }],
            })),
            pluginEntry('fine', () => ({
              reactions: [{ ...actionKind('ping'), timeoutMilliseconds: 5_000 }],
            })),
          ],
          hooks: {},
        });

        expect(records.map((record) => record.status)).toEqual(['skipped', 'running']);
        expect(records[0]?.problems).toEqual([
          expect.objectContaining({
            code: 'setup-failed',
            message: expect.stringContaining(`"page"`),
          }),
        ]);
        const [problem] = records[0]?.problems ?? [];
        expect(problem?.code === 'setup-failed' ? problem.message : '').toContain(
          String(timeoutMilliseconds),
        );
        const registered = options.hooks?.actionKinds?.map(
          (registration) => `${registration.plugin}/${registration.kind.name}`,
        );
        expect(registered).toEqual(['fine/ping']);
      },
    );
  });

  describe('a reaction’s maxAttempts and dryRun (COR-2183, reactions-2 matrix line 75)', () => {
    it.each([0, 21, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5' as unknown as number])(
      'skips only the plugin whose reaction sets maxAttempts %p, naming the reaction and the value, and loads the others',
      async (maxAttempts) => {
        const { records, options } = await composePlugins<ComposableOptions>({
          plugins: [
            pluginEntry('broken', () => ({
              reactions: [{ ...actionKind('page'), maxAttempts }],
            })),
            pluginEntry('fine', () => ({
              reactions: [{ ...actionKind('ping'), maxAttempts: 5 }],
            })),
          ],
          hooks: {},
        });

        expect(records.map((record) => record.status)).toEqual(['skipped', 'running']);
        const [problem] = records[0]?.problems ?? [];
        expect(problem?.code).toBe('setup-failed');
        const message = problem?.code === 'setup-failed' ? problem.message : '';
        expect(message).toContain(`"page"`);
        expect(message).toContain(String(maxAttempts));
        const registered = options.hooks?.actionKinds?.map(
          (registration) => `${registration.plugin}/${registration.kind.name}`,
        );
        expect(registered).toEqual(['fine/ping']);
      },
    );

    it.each([1, 8, 20])('loads a reaction whose maxAttempts is %p', async (maxAttempts) => {
      const { records, options } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('fine', () => ({ reactions: [{ ...actionKind('ping'), maxAttempts }] })),
        ],
        hooks: {},
      });
      expect(records.map((record) => record.status)).toEqual(['running']);
      expect(options.hooks?.actionKinds?.[0]?.kind.maxAttempts).toBe(maxAttempts);
    });

    it('hands the host a reaction’s dryRun and its maxAttempts unchanged, and lists whether it has a dryRun', async () => {
      const dryRun = async () => undefined;
      const { options } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('fine', () => ({
            reactions: [{ ...actionKind('ping'), maxAttempts: 4, dryRun }, actionKind('pong')],
          })),
        ],
        hooks: {},
      });
      const [ping, pong] = options.hooks?.actionKinds ?? [];
      expect(ping?.kind.dryRun).toBeDefined();
      expect(ping?.kind.maxAttempts).toBe(4);
      expect(pong?.kind.dryRun).toBeUndefined();
      expect(pong?.kind.maxAttempts).toBeUndefined();
    });
  });

  describe('guardrail families', () => {
    const detect = async () => ({}) as never;
    const validate = async () => ({ valid: true, confidence: 0, category: 'x' });

    it('claims a guardrail name per family, so one name serves input, output and memory', async () => {
      const handed: Parameters<Extract<ComposableOptions['memory'], Function>>[0][] = [];
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
        memory: (contributions) => {
          handed.push(contributions);
          return undefined as never;
        },
      });

      // The input family's `scan` and the memory family's `scan` coexist, and the ledger sees the
      // memory one as `kit:memory/scan` (COR-2190).
      expect(handed).toHaveLength(1);
      expect(handed[0]?.guardrails.admission.map(({ name }) => name)).toEqual(['kit:memory/scan']);
      expect(handed[0]?.guardrails.recall.map(({ name }) => name)).toEqual(['kit:memory/scan']);

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

    it('hands each memory gate its plugin-qualified guardrail names, and keeps a detector callable (COR-2190)', async () => {
      const calls: string[] = [];
      class Prototyped {
        readonly name: string;
        constructor(name: string) {
          this.name = name;
        }
        async detect(input: string) {
          calls.push(`${this.name}:${input}`);
          return {} as never;
        }
      }
      const handed: Parameters<Extract<ComposableOptions['memory'], Function>>[0][] = [];
      await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('acme', () => ({
            guardrails: {
              memory: [
                Object.assign(new Prototyped('pii'), { description: 'A test guardrail.' }),
                // A plugin may name its own guardrail like the built-in one; it stays a plugin's.
                {
                  name: 'memory-poisoning',
                  description: 'A test guardrail.',
                  detect,
                  gates: ['recall' as const],
                },
              ],
            },
          })),
          pluginEntry('other', () => ({
            guardrails: {
              memory: [
                { name: 'pii', description: 'A test guardrail.', detect, gates: ['admission'] },
              ],
            },
          })),
        ],
        memory: (contributions) => {
          handed.push(contributions);
          return undefined as never;
        },
      });

      const { admission, recall } = handed[0]?.guardrails ?? { admission: [], recall: [] };
      expect(admission.map(({ name }) => name)).toEqual(['acme:memory/pii', 'other:memory/pii']);
      expect(recall.map(({ name }) => name)).toEqual([
        'acme:memory/pii',
        'acme:memory/memory-poisoning',
      ]);
      // One wrapper serves both gates, and it still reaches the prototype's `detect`.
      expect(admission[0]).toBe(recall[0]);
      // One source per detector, in load order, with the plugin's version and canonical gates (COR-2192).
      expect(handed[0]?.guardrails.sources).toEqual([
        { id: 'acme:memory/pii', plugin: 'acme', version: '1.0.0', gates: ['admission', 'recall'] },
        {
          id: 'acme:memory/memory-poisoning',
          plugin: 'acme',
          version: '1.0.0',
          gates: ['recall'],
        },
        { id: 'other:memory/pii', plugin: 'other', version: '1.0.0', gates: ['admission'] },
      ]);
      const context = { step: 0, conversationLength: 0, sessionTainted: false, provenance: 'x' };
      await admission[0]?.detect('text', context as never);
      expect(calls).toEqual(['pii:text']);
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

  it('skips a plugin whose formatter lists one event kind twice, with name-clash (COR-2221)', async () => {
    const { records, options } = await composePlugins<ComposableOptions>({
      plugins: [
        pluginEntry('kit', () => ({
          formatters: [
            {
              name: 'settled',
              eventKinds: ['run.settled', 'run.settled'],
              format: () => ({ title: 'settled' }),
            },
          ],
        })),
      ],
    });

    expect(records[0]?.status).toBe('skipped');
    expect(records[0]?.problems).toEqual([
      expect.objectContaining({ code: 'name-clash', name: 'run.settled' }),
    ]);
    expect(options.formatters ?? []).toEqual([]);
  });

  describe('events a plugin declares (COR-2223)', () => {
    const greeted = (name = 'greeted') => ({
      name,
      description: 'Someone was greeted.',
      payload: z.object({
        greetingId: z.string().meta({ identifier: true }),
        status: z.enum(['sent', 'failed']),
        count: z.number().optional(),
      }),
    });

    it('composes, and lists each kind as plugin:name with its payload fields', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [pluginEntry('kit', () => ({ events: [greeted(), greeted('left')] }))],
      });

      expect(records[0]?.status).toBe('running');
      expect(records[0]?.problems).toEqual([]);
      expect(createPluginRegistry(records).plugins.events()).toEqual([
        {
          plugin: 'kit',
          kind: 'kit:greeted',
          description: 'Someone was greeted.',
          version: '1.0.0',
          payload: [
            { name: 'greetingId', type: 'string', optional: false },
            { name: 'status', type: 'string', optional: false },
            { name: 'count', type: 'number', optional: true },
          ],
        },
        expect.objectContaining({ kind: 'kit:left' }),
      ]);
    });

    it('lists the plugin’s version for a declaration with none, and its own otherwise', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('kit', () => ({
            events: [greeted('plain'), { ...greeted('pinned'), version: '3.1.0' }],
          })),
        ],
      });

      expect(
        createPluginRegistry(records)
          .plugins.events()
          .map(({ kind, version }) => [kind, version]),
      ).toEqual([
        ['kit:plain', '1.0.0'],
        ['kit:pinned', '3.1.0'],
      ]);
    });

    it('keeps the events of a plugin that declares a secret, whose contributions the gate wraps', async () => {
      const descriptor = definePlugin({
        name: 'kit',
        version: '1.0.0',
        description: 'kit',
        secrets: ['api-key'],
        setup: () => ({ events: [greeted()] }),
      });
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [{ descriptor, source: 'package', location: '@example/kit' }],
        pluginSecrets: { get: async () => 'set', watch: () => () => undefined },
      });

      expect(records[0]?.status).toBe('running');
      expect(
        createPluginRegistry(records)
          .plugins.events()
          .map(({ kind }) => kind),
      ).toEqual(['kit:greeted']);
    });

    it('lists no event for a plugin that is skipped or disabled', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('kit', () => ({ events: [greeted()] })),
          pluginEntry('off', () => ({ events: [greeted()] })),
        ],
        pluginConfiguration: { off: { enabled: false } },
      });

      expect(records.map(({ status }) => status)).toEqual(['running', 'disabled']);
      expect(
        createPluginRegistry(records)
          .plugins.events()
          .map(({ plugin }) => plugin),
      ).toEqual(['kit']);
    });

    it('skips a plugin that declares one name twice, with name-clash', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [pluginEntry('kit', () => ({ events: [greeted(), greeted()] }))],
      });

      expect(records[0]?.status).toBe('skipped');
      expect(records[0]?.problems).toEqual([
        expect.objectContaining({ code: 'name-clash', name: 'kit:greeted' }),
      ]);
      expect(createPluginRegistry(records).plugins.events()).toEqual([]);
    });

    const formatting = (kinds: string[], name = 'fmt') => ({
      formatters: [{ name, eventKinds: kinds, format: () => ({ title: 'x' }) }],
    });

    it('composes a formatter that lists a kind its plugin declares (COR-2225)', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('kit', () => ({ events: [greeted()], ...formatting(['kit:greeted']) })),
        ],
      });

      expect(records[0]?.status).toBe('running');
      expect(records[0]?.problems).toEqual([]);
      expect(isPublishedEventKind('kit:greeted', ['kit:greeted'])).toBe(true);
    });

    it("skips a formatter that lists another plugin's declared kind, naming the owner", async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('kit', () => ({ events: [greeted()] })),
          pluginEntry('other', () => formatting(['kit:greeted'])),
        ],
      });

      expect(records[0]?.status).toBe('running');
      expect(records[1]?.status).toBe('skipped');
      expect(records[1]?.problems).toEqual([
        { code: 'formatter-foreign-kind', formatter: 'fmt', kind: 'kit:greeted', owner: 'kit' },
      ]);
    });

    it('names the owner whichever of the two plugins loads first', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('other', () => formatting(['kit:greeted'])),
          pluginEntry('kit', () => ({ events: [greeted()] })),
        ],
      });

      expect(records[0]?.status).toBe('skipped');
      expect(records[0]?.problems).toEqual([
        { code: 'formatter-foreign-kind', formatter: 'fmt', kind: 'kit:greeted', owner: 'kit' },
      ]);
      expect(records[1]?.status).toBe('running');
    });

    it('skips a formatter that lists an undeclared plugin kind, with formatter-unknown-kind', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('kit', () => ({ events: [greeted()], ...formatting(['kit:missing']) })),
        ],
      });

      expect(records[0]?.status).toBe('skipped');
      expect(records[0]?.problems).toEqual([
        { code: 'formatter-unknown-kind', formatter: 'fmt', kind: 'kit:missing' },
      ]);
    });

    it('skips a plugin that declares a kind another holds, with name-clash', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [pluginEntry('kit', () => ({ events: [greeted()] }))],
        // A host formatter that already claims the kind holds it.
        formatters: [
          {
            plugin: 'host',
            formatter: {
              name: 'greetings',
              eventKinds: ['kit:greeted'],
              format: () => ({ title: 'x' }),
            },
          },
        ],
      });

      expect(records[0]?.status).toBe('skipped');
      expect(records[0]?.problems).toEqual([
        expect.objectContaining({
          code: 'name-clash',
          name: 'kit:greeted',
          first: { source: 'built-in', location: 'host' },
        }),
      ]);
    });

    it('refuses a free string field with event-payload-content, and runs no other plugin less', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('kit', () => ({
            events: [
              {
                name: 'noted',
                description: 'A note.',
                payload: z.object({ id: z.string().meta({ identifier: true }), note: z.string() }),
              },
            ],
          })),
          pluginEntry('fine', () => ({ events: [greeted()] })),
        ],
      });

      expect(records.map(({ status }) => status)).toEqual(['skipped', 'running']);
      expect(records[0]?.problems).toEqual([
        { code: 'event-payload-content', event: 'noted', field: 'note' },
      ]);
    });

    it('never rejects the host for a payload that recurses or cannot be read', async () => {
      const Node = z.object({
        id: z.string().meta({ identifier: true }),
        get children() {
          return z.array(Node).optional();
        },
      });
      const unreadable = z.object({
        get id(): z.ZodString {
          throw new Error('cannot read');
        },
      });
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('tree', () => ({
            events: [{ name: 'tree', description: 'A tree.', payload: z.object({ root: Node }) }],
          })),
          pluginEntry('broken', () => ({
            events: [{ name: 'broken', description: 'Unreadable.', payload: unreadable }],
          })),
          pluginEntry('fine', () => ({ events: [greeted()] })),
        ],
      });

      expect(records.map(({ status }) => status)).toEqual(['running', 'skipped', 'running']);
      expect(records[1]?.problems).toEqual([
        expect.objectContaining({
          code: 'setup-failed',
          message: expect.stringContaining('cannot read'),
        }),
      ]);
    });

    it('skips a plugin whose payload fans out without end, with event-payload-content, and the host starts', async () => {
      const fresh = (): z.ZodObject =>
        z.object({
          get l() {
            return fresh().optional();
          },
          get r() {
            return fresh().optional();
          },
        });
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('endless', () => ({
            events: [{ name: 'endless', description: 'Never ends.', payload: fresh() }],
          })),
          pluginEntry('fine', () => ({ events: [greeted()] })),
        ],
      });

      expect(records.map(({ status }) => status)).toEqual(['skipped', 'running']);
      expect(records[0]?.problems).toEqual([
        expect.objectContaining({
          code: 'event-payload-content',
          event: 'endless',
          message: expect.stringContaining('ran out of budget'),
        }),
      ]);
    });

    it('redacts a secret the plugin was handed from the budget refusal message', async () => {
      const fresh = (): z.ZodObject =>
        z.object({
          get l() {
            return fresh().optional();
          },
          get r() {
            return fresh().optional();
          },
        });
      const descriptor = definePlugin({
        name: 'endless',
        version: '1.0.0',
        description: 'endless',
        secrets: ['api-key'],
        setup: async ({ secrets }) => {
          await secrets.get('api-key');
          return { events: [{ name: 'endless', description: 'Never ends.', payload: fresh() }] };
        },
      });
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [{ descriptor, source: 'package', location: '@example/endless' }],
        // The secret is a word of the host's own message, so the message changes only if it is redacted.
        pluginSecrets: { get: async () => 'budget', watch: () => () => undefined },
      });

      expect(records[0]?.status).toBe('skipped');
      const [problem] = records[0]?.problems ?? [];
      expect(problem).toMatchObject({ code: 'event-payload-content', event: 'endless' });
      expect(JSON.stringify(problem)).not.toContain('budget');
      expect(JSON.stringify(problem)).toContain(REDACTED_SECRET);
    });

    it('accepts a z.enum status and a marked identifier, which a plugin’s payload may hold', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [pluginEntry('kit', () => ({ events: [greeted()] }))],
      });

      expect(records[0]?.status).toBe('running');
      expect(records[0]?.problems).toEqual([]);
    });

    it('skips a plugin whose declaration is malformed, with setup-failed', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('badname', () => ({ events: [{ ...greeted(), name: 'Not A Name' }] })),
          pluginEntry('badpayload', () => ({
            events: [{ ...greeted(), payload: z.string() as never }],
          })),
          pluginEntry('nodescription', () => ({
            events: [{ ...greeted(), description: undefined as never }],
          })),
          pluginEntry('badversion', () => ({
            events: [{ ...greeted(), version: 3 as never }],
          })),
        ],
      });

      expect(records.map(({ status, problems }) => [status, problems[0]?.code])).toEqual([
        ['skipped', 'setup-failed'],
        ['skipped', 'setup-failed'],
        ['skipped', 'setup-failed'],
        ['skipped', 'setup-failed'],
      ]);
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
          embedders: [{ name: 'zero', model: 'zero-model', dimensions: 0, embed: async () => [] }],
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

  it('skips a plugin whose embedder names a blank model, and composes the others (COR-2184)', async () => {
    const embed = async () => [];
    const { records } = await composePlugins({
      plugins: [
        pluginEntry('blank', () => ({
          embedders: [{ name: 'embed', model: '  ', dimensions: 4, embed }],
        })),
        pluginEntry('missing', () => ({
          embedders: [{ name: 'embed', dimensions: 4, embed } as never],
        })),
        pluginEntry('named', () => ({
          embedders: [{ name: 'embed', model: 'named-model', dimensions: 4, embed }],
        })),
      ],
    });
    expect(records.map(({ status, problems }) => [status, problems[0]?.code])).toEqual([
      ['skipped', 'setup-failed'],
      ['skipped', 'setup-failed'],
      ['running', undefined],
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

  describe('placements (COR-2212)', () => {
    /** A panel that declares only where it appears: it names no `opensFromTool`. */
    const placed = (
      name: string,
      uri: string,
      placements: readonly PluginPanelPlacement[],
      extras: Partial<PluginPanel> = {},
    ): PluginPanel => ({
      name,
      title: name,
      uri,
      entry: new URL(`file:///${name}/app.ts`),
      allowedTools: ['bureau.tasks.inspect'],
      placements,
      ...extras,
    });

    it('composes a panel with only a page placement and no opener, and links it to no tool', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('a', () => ({
            panels: [
              placed('one', 'ui://a/one/v1', [
                { kind: 'page', path: 'reviews/queue', sidebar: { group: 'work', icon: 'inbox' } },
              ]),
            ],
          })),
          // A second plugin's page panel also names no tool, so nothing claims a tool twice.
          pluginEntry('b', () => ({
            panels: [placed('two', 'ui://b/two/v1', [{ kind: 'page', path: 'b' }])],
          })),
        ],
      });
      expect(records.map(({ status }) => status)).toEqual(['running', 'running']);
      const { plugins } = createPluginRegistry(records);
      expect(plugins.panels().map(({ app }) => [app.name, app.opensFromTool])).toEqual([
        ['one', undefined],
        ['two', undefined],
      ]);
      expect(plugins.panels()[0]?.app.placements).toEqual([
        { kind: 'page', path: 'reviews/queue', sidebar: { group: 'work', icon: 'inbox' } },
      ]);
    });

    it('composes two plugins’ panels that both have a run placement, with no name-clash', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('a', () => ({
            panels: [placed('one', 'ui://a/one/v1', [{ kind: 'run' }])],
          })),
          pluginEntry('b', () => ({
            panels: [placed('two', 'ui://b/two/v1', [{ kind: 'run' }])],
          })),
        ],
      });
      expect(records.map(({ status }) => status)).toEqual(['running', 'running']);
      expect(records.flatMap(({ problems }) => problems ?? [])).toEqual([]);
    });

    it('still claims the opener of a panel that names one', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('a', () => ({
            panels: [
              placed('one', 'ui://a/one/v1', [{ kind: 'run' }], {
                opensFromTool: 'bureau.tasks.inspect',
              }),
            ],
          })),
          pluginEntry('b', () => ({
            panels: [
              placed('two', 'ui://b/two/v1', [{ kind: 'run' }], {
                opensFromTool: 'bureau.tasks.inspect',
              }),
            ],
          })),
        ],
      });
      expect(records.map(({ status }) => status)).toEqual(['running', 'skipped']);
      expect(records[1]?.problems).toEqual([
        expect.objectContaining({ code: 'name-clash', name: 'bureau.tasks.inspect' }),
      ]);
    });

    it.each([
      ['the group home', { kind: 'page', path: 'reviews', sidebar: { group: 'home' } }],
      ['a group that is not a string', { kind: 'page', path: 'reviews', sidebar: {} }],
      ['an uppercase path', { kind: 'page', path: 'Reviews' }],
      ['a path with a leading slash', { kind: 'page', path: '/reviews' }],
      ['a path with a trailing slash', { kind: 'page', path: 'reviews/' }],
      ['an empty segment', { kind: 'page', path: 'reviews//queue' }],
      ['a segment starting with a digit', { kind: 'page', path: 'reviews/1st' }],
      ['an empty path', { kind: 'page', path: '' }],
      ['no path', { kind: 'page' }],
      ['a path with a dot segment', { kind: 'page', path: 'reviews/../queue' }],
      ['a null sidebar', { kind: 'page', path: 'reviews', sidebar: null }],
      ['a null entry', null],
      ['a string entry', 'page'],
      ['a number entry', 7],
      ['an array entry', [{ kind: 'run' }]],
      ['a chat tool with no agent tool', { kind: 'chat-tool' }],
      ['a chat tool with an empty agent tool', { kind: 'chat-tool', agentTool: '' }],
      ['a kind this host does not know', { kind: 'dock' }],
      ['no kind', {}],
      ['a run condition that is not failed', { kind: 'run', when: 'running' }],
      ['a run condition that is not text', { kind: 'run', when: true }],
    ] as const)('fails setup for a placement with %s', async (_name, placement) => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('a', () => ({
            panels: [placed('one', 'ui://a/one/v1', [placement] as never)],
          })),
        ],
      });
      expect(records[0]?.status).toBe('skipped');
      expect(records[0]?.problems).toEqual([
        expect.objectContaining({
          code: 'setup-failed',
          message: expect.stringMatching(/^setup returned the panel "one" with a .*placement/),
        }),
      ]);
    });

    it('refuses a chat-tool placement for an agent tool the Bureau does not hold, but not a workflow tool', async () => {
      const agentSource = { tools: { 'plugin:known': {} } } as never;
      const { records } = await composePlugins<ComposableOptions>({
        agentSource,
        plugins: [
          pluginEntry('a', () => ({
            panels: [
              placed('one', 'ui://a/one/v1', [{ kind: 'chat-tool', agentTool: 'plugin:known' }]),
            ],
          })),
          pluginEntry('b', () => ({
            panels: [
              placed('two', 'ui://b/two/v1', [
                { kind: 'chat-tool', agentTool: 'bureau:workflows-propose-update' },
              ]),
            ],
          })),
          pluginEntry('c', () => ({
            panels: [
              placed('three', 'ui://c/three/v1', [{ kind: 'chat-tool', agentTool: 'nobody:home' }]),
            ],
          })),
        ],
      });
      expect(records.map(({ status }) => status)).toEqual(['running', 'running', 'skipped']);
      expect(records[2]?.problems).toEqual([
        expect.objectContaining({
          code: 'setup-failed',
          message: 'setup returned the panel "three" opened from unknown agent tool "nobody:home".',
        }),
      ]);
    });

    it('accepts the failure explanation tool as a chat-tool target on every Bureau (COR-2543)', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        agentSource: { tools: {} } as never,
        plugins: [
          pluginEntry('a', () => ({
            panels: [
              placed('one', 'ui://a/one/v1', [
                { kind: 'chat-tool', agentTool: 'bureau:tasks-explain' },
                { kind: 'run', when: 'failed' },
              ]),
            ],
          })),
        ],
      });
      expect(records[0]?.status).toBe('running');
    });

    it('checks no agent tool when the Bureau is given none', async () => {
      const { records } = await composePlugins<ComposableOptions>({
        plugins: [
          pluginEntry('a', () => ({
            panels: [
              placed('one', 'ui://a/one/v1', [{ kind: 'chat-tool', agentTool: 'nobody:home' }]),
            ],
          })),
        ],
      });
      expect(records[0]?.status).toBe('running');
    });
  });

  it('skips a plugin whose host-only tool is not an operation open to host panels', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [
        pluginEntry('a', () => ({
          panels: [{ ...mcpApp('one', 'ui://a/one/v1'), hostOnlyTools: ['bureau.tasks.inspect'] }],
        })),
        pluginEntry('b', () => ({
          panels: [
            {
              ...mcpApp('two', 'ui://b/two/v1', 'bureau.tasks.events'),
              allowedTools: ['bureau.tasks.events', 'bureau.workflows.update'],
              hostOnlyTools: ['bureau.workflows.update'],
            },
          ],
        })),
      ],
    });
    expect(records.map(({ status }) => status)).toEqual(['skipped', 'running']);
    expect(records[0]?.problems).toEqual([
      expect.objectContaining({
        code: 'setup-failed',
        message: expect.stringContaining('not an operation open to host panels'),
      }),
    ]);
  });

  it('lists a panel as a contribution with its title, so the host can name it (COR-2213)', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [
        pluginEntry('titled', () => ({
          panels: [
            { ...mcpApp('review-queue', 'ui://titled/review-queue/v1'), title: 'Review queue' },
          ],
        })),
      ],
    });
    expect(records[0]?.contributions).toEqual([
      { kind: 'panel', id: 'titled:review-queue', title: 'Review queue' },
    ]);
  });

  it('skips a plugin whose panel allows a tool without the bureau. prefix, naming the tool', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [
        pluginEntry('a', () => ({
          panels: [
            {
              ...mcpApp('one', 'ui://a/one/v1', 'bureau.tasks.inspect'),
              allowedTools: ['bureau.tasks.inspect', 'tool.elsewhere'],
            },
          ],
        })),
        pluginEntry('b', () => ({
          panels: [mcpApp('two', 'ui://b/two/v1', 'bureau.tasks.events')],
        })),
      ],
    });
    expect(records.map(({ status }) => status)).toEqual(['skipped', 'running']);
    expect(records[0]?.problems).toEqual([
      expect.objectContaining({
        code: 'setup-failed',
        message: expect.stringContaining(
          'setup returned the panel "one" with the tool "tool.elsewhere" in allowedTools, which is not a Bureau tool: every allowedTools entry begins bureau.',
        ),
      }),
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

  it('skips a plugin whose app has no ui:// URI, or that serves one URI twice', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [
        pluginEntry('a', () => ({ panels: [mcpApp('one', 'https://example.test/one')] })),
        pluginEntry('b', () => ({ panels: [mcpApp('one', 'ui://b/shared/v1', 'bureau.test.b')] })),
        pluginEntry('c', () => ({
          panels: [
            mcpApp('one', 'ui://c/shared/v1', 'bureau.test.c1'),
            mcpApp('two', 'ui://c/shared/v1', 'bureau.test.c2'),
          ],
        })),
      ],
    });
    expect(records.map(({ status }) => status)).toEqual(['skipped', 'running', 'skipped']);
    expect(records[0]?.problems).toEqual([expect.objectContaining({ code: 'setup-failed' })]);
    expect(records[2]?.problems).toEqual([
      expect.objectContaining({ code: 'name-clash', name: 'ui://c/shared/v1' }),
    ]);
  });

  it('skips a plugin whose app serves a URI outside ui://<plugin>/ (COR-2210)', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [
        // Another plugin's namespace, a prefix that is not a path segment, and no path at all.
        pluginEntry('a', () => ({ panels: [mcpApp('one', 'ui://bureau/one/v1')] })),
        pluginEntry('ab', () => ({
          panels: [mcpApp('one', 'ui://abc/one/v1', 'bureau.test.ab')],
        })),
        pluginEntry('abc', () => ({ panels: [mcpApp('one', 'ui://abc', 'bureau.test.abc')] })),
        pluginEntry('fine', () => ({
          panels: [mcpApp('one', 'ui://fine/one/v1', 'bureau.test.fine')],
        })),
      ],
    });
    expect(records.map(({ status }) => status)).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'running',
    ]);
    for (const record of records.slice(0, 3)) {
      expect(record.problems).toEqual([
        expect.objectContaining({
          code: 'setup-failed',
          message: expect.stringContaining("outside the plugin's namespace"),
        }),
      ]);
    }
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

  it('lists a panel-changed problem with both digests and keeps serving the app (COR-2210)', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [pluginEntry('a', () => ({ panels: [mcpApp('one', 'ui://a/one/v1')] }))],
    });
    const registry = createPluginRegistry(records);
    registry.plugins.reportPanelChange('a', 'one', 'ui://a/one/v1', 'sha256:old', 'sha256:new');
    // An absent plugin or app, and a repeat, are ignored.
    registry.plugins.reportPanelChange('absent', 'one', 'ui://a/one/v1', 'sha256:x', 'sha256:y');
    registry.plugins.reportPanelChange('a', 'absent', 'ui://a/one/v1', 'sha256:x', 'sha256:y');
    registry.plugins.reportPanelChange('a', 'one', 'ui://a/one/v1', 'sha256:old', 'sha256:other');
    expect(registry.plugins.panels().map(({ app }) => app.name)).toEqual(['one']);
    const [listing] = await registry.plugins.list();
    expect(listing?.status).toBe('running');
    expect(listing?.problems).toEqual([
      {
        code: 'panel-changed',
        app: 'one',
        uri: 'ui://a/one/v1',
        previousDigest: 'sha256:old',
        contentDigest: 'sha256:new',
      },
    ]);
  });
});

describe('the hooks a descriptor declares (COR-2180)', () => {
  const greeted = {
    name: 'greeted',
    description: 'Someone was greeted.',
    payload: z.object({ greetingId: z.string().meta({ identifier: true }) }),
  };
  const hookedPlugin = (
    hooks: readonly unknown[],
    result: PluginSetupResult = {},
  ): BureauPluginEntry => {
    const descriptor = definePlugin({
      name: 'kit',
      version: '1.0.0',
      description: 'kit',
      hooks: hooks as never,
      setup: () => ({ reactions: [actionKind('page')], ...result }),
    });
    return { descriptor, source: 'package', location: '@example/kit' };
  };
  const valid = { name: 'Page on settle', events: ['run.settled'], reaction: 'page' };

  it('keeps the hooks that hold, copied, and leaves the plugin running with every contribution', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [
        hookedPlugin([{ ...valid, configuration: { a: 1 } }]),
        pluginEntry('other', () => ({})),
      ],
      hooks: {},
    });

    expect(records.map(({ status }) => status)).toEqual(['running', 'running']);
    expect(records[0]?.problems).toEqual([]);
    expect(records[0]?.hooks).toEqual([{ ...valid, configuration: { a: 1 } }]);
    expect(records[0]?.contributions.map(({ kind }) => kind)).toContain('reaction');
    expect(records[1]?.hooks).toBeUndefined();
  });

  it('skips a hook that names a reaction the plugin does not contribute, alone', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [hookedPlugin([{ ...valid, name: 'Lost', reaction: 'absent' }, valid])],
      hooks: {},
    });

    expect(records[0]?.status).toBe('running');
    expect(records[0]?.problems).toEqual([
      { code: 'hook-invalid', hook: 'Lost', path: 'reaction' },
    ]);
    expect(records[0]?.hooks?.map(({ name }) => name)).toEqual(['Page on settle']);
    expect(records[0]?.contributions.map(({ kind }) => kind)).toContain('reaction');
  });

  it('skips a hook with an event kind that is not published, alone, and accepts a kind a plugin declares', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [
        hookedPlugin(
          [
            { ...valid, name: 'Nothing', events: ['run.nonexistent'] },
            { ...valid, name: 'Foreign', events: ['other:greeted'] },
            { ...valid, name: 'Mixed', events: ['run.settled', 'kit:absent'] },
            { ...valid, name: 'Empty', events: [] },
            { ...valid, name: 'Own', events: ['kit:greeted'] },
            valid,
          ],
          { events: [greeted] },
        ),
      ],
      hooks: {},
    });

    expect(records[0]?.status).toBe('running');
    expect(records[0]?.problems).toEqual(
      ['Nothing', 'Foreign', 'Mixed', 'Empty'].map((hook) => ({
        code: 'hook-invalid',
        hook,
        path: 'events',
      })),
    );
    expect(records[0]?.hooks?.map(({ name }) => name)).toEqual(['Own', 'Page on settle']);
  });

  it.each([
    ['before', 'after'],
    ['after', 'before'],
  ])(
    'accepts a kind another running plugin declares when that plugin composes %s the hook’s (load order never refuses it)',
    async (declaringPosition) => {
      const hooked = hookedPlugin([{ ...valid, name: 'Greeted', events: ['greeter:greeted'] }]);
      const greeter = pluginEntry('greeter', () => ({ events: [greeted] }));
      const { records } = await composePlugins<ComposableOptions>({
        plugins: declaringPosition === 'before' ? [greeter, hooked] : [hooked, greeter],
        hooks: {},
      });

      const kit = records.find(({ entry }) => entry.descriptor.name === 'kit');
      expect(records.map(({ status }) => status)).toEqual(['running', 'running']);
      expect(kit?.problems).toEqual([]);
      expect(kit?.hooks?.map(({ name }) => name)).toEqual(['Greeted']);
    },
  );

  it('still refuses a kind only a plugin that is not running declares', async () => {
    const hooked = hookedPlugin([{ ...valid, name: 'Greeted', events: ['greeter:greeted'] }]);
    const greeter = pluginEntry('greeter', () => {
      throw new Error('setup failed');
    });
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [hooked, greeter],
      hooks: {},
    });

    const kit = records.find(({ entry }) => entry.descriptor.name === 'kit');
    expect(kit?.problems).toEqual([{ code: 'hook-invalid', hook: 'Greeted', path: 'events' }]);
    expect(kit?.hooks).toBeUndefined();
  });

  it('skips a repeated name alone and keeps the first', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [
        hookedPlugin([valid, { ...valid, events: ['run.started'] }, { ...valid, name: 'Second' }]),
      ],
      hooks: {},
    });

    expect(records[0]?.status).toBe('running');
    expect(records[0]?.problems).toEqual([
      { code: 'hook-invalid', hook: 'Page on settle', path: 'name' },
    ]);
    expect(records[0]?.hooks).toEqual([valid, { ...valid, name: 'Second' }]);
  });

  it('skips a hook that is no object or has no name, and cuts a long name to 100 characters', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [
        hookedPlugin([
          null,
          'text',
          { ...valid, name: '' },
          { ...valid, name: 'x'.repeat(300), reaction: 'absent' },
        ]),
      ],
      hooks: {},
    });

    expect(records[0]?.problems).toEqual([
      { code: 'hook-invalid', hook: '', path: 'name' },
      { code: 'hook-invalid', hook: '', path: 'name' },
      { code: 'hook-invalid', hook: '', path: 'name' },
      { code: 'hook-invalid', hook: 'x'.repeat(100), path: 'reaction' },
    ]);
    expect(records[0]?.hooks).toBeUndefined();
  });

  it('lists a hook that reconcile refused as the plugin’s hook-invalid problem, replacing the last report', async () => {
    const { records } = await composePlugins<ComposableOptions>({
      plugins: [hookedPlugin([valid])],
      hooks: {},
    });
    const registry = createPluginRegistry(records);
    registry.reportHookProblems('kit', [{ hook: 'Page on settle', path: 'configuration' }]);
    registry.reportHookProblems('absent', [{ hook: 'x', path: 'name' }]);
    const withProblem = await registry.plugins.list();
    expect(withProblem[0]?.problems).toEqual([
      { code: 'hook-invalid', hook: 'Page on settle', path: 'configuration' },
    ]);
    registry.reportHookProblems('kit', []);
    const cleared = await registry.plugins.list();
    expect(cleared[0]?.problems).toEqual([]);
    expect(registry.declaredHooks()).toEqual([{ plugin: 'kit', hooks: [valid] }]);
    expect([...registry.knownPlugins()]).toEqual(['kit']);
  });
});
