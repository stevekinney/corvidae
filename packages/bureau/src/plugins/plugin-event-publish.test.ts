/**
 * COR-2224 — `host.publish`: a plugin publishes an event it declared, as `<plugin>:<name>` with
 * `source: <plugin>`. The declaration is the demo plugin's `greeted` event.
 */
import { definePlugin, type PluginHost } from '@lostgradient/interborough-plugin';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from '../agent-catalog';
import type { BureauEventEnvelope } from '../bureau-event-feed';
import { bureauEventsSubscriptionOperation } from '../bureau-events-operation';
import type { Bureau } from '../bureau-types/facade';
import { createBureau } from '../create-bureau';
import { RunRegisteredEvent } from '../events';
import { buildBureauHandlerHost } from '../http/create-bureau-handler';
import { listedPlugins } from '../testing/plugin-listing.test-support';
import { PluginHostDisposedError } from './plugin-event-publish';
import { PluginNeedsSetupError } from './plugin-secret-gate';
import type { BureauPluginSecrets } from './plugin-types';

const bureaus: Bureau<AgentDefinitions>[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

const KEY = 'greeter-key';

/** A plugin that declares one event, `greeted`, and keeps the host API its `setup` was given. */
function greeter(name: string, held: { host?: PluginHost }, withSecret: boolean) {
  return definePlugin({
    name,
    version: '1.0.0',
    description: 'Declares one event.',
    ...(withSecret ? { secrets: [KEY] } : {}),
    setup: ({ host }) => {
      held.host = host;
      return {
        events: [
          {
            name: 'greeted',
            description: 'The plugin greeted someone.',
            payload: z.object({ greetingId: z.string().meta({ identifier: true }) }),
          },
        ],
      };
    },
  });
}

/** A Bureau with the plugins `names`, each declaring `greeted`, and the host API each was given. */
async function startPlugins(names: readonly string[], pluginSecrets?: BureauPluginSecrets) {
  const hosts = new Map<string, { host?: PluginHost }>();
  const plugins = names.map((name) => {
    const held: { host?: PluginHost } = {};
    hosts.set(name, held);
    return {
      descriptor: greeter(name, held, pluginSecrets !== undefined),
      source: 'package' as const,
      location: `@example/${name}`,
    };
  });
  const bureau = await createBureau<AgentDefinitions>({
    plugins,
    ...(pluginSecrets === undefined ? {} : { pluginSecrets }),
  });
  bureaus.push(bureau);
  await bureau.plugins.ready();
  return { bureau, hostOf: (name: string) => hosts.get(name)!.host! };
}

/** A Bureau with plugin `demo` that declares `greeted`, and the host API its `setup` was given. */
async function start(pluginSecrets?: BureauPluginSecrets) {
  const { bureau, hostOf } = await startPlugins(['demo'], pluginSecrets);
  return { bureau, host: hostOf('demo') };
}

/** Every envelope the Bureau's feed retains. */
async function recorded(bureau: Bureau<AgentDefinitions>): Promise<BureauEventEnvelope[]> {
  return replayed(bureau);
}

/** The envelopes the feed retains after `fromCursor`, or all of them. */
async function replayed(
  bureau: Bureau<AgentDefinitions>,
  fromCursor?: string,
): Promise<BureauEventEnvelope[]> {
  const envelopes: BureauEventEnvelope[] = [];
  for await (const envelope of bureau.internals.eventFeed.feed.replay(
    fromCursor === undefined ? {} : { fromCursor },
  ))
    envelopes.push(envelope);
  return envelopes;
}

/** A core event onto the feed, which a test uses to sit around a plugin event or to mark its end. */
function coreEvent(bureau: Bureau<AgentDefinitions>, runId: string): BureauEventEnvelope {
  return bureau.internals.eventFeed.publish(new RunRegisteredEvent(runId))!;
}

/** Reads `iterable` up to and including the envelope of run `runId` that `coreEvent` published. */
async function readThrough(
  iterable: AsyncIterable<BureauEventEnvelope>,
  runId: string,
): Promise<BureauEventEnvelope[]> {
  const seen: BureauEventEnvelope[] = [];
  for await (const envelope of iterable) {
    seen.push(envelope);
    if (envelope.kind === 'run.registered' && envelope.payload['runId'] === runId) break;
  }
  return seen;
}

const published = (envelopes: readonly BureauEventEnvelope[]) =>
  envelopes.filter(({ kind }) => kind.includes(':'));

describe('host.publish', () => {
  it('publishes p:<name> with source p, carrying the payload the schema accepted', async () => {
    const { bureau, host } = await start();
    const heard: string[] = [];
    bureau.addEventListener('demo:greeted' as never, (event) => heard.push(event.type));

    await host.publish('greeted', { greetingId: 'greeting-1', extra: 'dropped' });

    expect(published(await recorded(bureau))).toMatchObject([
      { kind: 'demo:greeted', source: 'demo', payload: { greetingId: 'greeting-1' } },
    ]);
    expect(published(await recorded(bureau))[0]?.payload).toEqual({ greetingId: 'greeting-1' });
    expect(heard).toEqual(['demo:greeted']);
  });

  it('rejects an undeclared name with a TypeError naming p:<name>, and publishes nothing', async () => {
    const { bureau, host } = await start();
    const before = await recorded(bureau);

    const error = await rejectionOf(host.publish('farewell', { greetingId: 'greeting-1' }));

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain('demo:farewell');
    expect(published(await recorded(bureau))).toEqual([]);
    expect(await recorded(bureau)).toEqual(before);
  });

  it('does not take an inherited property for a declared name', async () => {
    const { bureau, host } = await start();

    expect(await rejectionOf(host.publish('constructor', {}))).toBeInstanceOf(TypeError);
    expect(published(await recorded(bureau))).toEqual([]);
  });

  it('rejects a payload that fails the declared schema, and publishes nothing', async () => {
    const { bureau, host } = await start();
    const before = await recorded(bureau);

    for (const payload of [{}, { greetingId: 3 }, null, 'greeting-1']) {
      expect(await rejectionOf(host.publish('greeted', payload))).toBeInstanceOf(TypeError);
    }

    expect(published(await recorded(bureau))).toEqual([]);
    expect(await recorded(bureau)).toEqual(before);
  });

  it('refuses while a secret the plugin declared is not set, and publishes after it is saved', async () => {
    const values = new Map<string, string>();
    const watchers = new Set<() => void>();
    const secrets: BureauPluginSecrets = {
      get: async (key) => values.get(key),
      watch: (_key, listener) => {
        watchers.add(listener);
        return () => watchers.delete(listener);
      },
    };
    const { bureau, host } = await start(secrets);

    const refused = await rejectionOf(host.publish('greeted', { greetingId: 'greeting-1' }));
    expect(refused).toBeInstanceOf(PluginNeedsSetupError);
    expect(published(await recorded(bureau))).toEqual([]);

    values.set(KEY, 'secret-value');
    for (const listener of watchers) listener();
    await waitUntil(
      async () => {
        const [listing] = await listedPlugins(bureau);
        return listing?.status === 'running';
      },
      {
        message: 'the plugin to leave needs-setup',
      },
    );
    await host.publish('greeted', { greetingId: 'greeting-1' });
    expect(published(await recorded(bureau)).map(({ kind }) => kind)).toEqual(['demo:greeted']);
  });

  it('puts only the fields the declared schema names on the feed, never a secret in the call (row 6)', async () => {
    // The feed redacts nothing in a core event either: a projection names the fields that cross
    // the wire. A plugin event's projection is its declared schema, so a field it does not name,
    // such as a secret a caller passes along, never reaches the feed.
    const secrets: BureauPluginSecrets = {
      get: async () => 'secret-value',
      watch: () => () => undefined,
    };
    const { bureau, host } = await start(secrets);
    await waitUntil(async () => (await listedPlugins(bureau))[0]?.status === 'running', {
      message: 'the plugin to run',
    });

    await host.publish('greeted', { greetingId: 'greeting-1', [KEY]: 'secret-value' });

    const envelopes = await recorded(bureau);
    expect(published(envelopes)[0]?.payload).toEqual({ greetingId: 'greeting-1' });
    expect(JSON.stringify(envelopes)).not.toContain('secret-value');
  });

  it('delivers to a live feed subscriber exactly once, with the plugin as its source (row 3)', async () => {
    const { bureau, host } = await start();
    const last = coreEvent(bureau, 'before');
    const subscription = bureau.internals.eventFeed.feed.subscribe({ fromCursor: last.cursor });
    const reading = readThrough(subscription, 'after');

    await host.publish('greeted', { greetingId: 'greeting-1' });
    coreEvent(bureau, 'after');

    const seen = await reading;
    expect(seen.map(({ kind }) => kind)).toEqual(['demo:greeted', 'run.registered']);
    expect(seen[0]).toMatchObject({ source: 'demo', payload: { greetingId: 'greeting-1' } });
  });

  it('replays once, in feed order with the core events around it, after a reconnect from before it (row 4)', async () => {
    const { bureau, host } = await start();
    const first = coreEvent(bureau, 'first');
    await host.publish('greeted', { greetingId: 'greeting-1' });
    coreEvent(bureau, 'second');

    const replay = await replayed(bureau, first.cursor);

    expect(replay.map(({ kind }) => kind)).toEqual(['demo:greeted', 'run.registered']);
    expect(replay.map(({ sequence }) => sequence)).toEqual(
      [...replay.map(({ sequence }) => sequence)].sort((a, b) => a - b),
    );
    expect(replay[1]?.payload['runId']).toBe('second');
  });

  it('does not deliver it again to a reconnect from its own cursor (row 5)', async () => {
    const { bureau, host } = await start();
    coreEvent(bureau, 'first');
    await host.publish('greeted', { greetingId: 'greeting-1' });
    const afterPlugin = published(await recorded(bureau))[0]!;
    coreEvent(bureau, 'second');

    expect((await replayed(bureau, afterPlugin.cursor)).map(({ kind }) => kind)).toEqual([
      'run.registered',
    ]);
    const subscription = bureau.internals.eventFeed.feed.subscribe({
      fromCursor: afterPlugin.cursor,
    });
    const reading = readThrough(subscription, 'third');
    coreEvent(bureau, 'third');
    expect((await reading).map(({ kind }) => kind)).toEqual(['run.registered', 'run.registered']);
  });

  it('records two concurrent publishes at distinct positions, in call order, once each (row 7)', async () => {
    const { bureau, host } = await start();

    await Promise.all([
      host.publish('greeted', { greetingId: 'greeting-a' }),
      host.publish('greeted', { greetingId: 'greeting-b' }),
    ]);

    const events = published(await recorded(bureau));
    expect(events.map(({ payload }) => payload['greetingId'])).toEqual([
      'greeting-a',
      'greeting-b',
    ]);
    expect(new Set(events.map(({ cursor }) => cursor)).size).toBe(2);
    expect(events[1]!.sequence).toBeGreaterThan(events[0]!.sequence);
  });

  it('rejects, and publishes nothing, once the Bureau is disposed (row 8)', async () => {
    const { bureau, host } = await start();
    const heard: string[] = [];
    bureau.addEventListener('demo:greeted' as never, (event) => heard.push(event.type));

    await bureau.dispose();
    const error = await rejectionOf(host.publish('greeted', { greetingId: 'greeting-1' }));

    expect(error).toBeInstanceOf(PluginHostDisposedError);
    expect(error).toMatchObject({ name: 'PluginHostDisposedError', plugin: 'demo' });
    expect(heard).toEqual([]);
    expect(published(await recorded(bureau))).toEqual([]);
  });

  it('still rejects an undeclared name or a bad payload after dispose, before any dispatch (row 8)', async () => {
    const { bureau, host } = await start();
    await bureau.dispose();

    for (const call of [
      host.publish('farewell', {}),
      host.publish('greeted', {}),
      host.publish('greeted', { greetingId: 'greeting-1' }),
    ]) {
      expect(await rejectionOf(call)).toBeInstanceOf(Error);
    }
    expect(published(await recorded(bureau))).toEqual([]);
  });

  it('publishes only under its own plugin name, whatever the name it is given (row 9)', async () => {
    const { bureau, hostOf } = await startPlugins(['demo', 'other']);

    await hostOf('demo').publish('greeted', { greetingId: 'greeting-1' });
    await hostOf('other').publish('greeted', { greetingId: 'greeting-2' });
    expect(await rejectionOf(hostOf('demo').publish('other:greeted', {}))).toBeInstanceOf(
      TypeError,
    );

    expect(published(await recorded(bureau)).map(({ kind, source }) => [kind, source])).toEqual([
      ['demo:greeted', 'demo'],
      ['other:greeted', 'other'],
    ]);
  });
});

describe('a plugin kind in the bureau.events kinds filter (COR-2224)', () => {
  /** The `bureau.events` operation, served over `bureau`'s own handler host. */
  function serve(bureau: Bureau<AgentDefinitions>) {
    const host = buildBureauHandlerHost(bureau, []);
    const definition = bureauEventsSubscriptionOperation as unknown as {
      inputSchema: z.ZodType;
      invoke: (args: {
        input: { bureauId: string; fromCursor?: string; kinds?: string | string[] };
        host: unknown;
      }) => Promise<{ iterable: AsyncIterable<BureauEventEnvelope> & { close(): Promise<void> } }>;
    };
    return {
      inputSchema: definition.inputSchema,
      // The input goes through the operation's schema first, as every transport does.
      subscribe: (input: { fromCursor?: string; kinds?: string | string[] }) =>
        definition.invoke({
          input: definition.inputSchema.parse({ bureauId: bureau.id, ...input }) as {
            bureauId: string;
          },
          host,
        }),
    };
  }

  it('accepts a kind a loaded plugin declares, and refuses one nothing declares', async () => {
    const { bureau } = await start();
    const served = serve(bureau);

    expect(
      served.inputSchema.safeParse({ bureauId: bureau.id, kinds: ['demo:greeted'] }).success,
    ).toBe(true);
    expect(
      served.inputSchema.safeParse({ bureauId: bureau.id, kinds: 'run.nonexistent' }).success,
    ).toBe(false);
    for (const kinds of [['demo:unknown'], 'other:greeted', ['run.registered', 'demo:unknown']]) {
      expect(await rejectionOf(served.subscribe({ kinds }))).toMatchObject({
        code: 'InvalidParams',
      });
    }
  });

  it('delivers the plugin event live, and replays it after a reconnect with a cursor', async () => {
    const { bureau, host } = await start();
    const served = serve(bureau);
    const before = coreEvent(bureau, 'before');

    const live = await served.subscribe({ kinds: ['demo:greeted'], fromCursor: before.cursor });
    const liveSeen: BureauEventEnvelope[] = [];
    const reading = (async () => {
      for await (const envelope of live.iterable) {
        liveSeen.push(envelope);
        break;
      }
    })();
    await host.publish('greeted', { greetingId: 'greeting-1' });
    coreEvent(bureau, 'after');
    await reading;
    expect(liveSeen).toMatchObject([{ kind: 'demo:greeted', source: 'demo' }]);
    await live.close();

    const reconnected = await served.subscribe({
      kinds: ['demo:greeted'],
      fromCursor: before.cursor,
    });
    const replayedSeen: BureauEventEnvelope[] = [];
    for await (const envelope of reconnected.iterable) {
      replayedSeen.push(envelope);
      break;
    }
    expect(replayedSeen).toMatchObject([
      { kind: 'demo:greeted', payload: { greetingId: 'greeting-1' } },
    ]);
    await reconnected.close();
  });
});
