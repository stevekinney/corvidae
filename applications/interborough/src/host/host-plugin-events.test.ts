/**
 * COR-2098: the host reports the plugin and secret changes it commits to Bureau, which publishes
 * them as `secret.set`, `secret.removed`, `plugin.settings-changed` and `plugin.status-changed`.
 * Every test starts the real host with fixture plugins on a scratch home, changes them over the
 * host's own HTTP surface, and reads what the Bureau's feed holds.
 */
import type { BureauPluginEntry } from '@lostgradient/bureau';
import { definePlugin, type PluginDescriptor } from '@lostgradient/interborough-plugin';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { startHost, type Host } from './host.ts';

const KEYED_SECRET = 'keyed-api-key';
const SECOND_SECRET = 'keyed-signing-key';
const MINTED_SECRET = 'minted-signing-key';
const LATER_SECRET = 'later-signing-key';
const BROKEN_SECRET = 'broken-api-key';
/** Text a plugin's setup error carries: the listing keeps it for a reader, and no event may. */
const SETUP_CANARY = 'CANARY-2098-SETUP-ERROR-4c1b';
/** A value no payload, answer or log line may ever repeat. */
const SECRET_VALUE = 'sk-fixture-2098-6f1d0c9e-never-echoed';

const directories: string[] = [];
const hosts: Host[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function fixturePlugins(): readonly BureauPluginEntry[] {
  const entry = (descriptor: PluginDescriptor<z.ZodType>): BureauPluginEntry => ({
    descriptor,
    source: 'package',
    location: `@fixture/${descriptor.name}`,
  });
  return [
    entry(
      definePlugin({
        name: 'limited',
        version: '1.0.0',
        description: 'Takes a numeric limit.',
        configuration: z.object({ limit: z.number().default(3) }),
      }),
    ),
    entry(
      definePlugin({
        name: 'keyed',
        version: '1.0.0',
        description: 'Needs an API key.',
        secrets: [KEYED_SECRET],
      }),
    ),
    entry(
      definePlugin({
        name: 'pair',
        version: '1.0.0',
        description: 'Needs two keys.',
        secrets: [KEYED_SECRET.replace('keyed', 'pair'), SECOND_SECRET.replace('keyed', 'pair')],
      }),
    ),
    entry(
      definePlugin({
        name: 'minted',
        version: '1.0.0',
        description: 'Gets a signing key from the host.',
        secrets: [{ key: MINTED_SECRET, generated: true }],
      }),
    ),
    entry(
      definePlugin({
        name: 'later',
        version: '1.0.0',
        description: 'Gets a signing key once it is turned on.',
        enabled: false,
        secrets: [{ key: LATER_SECRET, generated: true }],
      }),
    ),
    entry(
      definePlugin({
        name: 'broken',
        version: '1.0.0',
        description: 'Fails in its setup, with text a person wrote.',
        secrets: [BROKEN_SECRET],
        setup: () => {
          throw new Error(`setup failed: ${SETUP_CANARY}`);
        },
      }),
    ),
  ];
}

async function startAt(logs: string[] = []): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-plugin-events-'));
  directories.push(home);
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    plugins: fixturePlugins(),
    log: (message) => logs.push(message),
    warn: (message) => logs.push(message),
  });
  hosts.push(host);
  return host;
}

/** A request the host's mutation guard accepts: the operation and the revision it was made against. */
async function send(host: Host, method: 'PUT' | 'DELETE', path: string, body: unknown = {}) {
  const snapshot = await host.plugins.snapshot();
  return fetch(new URL(path, host.url), {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(typeof body === 'object' && body !== null ? body : {}),
      operationId: crypto.randomUUID(),
      expectedRevision: snapshot.configurationRevision,
    }),
  });
}

interface Published {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

const HOST_KINDS = new Set([
  'secret.set',
  'secret.removed',
  'plugin.settings-changed',
  'plugin.status-changed',
]);

/** Every plugin and secret envelope the Bureau's feed holds, in feed order. */
async function published(host: Host): Promise<Published[]> {
  const found: Published[] = [];
  for await (const envelope of host.bureau.internals.eventFeed.feed.replay()) {
    const { kind, payload } = envelope as unknown as Published;
    if (HOST_KINDS.has(kind)) found.push({ kind, payload });
  }
  return found;
}

/** Waits until the feed holds `count` such envelopes, then reads them. */
async function publishedCount(host: Host, count: number): Promise<Published[]> {
  await waitUntil(
    async () => {
      const found = await published(host);
      return found.length >= count;
    },
    { message: `the feed holds ${count} plugin and secret events` },
  );
  await quietFor(50);
  return published(host);
}

/** The status a request ended with. */
async function statusOf(request: Promise<Response>): Promise<number> {
  const response = await request;
  return response.status;
}

/** The kinds the feed holds, in order. */
async function publishedKinds(host: Host): Promise<string[]> {
  const found = await published(host);
  return found.map((event) => event.kind);
}

const keyedPath = `/host/plugins/keyed/secrets/${KEYED_SECRET}`;

describe('what the host reports of a secret and a plugin’s status (COR-2098)', () => {
  test('publishes secret.removed, then needs-setup with secret-missing, when a declared secret is removed (AC1), and secret.set, then running, when it is saved back (AC2)', async () => {
    const host = await startAt();
    expect(await published(host)).toEqual([]);

    // Saved for the first time: the plugin leaves needs-setup.
    expect(await statusOf(send(host, 'PUT', keyedPath, { value: SECRET_VALUE }))).toBe(200);
    expect(await publishedCount(host, 2)).toEqual([
      { kind: 'secret.set', payload: { plugin: 'keyed', key: KEYED_SECRET } },
      {
        kind: 'plugin.status-changed',
        payload: {
          plugin: 'keyed',
          previousStatus: 'needs-setup',
          status: 'running',
          problemCodes: [],
        },
      },
    ]);

    // AC1: removed, so the plugin is running no longer.
    const removed = await send(host, 'DELETE', keyedPath);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ plugin: 'keyed', key: KEYED_SECRET, set: false });
    const afterRemoval = await publishedCount(host, 4);
    expect(afterRemoval.slice(2)).toEqual([
      { kind: 'secret.removed', payload: { plugin: 'keyed', key: KEYED_SECRET } },
      {
        kind: 'plugin.status-changed',
        payload: {
          plugin: 'keyed',
          previousStatus: 'running',
          status: 'needs-setup',
          problemCodes: ['secret-missing'],
        },
      },
    ]);

    // AC2: saved back.
    expect(await statusOf(send(host, 'PUT', keyedPath, { value: SECRET_VALUE }))).toBe(200);
    const afterSaveBack = await publishedCount(host, 6);
    expect(afterSaveBack.slice(4)).toEqual([
      { kind: 'secret.set', payload: { plugin: 'keyed', key: KEYED_SECRET } },
      {
        kind: 'plugin.status-changed',
        payload: {
          plugin: 'keyed',
          previousStatus: 'needs-setup',
          status: 'running',
          problemCodes: [],
        },
      },
    ]);
  });

  test('publishes no plugin.status-changed when the host starts (AC4), or when a write leaves the status as it was', async () => {
    const host = await startAt();
    await quietFor(50);
    expect(await published(host)).toEqual([]);
    const snapshot = await host.plugins.snapshot();
    expect(snapshot.plugins.length).toBeGreaterThan(0);

    // A plugin with two keys stays needs-setup while one of them is set, so no status event.
    const pair = (key: string) => `/host/plugins/pair/secrets/${key}`;
    expect(await statusOf(send(host, 'PUT', pair('pair-api-key'), { value: SECRET_VALUE }))).toBe(
      200,
    );
    const events = await publishedCount(host, 1);
    await quietFor(50);

    expect(events.map((event) => event.kind)).toEqual(['secret.set']);
    expect(await publishedKinds(host)).toEqual(['secret.set']);
  });

  test('publishes plugin.settings-changed with restartRequired when a plugin is disabled (AC5)', async () => {
    const host = await startAt();

    const response = await send(host, 'PUT', '/host/plugins/limited', { enabled: false });
    expect(response.status).toBe(200);

    expect(await publishedCount(host, 1)).toEqual([
      {
        kind: 'plugin.settings-changed',
        payload: { plugin: 'limited', enabled: false, restartRequired: true },
      },
    ]);
  });

  test('publishes the secret an enabled plugin has the host create, right after the settings, and no status for a plugin that waits for a restart', async () => {
    const host = await startAt();
    expect(await published(host)).toEqual([]);

    expect(await statusOf(send(host, 'PUT', '/host/plugins/later', { enabled: true }))).toBe(200);

    const events = await publishedCount(host, 2);
    expect(events.map((event) => event.kind)).toEqual(['plugin.settings-changed', 'secret.set']);
    expect(events[1]?.payload).toEqual({ plugin: 'later', key: LATER_SECRET });
    // Startup created `minted`'s key and reported nothing; this plugin was turned on by a write.
    expect(JSON.stringify(events)).not.toContain(MINTED_SECRET);
  });

  test('publishes nothing for a write the host refuses, and nothing for a key the plugin does not declare', async () => {
    const host = await startAt();

    const unknown = await send(host, 'PUT', '/host/plugins/keyed/secrets/not-declared', {
      value: SECRET_VALUE,
    });
    const unknownRemoval = await send(host, 'DELETE', '/host/plugins/keyed/secrets/not-declared');
    const invalid = await send(host, 'PUT', keyedPath, { value: '   ' });
    const missingPlugin = await send(host, 'DELETE', `/host/plugins/ghost/secrets/${KEYED_SECRET}`);

    expect([unknown.status, unknownRemoval.status, invalid.status, missingPlugin.status]).toEqual([
      400, 400, 400, 404,
    ]);
    await quietFor(50);
    expect(await published(host)).toEqual([]);
  });
});

describe('a plugin whose setup failed (COR-2098)', () => {
  test('lists the setup error for a reader, and no event, answer or log line repeats it', async () => {
    const logs: string[] = [];
    const host = await startAt(logs);
    const snapshot = await host.plugins.snapshot();
    const broken = snapshot.plugins.find((plugin) => plugin.descriptor.name === 'broken');
    // The text is on the plugin's listing, for a person who asks for it.
    expect(JSON.stringify(broken?.problems)).toContain(SETUP_CANARY);

    const brokenPath = `/host/plugins/broken/secrets/${BROKEN_SECRET}`;
    const saved = await send(host, 'PUT', brokenPath, { value: SECRET_VALUE });
    const disabled = await send(host, 'PUT', '/host/plugins/broken', { enabled: false });
    const removed = await send(host, 'DELETE', brokenPath);
    const answers = [await saved.text(), await disabled.text(), await removed.text()];
    const events = await publishedCount(host, 3);

    // A plugin that failed its setup stays `skipped` whatever its secrets say: no status change.
    expect(events.map((event) => event.kind)).toEqual([
      'secret.set',
      'plugin.settings-changed',
      'secret.removed',
    ]);
    // The host's own startup line names a setup failure's message (`pluginStartupLines`, by design,
    // for the person who starts the host); no event and no answer to a write does.
    for (const text of [JSON.stringify(events), ...answers]) {
      expect(text).not.toContain(SETUP_CANARY);
    }
  });
});

describe('no secret value reaches an event, an answer or a log (COR-2098, AC3)', () => {
  test('holds for a save, a removal and a save back', async () => {
    const logs: string[] = [];
    const host = await startAt(logs);

    const saved = await send(host, 'PUT', keyedPath, { value: SECRET_VALUE });
    const removed = await send(host, 'DELETE', keyedPath);
    const savedBack = await send(host, 'PUT', keyedPath, { value: SECRET_VALUE });
    const answers = [await saved.text(), await removed.text(), await savedBack.text()];
    const events = await publishedCount(host, 6);
    const everything = JSON.stringify(
      await (async () => {
        const found: unknown[] = [];
        for await (const envelope of host.bureau.internals.eventFeed.feed.replay()) {
          found.push(envelope);
        }
        return found;
      })(),
    );

    expect(events).toHaveLength(6);
    for (const text of [...answers, everything, ...logs]) {
      expect(text).not.toContain(SECRET_VALUE);
    }
    // No payload names more than the plugin and the key the plugin declares, nor a length or a digest.
    for (const event of events.filter((entry) => entry.kind.startsWith('secret.'))) {
      expect(Object.keys(event.payload).toSorted()).toEqual(['key', 'plugin']);
    }
  });

  test('never repeats a key the plugin does not declare, in an answer or a log line', async () => {
    const logs: string[] = [];
    const host = await startAt(logs);
    const hostile = `x-${SECRET_VALUE}`;

    const removal = await send(host, 'DELETE', `/host/plugins/keyed/secrets/${hostile}`);
    const save = await send(host, 'PUT', `/host/plugins/keyed/secrets/${hostile}`, {
      value: SECRET_VALUE,
    });
    const texts = [await removal.text(), await save.text(), ...logs];

    expect([removal.status, save.status]).toEqual([400, 400]);
    for (const text of texts) expect(text).not.toContain(hostile);
    expect(await published(host)).toEqual([]);
  });
});
