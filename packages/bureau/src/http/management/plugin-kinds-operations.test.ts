/**
 * COR-1893 — `bureau.plugins.contributions` and `bureau.events.format` over a real Bureau that loads a
 * plugin: the trigger kinds it contributes are listed with their configuration as JSON Schema, a
 * contributed formatter's sentence is served, and an event no formatter claims is served raw.
 */
import { definePlugin } from '@lostgradient/interborough-plugin';
import type { ProviderDefinition } from '@lostgradient/operative/provider-kit';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { composePlugins } from '../../plugins/compose-plugins.ts';
import { createPluginRegistry } from '../../plugins/plugin-registry.ts';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import { OPERATION_MAP } from '../operation-map.ts';
import { WORKSPACE_CONFORMANCE_GROUPS } from '../workspace-conformance.test-support.ts';
import { workspaceProjectionFields } from '../workspace-projection-schema.test-support.ts';
import { openBureau, type OpenedBureau, rpc } from './management-fixtures.test-support.ts';
import { eventsFormatOperation, pluginKindsOperation } from './plugin-kinds-operations.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const inbox = definePlugin({
  name: 'inbox',
  version: '2.0.0',
  description: 'Mail arrives.',
  configuration: z.object({ baseURL: z.string().url() }),
  setup: () => ({
    providers: [
      {
        name: 'openai-compatible',
        generate: () => async () => ({ content: 'ok', toolCalls: [] }),
      } satisfies ProviderDefinition<'openai-compatible'>,
    ],
    triggers: [
      {
        name: 'message',
        description: 'A message arrives in a mailbox.',
        configuration: z.object({
          mailbox: z.string().describe('The mailbox to watch.'),
          unreadOnly: z.boolean().optional(),
        }),
        start: async () => () => undefined,
      },
      {
        name: 'webhook',
        description: 'A delivery arrives.',
        configuration: z.object({}),
        receive: async () => new Response(null, { status: 202 }),
      },
    ],
    formatters: [
      {
        name: 'reviews',
        eventKinds: ['review.requested'],
        format: (event) => ({ title: `A review was asked for (${event.source ?? 'core'})` }),
      },
      {
        name: 'escalations',
        eventKinds: ['review.expired'],
        format: (event) => ({
          title: 'A review needs attention',
          tier: 'warning' as const,
          icon: 'bell-ring',
          link: (event.payload as { path: string }).path,
        }),
      },
    ],
  }),
});

async function open(): Promise<OpenedBureau> {
  const opened = await openBureau({
    bureauOptions: {
      plugins: [{ descriptor: inbox, source: 'package', location: '@example/inbox' }],
      pluginConfiguration: { inbox: { configuration: { baseURL: 'http://localhost:8080' } } },
    },
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

describe('bureau.plugins.contributions', () => {
  it('is served, described, read-only, and open to any authenticated caller', () => {
    expect(BUREAU_HANDLER_OPERATIONS).toContain(pluginKindsOperation);
    expect(pluginKindsOperation.destructive).toBe(false);
    expect(pluginKindsOperation.access).toEqual({ kind: 'authenticated' });
    expect(pluginKindsOperation.description?.length ?? 0).toBeGreaterThan(40);
  });

  it('lists a contributed trigger kind with its configuration as JSON Schema', async () => {
    const opened = await open();
    const body = await rpc(opened.handler, 'bureau.plugins.contributions', {}, 'alice-key');
    expect(body.error).toBeUndefined();
    const triggers = body.result!['triggers'] as Array<Record<string, unknown>>;
    expect(triggers).toHaveLength(2);
    expect(triggers[0]).toMatchObject({
      plugin: 'inbox',
      id: 'inbox:message',
      description: 'A message arrives in a mailbox.',
      version: '2.0.0',
      receives: false,
    });
    // COR-2171: a kind that defines `receive` says so, for the page that shows its address.
    expect(triggers[1]).toMatchObject({ id: 'inbox:webhook', receives: true });
    const configuration = triggers[0]!['configuration'] as {
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
    expect(configuration.properties['mailbox']).toMatchObject({
      type: 'string',
      description: 'The mailbox to watch.',
    });
    expect(configuration.required).toEqual(['mailbox']);
    expect(body.result!['reactions']).toEqual([]);
    expect(body.result!['providers']).toEqual([
      {
        plugin: 'inbox',
        name: 'openai-compatible',
        configuration: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: { baseURL: { type: 'string', format: 'uri' } },
          required: ['baseURL'],
        },
      },
    ]);
  });

  it('is the only name the operation answers to: no map, grant fixture or projection names the old one', () => {
    const retired = ['bureau', 'plugins', 'kinds'].join('.');
    expect(Object.keys(OPERATION_MAP)).toContain('bureau.plugins.contributions');
    expect(Object.keys(OPERATION_MAP)).not.toContain(retired);
    const conformanceOperations = WORKSPACE_CONFORMANCE_GROUPS.flatMap((group) =>
      group.operations.map(([operation]) => operation as string),
    );
    expect(conformanceOperations).toContain('bureau.plugins.contributions');
    expect(conformanceOperations).not.toContain(retired);
    const projected = Object.keys(workspaceProjectionFields());
    expect(projected).toContain('output:bureau.plugins.contributions');
    expect(projected.filter((key) => key.includes(retired))).toEqual([]);
    expect(pluginKindsOperation.name).toBe('bureau.plugins.contributions');
  });

  it('refuses a request with no credential', async () => {
    const opened = await open();
    const body = await rpc(opened.handler, 'bureau.plugins.contributions', {}, 'no-such-key');
    expect(body.error).toBeDefined();
  });
});

describe('plugin registry kinds', () => {
  it('lists a hook action kind only when the host composes hooks', async () => {
    const pager = definePlugin({
      name: 'pager',
      version: '1.0.0',
      description: 'Pages someone.',
      setup: () => ({
        reactions: [
          {
            name: 'page',
            version: '0.3.0',
            description: 'Pages the on-call person.',
            configuration: z.object({ team: z.string() }),
            run: async () => undefined,
          },
        ],
      }),
    });
    const entry = { descriptor: pager, source: 'package', location: '@example/pager' } as const;
    const bare = await composePlugins({ plugins: [entry] });
    expect(createPluginRegistry(bare.records).plugins.reactions()).toEqual([]);

    const given = await composePlugins({ plugins: [entry], hooks: {} });
    const [kind] = createPluginRegistry(given.records).plugins.reactions();
    expect(kind).toMatchObject({
      plugin: 'pager',
      kind: 'page',
      version: '0.3.0',
      description: 'Pages the on-call person.',
    });
    expect(kind?.configuration).toMatchObject({ properties: { team: { type: 'string' } } });
  });

  it('lists whether a hook action kind has a dryRun, so a client knows whether hooks.test is open to it (COR-2183, reactions-2 matrix line 114)', async () => {
    const pager = definePlugin({
      name: 'pager',
      version: '1.0.0',
      description: 'Pages someone.',
      setup: () => ({
        reactions: [
          {
            name: 'page',
            description: 'Pages the on-call person.',
            configuration: z.object({}),
            run: async () => undefined,
            dryRun: async () => undefined,
          },
          {
            name: 'ring',
            description: 'Rings the on-call person.',
            configuration: z.object({}),
            run: async () => undefined,
          },
        ],
      }),
    });
    const composed = await composePlugins({
      plugins: [{ descriptor: pager, source: 'package', location: '@example/pager' }],
      hooks: {},
    });
    const kinds = createPluginRegistry(composed.records).plugins.reactions();
    expect(kinds.map((kind) => [kind.kind, kind.dryRun])).toEqual([
      ['page', true],
      ['ring', false],
    ]);
  });

  it('marks a configuration field declared with .meta({ secret: true }) as a secret in the JSON Schema (COR-2177)', async () => {
    const pager = definePlugin({
      name: 'pager',
      version: '1.0.0',
      description: 'Pages someone.',
      setup: () => ({
        reactions: [
          {
            name: 'page',
            description: 'Pages the on-call person.',
            configuration: z.object({
              team: z.string(),
              apiKey: z.string().meta({ secret: true }),
              region: z.string().meta({ secret: true }).optional(),
              nested: z.object({ token: z.string().meta({ secret: true }) }),
            }),
            run: async () => undefined,
          },
        ],
      }),
    });
    const composed = await composePlugins({
      plugins: [{ descriptor: pager, source: 'package', location: '@example/pager' }],
      hooks: {},
    });
    const [kind] = createPluginRegistry(composed.records).plugins.reactions();
    const { properties } = kind!.configuration as unknown as {
      properties: Record<
        string,
        { secret?: boolean; properties?: Record<string, { secret?: boolean }> }
      >;
    };
    expect(properties['apiKey']?.secret).toBe(true);
    expect(properties['region']?.secret).toBe(true);
    expect(properties['nested']?.properties?.['token']?.secret).toBe(true);
    expect(properties['team']?.secret).toBeUndefined();
  });
});

/** The envelope fields of a complete event, as `bureau.events` delivers them. */
const COMPLETE = { bureauId: 'bureau-1', emittedAtMs: 1_000, payload: {} };

describe('bureau.events.format', () => {
  it('is served, described, read-only, and open to any authenticated caller', () => {
    expect(BUREAU_HANDLER_OPERATIONS).toContain(eventsFormatOperation);
    expect(eventsFormatOperation.destructive).toBe(false);
    expect(eventsFormatOperation.access).toEqual({ kind: 'authenticated' });
  });

  it('serves a formatter’s sentence for its kind and the raw kind for any other, in order', async () => {
    const opened = await open();
    const body = await rpc(
      opened.handler,
      'bureau.events.format',
      {
        events: [
          { ...COMPLETE, kind: 'review.requested', payload: { runId: 'run-1' }, source: 'inbox' },
          { ...COMPLETE, kind: 'run.settled', payload: { runId: 'run-2' } },
        ],
      },
      'alice-key',
    );
    expect(body.error).toBeUndefined();
    expect(body.result!['events']).toEqual([
      {
        kind: 'review.requested',
        title: 'A review was asked for (inbox)',
        tier: 'info',
        runId: 'run-1',
        source: 'inbox',
        formattedBy: 'inbox/reviews',
      },
      { kind: 'run.settled', title: 'run.settled', tier: 'info', runId: 'run-2' },
    ]);
  });

  it('serves the tier, icon and link a formatter gives, and drops a link that is not a router path (COR-2222)', async () => {
    const opened = await open();
    const body = await rpc(
      opened.handler,
      'bureau.events.format',
      {
        events: [
          { ...COMPLETE, kind: 'review.expired', payload: { path: '/reviews/9' } },
          { ...COMPLETE, kind: 'review.expired', payload: { path: 'https://example.com' } },
        ],
      },
      'alice-key',
    );
    expect(body.error).toBeUndefined();
    expect(body.result!['events']).toEqual([
      {
        kind: 'review.expired',
        title: 'A review needs attention',
        tier: 'warning',
        icon: 'bell-ring',
        link: '/reviews/9',
        formattedBy: 'inbox/escalations',
      },
      {
        kind: 'review.expired',
        title: 'A review needs attention',
        tier: 'warning',
        icon: 'bell-ring',
        formattedBy: 'inbox/escalations',
      },
    ]);
  });

  it('declares the tier, icon and link in the output schema (COR-2222)', () => {
    const output = z.toJSONSchema(eventsFormatOperation.outputSchema) as unknown as {
      properties: {
        events: {
          items: { properties: Record<string, unknown>; required?: string[] };
        };
      };
    };
    const { properties, required } = output.properties.events.items;
    expect(properties['tier']).toMatchObject({ enum: ['critical', 'warning', 'info'] });
    expect(properties['icon']).toMatchObject({ type: 'string' });
    expect(properties['link']).toMatchObject({ type: 'string' });
    expect(required).toContain('tier');
    expect(required).not.toContain('icon');
    expect(required).not.toContain('link');
  });

  it('refuses more events than one call formats', async () => {
    const opened = await open();
    const events = Array.from({ length: 201 }, () => ({ ...COMPLETE, kind: 'run.settled' }));
    const body = await rpc(opened.handler, 'bureau.events.format', { events }, 'alice-key');
    expect(body.error).toBeDefined();
  });

  it.each([
    ['bureauId', { kind: 'run.settled', emittedAtMs: 1_000, payload: {} }],
    ['emittedAtMs', { kind: 'run.settled', bureauId: 'bureau-1', payload: {} }],
    ['payload', { kind: 'run.settled', bureauId: 'bureau-1', emittedAtMs: 1_000 }],
  ])(
    'refuses an event with no %s, instead of formatting a sentence from made-up fields',
    async (_missing, event) => {
      const opened = await open();
      const body = await rpc(
        opened.handler,
        'bureau.events.format',
        { events: [event] },
        'alice-key',
      );
      expect(body.result).toBeUndefined();
      expect(body.error).toBeDefined();
    },
  );
});
