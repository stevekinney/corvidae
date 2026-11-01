/**
 * COR-1893 — `bureau.plugins.kinds` and `bureau.events.format` over a real Bureau that loads a
 * plugin: the trigger kinds it contributes are listed with their configuration as JSON Schema, a
 * contributed formatter's sentence is served, and an event no formatter claims is served raw.
 */
import { definePlugin } from '@lostgradient/interborough-plugin';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { composePlugins } from '../../plugins/compose-plugins.ts';
import { createPluginRegistry } from '../../plugins/plugin-registry.ts';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
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
  setup: () => ({
    triggerKinds: [
      {
        name: 'message',
        description: 'A message arrives in a mailbox.',
        configuration: z.object({
          mailbox: z.string().describe('The mailbox to watch.'),
          unreadOnly: z.boolean().optional(),
        }),
        start: async () => () => undefined,
      },
    ],
    eventFormatters: [
      {
        name: 'reviews',
        eventKinds: ['review.requested'],
        format: (event) => ({ title: `A review was asked for (${event.source ?? 'core'})` }),
      },
    ],
  }),
});

async function open(): Promise<OpenedBureau> {
  const opened = await openBureau({
    bureauOptions: {
      plugins: [{ descriptor: inbox, source: 'package', location: '@example/inbox' }],
    },
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

describe('bureau.plugins.kinds', () => {
  it('is served, described, read-only, and open to any authenticated caller', () => {
    expect(BUREAU_HANDLER_OPERATIONS).toContain(pluginKindsOperation);
    expect(pluginKindsOperation.destructive).toBe(false);
    expect(pluginKindsOperation.access).toEqual({ kind: 'authenticated' });
    expect(pluginKindsOperation.description?.length ?? 0).toBeGreaterThan(40);
  });

  it('lists a contributed trigger kind with its configuration as JSON Schema', async () => {
    const opened = await open();
    const body = await rpc(opened.handler, 'bureau.plugins.kinds', {}, 'alice-key');
    expect(body.error).toBeUndefined();
    const triggerKinds = body.result!['triggerKinds'] as Array<Record<string, unknown>>;
    expect(triggerKinds).toHaveLength(1);
    expect(triggerKinds[0]).toMatchObject({
      plugin: 'inbox',
      id: 'inbox:message',
      description: 'A message arrives in a mailbox.',
      version: '2.0.0',
    });
    const configuration = triggerKinds[0]!['configuration'] as {
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
    expect(configuration.properties['mailbox']).toMatchObject({
      type: 'string',
      description: 'The mailbox to watch.',
    });
    expect(configuration.required).toEqual(['mailbox']);
    expect(body.result!['hookActionKinds']).toEqual([]);
  });

  it('refuses a request with no credential', async () => {
    const opened = await open();
    const body = await rpc(opened.handler, 'bureau.plugins.kinds', {}, 'no-such-key');
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
        hookActionKinds: [
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
    expect(createPluginRegistry(bare.records).plugins.hookActionKinds()).toEqual([]);

    const given = await composePlugins({ plugins: [entry], hooks: {} });
    const [kind] = createPluginRegistry(given.records).plugins.hookActionKinds();
    expect(kind).toMatchObject({
      plugin: 'pager',
      kind: 'page',
      version: '0.3.0',
      description: 'Pages the on-call person.',
    });
    expect(kind?.configuration).toMatchObject({ properties: { team: { type: 'string' } } });
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
        runId: 'run-1',
        source: 'inbox',
        formattedBy: 'inbox/reviews',
      },
      { kind: 'run.settled', title: 'run.settled', runId: 'run-2' },
    ]);
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
