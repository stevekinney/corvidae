/**
 * COR-1880: the host lists the plugins it loads, persists the owner's choices for them in
 * `configuration.json`, stores the secrets they declare, and creates the ones marked `generated`.
 * Every test starts the real host with fixture plugins on a scratch home and talks to it over its
 * own HTTP surface; the remote home, which needs a database and a bucket, is covered against the
 * manager and a real Bureau with a home that cannot write.
 */
import { createBureau, type BureauPluginEntry } from '@lostgradient/bureau';
import {
  definePlugin,
  type PluginDescriptor,
  type PluginSecretDeclaration,
} from '@lostgradient/interborough-plugin';
import { type GovernedMemory } from '@lostgradient/memory';
import type { ProviderDefinition } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { startHost, type Host } from './host.ts';
import { createHostMemory } from './memory.ts';
import { createPluginManager } from './plugin-manager.ts';

const directories: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const KEYED_SECRET = 'keyed-api-key';
const MINTED_SECRET = 'minted-signing-key';
const LATER_SECRET = 'later-signing-key';
/** A value no response, listing, or configuration may ever repeat. */
const SECRET_VALUE = 'sk-fixture-6f1d0c9e-never-echoed';

/** The fixture plugins: each exists to pin one behavior the host owns. */
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
        name: 'quiet',
        version: '1.0.0',
        description: 'Waits to be turned on.',
        enabledByDefault: false,
      }),
    ),
    entry(
      definePlugin({
        name: 'always',
        version: '1.0.0',
        description: 'Cannot be turned off.',
        required: true,
      }),
    ),
    entry(
      definePlugin({
        name: 'keyed',
        version: '1.0.0',
        description: 'Needs an API key.',
        secrets: [KEYED_SECRET],
        setup: () => ({
          embedders: [
            { name: 'tiny', dimensions: 4, embed: async (texts) => texts.map(() => [0, 0, 0, 1]) },
          ],
        }),
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
        enabledByDefault: false,
        secrets: [{ key: LATER_SECRET, generated: true }],
      }),
    ),
  ];
}

/** A model provider that is never called: the host only needs it to be contributed. */
function providerNamed(name: string): ProviderDefinition {
  return {
    name,
    generate: () => async () => ({ content: '', toolCalls: [] }),
    stream: () => {
      throw new Error('The fixture provider does not stream.');
    },
  };
}

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-plugins-'));
  directories.push(directory);
  return directory;
}

/** The plugins a Bureau was given, without the built-in `bureau` plugin it lists first (COR-1890). */
async function ownPlugins(bureau: Pick<Host['bureau'], 'plugins'>) {
  const listed = await bureau.plugins.list();
  return listed.filter((listing) => listing.source !== 'built-in');
}

async function startAt(home: string, plugins = fixturePlugins()): Promise<Host> {
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0, plugins });
  hosts.push(host);
  return host;
}

type Standing = {
  readonly descriptor: { readonly name: string };
  readonly status: string;
  readonly problems: readonly { readonly code: string }[];
  readonly enabled: boolean;
  readonly configuration: unknown;
  readonly restartRequired: boolean;
  readonly secrets: readonly {
    readonly key: string;
    readonly generated: boolean;
    readonly set: boolean;
    readonly location: string;
  }[];
};

async function standings(host: Host): Promise<Record<string, Standing>> {
  const response = await fetch(new URL('/host/plugins', host.url));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { plugins: Standing[] };
  return Object.fromEntries(body.plugins.map((plugin) => [plugin.descriptor.name, plugin]));
}

function put(host: Host, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(new URL(path, host.url), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** The plugin `name` as `GET /host/plugins` reports it now. */
async function pluginNamed(host: Host, name: string): Promise<Standing | undefined> {
  const all = await standings(host);
  return all[name];
}

/** The status of the `keyed` fixture plugin now. */
async function keyedStatus(host: Host): Promise<string | undefined> {
  const keyed = await pluginNamed(host, 'keyed');
  return keyed?.status;
}

/** The providers `/host/paths` reports. */
async function pathsOf(host: Host): Promise<{ providers: { name: string; secretFile: string }[] }> {
  const response = await fetch(new URL('/host/paths', host.url));
  return (await response.json()) as { providers: { name: string; secretFile: string }[] };
}

/** The status code a request ended with. */
async function statusOf(request: Promise<Response>): Promise<number> {
  const response = await request;
  return response.status;
}

/** The text of `GET path`. */
async function textOf(host: Host, path: string): Promise<string> {
  const response = await fetch(new URL(path, host.url));
  return response.text();
}

/** The mode bits of a secret's file. */
async function secretMode(home: string, key: string): Promise<number> {
  const file = await stat(join(home, 'secrets', key));
  return file.mode & 0o777;
}

/** How many characters a secret holds, or `undefined` when it is not stored. */
async function secretLength(home: string, key: string): Promise<number | undefined> {
  const text = await secretText(home, key);
  return text?.length;
}

async function configurationText(home: string): Promise<string | undefined> {
  return readFile(join(home, 'configuration.json'), 'utf8').catch(() => undefined);
}

async function secretText(home: string, key: string): Promise<string | undefined> {
  return readFile(join(home, 'secrets', key), 'utf8').catch(() => undefined);
}

describe('GET /host/plugins', () => {
  test('lists every plugin in load order with its status, choices, and secrets', async () => {
    const host = await startAt(await scratch());
    const response = await fetch(new URL('/host/plugins', host.url));
    const body = (await response.json()) as { plugins: Standing[] };

    expect(body.plugins.map((plugin) => plugin.descriptor.name)).toEqual([
      'bureau',
      'limited',
      'quiet',
      'always',
      'keyed',
      'minted',
      'later',
    ]);
    // COR-1890: Bureau's own tools are the built-in plugin's, which runs before any other.
    expect(body.plugins[0]).toMatchObject({
      source: 'built-in',
      status: 'running',
      enabled: true,
      descriptor: { required: true },
    });
    const keyed = body.plugins.find((plugin) => plugin.descriptor.name === 'keyed');
    expect(keyed).toMatchObject({
      status: 'needs-setup',
      enabled: true,
      configuration: {},
      restartRequired: false,
      secrets: [{ key: KEYED_SECRET, generated: false, set: false }],
    });
    expect(keyed?.problems).toEqual([expect.objectContaining({ code: 'secret-missing' })]);
  });

  test('wires the embedders a plugin contributes into governed memory', async () => {
    const host = await startAt(await scratch());
    const listing = await host.bureau.plugins.list();
    const keyed = listing.find((plugin) => plugin.descriptor.name === 'keyed');

    // Bureau lists an embedder only when the host gave it a memory factory to build with.
    expect(keyed?.contributions.map((contribution) => contribution.kind)).toEqual(['embedder']);
  });

  test('reports a refusal from a foreign origin without a body', async () => {
    const host = await startAt(await scratch());
    const response = await fetch(new URL('/host/plugins', host.url), {
      headers: { origin: 'http://attacker.example' },
    });
    expect(response.status).toBe(403);
  });
});

describe('a plugin the file does not name', () => {
  test('is enabled when its enabledByDefault is true and disabled when it is false', async () => {
    const host = await startAt(await scratch());
    const plugins = await standings(host);

    expect(plugins['limited']).toMatchObject({ enabled: true, status: 'running' });
    expect(plugins['quiet']).toMatchObject({ enabled: false, status: 'disabled' });
  });

  test('is read from the file: a stored choice replaces the default', async () => {
    const home = await scratch();
    await Bun.write(
      join(home, 'configuration.json'),
      JSON.stringify({ plugins: { quiet: { enabled: true }, limited: { enabled: false } } }),
    );
    const host = await startAt(home);
    const plugins = await standings(host);

    expect(plugins['quiet']).toMatchObject({ enabled: true, status: 'running' });
    expect(plugins['limited']).toMatchObject({ enabled: false, status: 'disabled' });
  });
});

describe('PUT /host/plugins/:name', () => {
  test('persists across a restart', async () => {
    const home = await scratch();
    const first = await startAt(home);
    const response = await put(first, '/host/plugins/quiet', { enabled: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      plugin: 'quiet',
      enabled: true,
      restartRequired: true,
    });
    const configured = await put(first, '/host/plugins/limited', { configuration: { limit: 5 } });
    expect(configured.status).toBe(200);
    await first.close();

    const second = await startAt(home);
    const plugins = await standings(second);
    expect(plugins['quiet']).toMatchObject({
      enabled: true,
      status: 'running',
      restartRequired: false,
    });
    expect(plugins['limited']).toMatchObject({ configuration: { limit: 5 }, status: 'running' });
    expect(JSON.parse((await configurationText(home)) ?? '{}')).toEqual({
      plugins: { quiet: { enabled: true }, limited: { configuration: { limit: 5 } } },
    });
  });

  test('keeps every other key of the file, and a stored field the request leaves out', async () => {
    const home = await scratch();
    await Bun.write(
      join(home, 'configuration.json'),
      JSON.stringify({
        skills: { sources: [], trusted: [] },
        plugins: { limited: { configuration: { limit: 2 } } },
      }),
    );
    const host = await startAt(home);

    expect(await statusOf(put(host, '/host/plugins/limited', { enabled: false }))).toBe(200);

    expect(JSON.parse((await configurationText(home)) ?? '{}')).toEqual({
      skills: { sources: [], trusted: [] },
      plugins: { limited: { enabled: false, configuration: { limit: 2 } } },
    });
  });

  test('refuses a configuration its schema rejects, naming the field, and writes nothing', async () => {
    const home = await scratch();
    const host = await startAt(home);

    const response = await put(host, '/host/plugins/limited', { configuration: { limit: 'many' } });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid', field: 'configuration.limit' });
    expect(await configurationText(home)).toBeUndefined();
  });

  test.each([
    ['a plugin that takes none', 'always', { configuration: { anything: 1 } }, 'configuration'],
    ['a required plugin turned off', 'always', { enabled: false }, 'enabled'],
    // COR-1890: Bureau's own tools are the built-in plugin's, so the owner cannot switch it off.
    ['the built-in bureau plugin turned off', 'bureau', { enabled: false }, 'enabled'],
    ['a flag that is not a boolean', 'quiet', { enabled: 'yes' }, 'enabled'],
  ])('refuses %s, and writes nothing', async (_name, plugin, body, field) => {
    const home = await scratch();
    const host = await startAt(home);

    const response = await put(host, `/host/plugins/${plugin}`, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field });
    expect(await configurationText(home)).toBeUndefined();
  });

  test('answers 404 for a plugin it does not load, and writes nothing', async () => {
    const home = await scratch();
    const host = await startAt(home);

    const response = await put(host, '/host/plugins/missing', { enabled: true });

    expect(response.status).toBe(404);
    expect(await configurationText(home)).toBeUndefined();
  });

  test('refuses a file that became invalid instead of overwriting it', async () => {
    const home = await scratch();
    const host = await startAt(home);
    const broken = JSON.stringify({ plugins: { quiet: 3 } });
    await Bun.write(join(home, 'configuration.json'), broken);

    const response = await put(host, '/host/plugins/limited', { enabled: false });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: 'plugins.quiet' });
    expect(await configurationText(home)).toBe(broken);
  });

  test('does not start on a file whose plugins key is malformed', async () => {
    const home = await scratch();
    await Bun.write(join(home, 'configuration.json'), JSON.stringify({ plugins: { quiet: 3 } }));

    const failure = await startAt(home).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({ field: 'plugins.quiet' });
  });

  test('removes a stored configuration when the request gives null', async () => {
    const home = await scratch();
    const host = await startAt(home);
    await put(host, '/host/plugins/limited', { configuration: { limit: 1 } });

    expect(await statusOf(put(host, '/host/plugins/limited', { configuration: null }))).toBe(200);

    expect(JSON.parse((await configurationText(home)) ?? '{}')).toEqual({
      plugins: { limited: {} },
    });
  });
});

describe('PUT /host/plugins/:name/secrets/:key', () => {
  test('refuses a key the plugin does not declare, and writes nothing', async () => {
    const home = await scratch();
    const host = await startAt(home);

    const other = await put(host, '/host/plugins/keyed/secrets/limited-api-key', {
      value: SECRET_VALUE,
    });
    const foreign = await put(host, '/host/plugins/limited/secrets/approval-secret', {
      value: SECRET_VALUE,
    });

    expect(other.status).toBe(400);
    expect(await other.json()).toMatchObject({ error: 'invalid', field: 'key' });
    expect(foreign.status).toBe(400);
    expect(await secretText(home, 'limited-api-key')).toBeUndefined();
    // The host's own secret is the one it made at start, not the value the request carried.
    expect(await secretText(home, 'approval-secret')).not.toContain(SECRET_VALUE);
    expect(await secretText(home, 'approval-secret')).toBeDefined();
  });

  test.each([
    ['a value that is not text', { value: 42 }],
    ['an empty value', { value: '   ' }],
    ['a value with a line break', { value: 'one\ntwo' }],
    ['no value', {}],
  ])('refuses %s, and writes nothing', async (_name, body) => {
    const home = await scratch();
    const host = await startAt(home);

    const response = await put(host, `/host/plugins/keyed/secrets/${KEYED_SECRET}`, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: 'value' });
    expect(await secretText(home, KEYED_SECRET)).toBeUndefined();
  });

  test('moves a needs-setup plugin to running with no restart', async () => {
    const home = await scratch();
    const host = await startAt(home);
    expect(await pluginNamed(host, 'keyed')).toMatchObject({ status: 'needs-setup' });

    const response = await put(host, `/host/plugins/keyed/secrets/${KEYED_SECRET}`, {
      value: SECRET_VALUE,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ plugin: 'keyed', key: KEYED_SECRET, set: true });
    await waitUntil(async () => (await keyedStatus(host)) === 'running', {
      message: 'the keyed plugin to leave needs-setup',
    });
    expect(await pluginNamed(host, 'keyed')).toMatchObject({
      problems: [],
      secrets: [{ key: KEYED_SECRET, set: true }],
    });
  });

  test('writes the secret in a 0600 file and echoes it nowhere', async () => {
    const home = await scratch();
    const host = await startAt(home);
    const response = await put(host, `/host/plugins/keyed/secrets/${KEYED_SECRET}`, {
      value: SECRET_VALUE,
    });
    const answers = [
      await response.text(),
      await textOf(host, '/host/plugins'),
      await textOf(host, '/host/paths'),
      (await configurationText(home)) ?? '',
    ];

    expect(await secretMode(home, KEYED_SECRET)).toBe(0o600);
    expect(await secretText(home, KEYED_SECRET)).toBe(SECRET_VALUE);
    for (const answer of answers) expect(answer).not.toContain(SECRET_VALUE);
  });
});

describe('a secret declared generated', () => {
  test('is created on first start for a plugin that is enabled, in a 0600 file, and never echoed', async () => {
    const home = await scratch();
    const first = await startAt(home);

    const created = await secretText(home, MINTED_SECRET);
    expect(created?.length).toBeGreaterThanOrEqual(64);
    expect(await secretMode(home, MINTED_SECRET)).toBe(0o600);
    const plugins = await standings(first);
    expect(plugins['minted']).toMatchObject({
      status: 'running',
      secrets: [{ key: MINTED_SECRET, generated: true, set: true }],
    });
    expect(JSON.stringify(plugins)).not.toContain(created ?? 'unreachable');
    // A plugin that is not enabled gets nothing yet.
    expect(await secretText(home, LATER_SECRET)).toBeUndefined();
    await first.close();

    // The value made once is the value kept: a restart does not make another.
    await startAt(home);
    expect(await secretText(home, MINTED_SECRET)).toBe(created);
  });

  test('is created when the plugin is first enabled', async () => {
    const home = await scratch();
    const host = await startAt(home);
    expect(await secretText(home, LATER_SECRET)).toBeUndefined();

    expect(await statusOf(put(host, '/host/plugins/later', { enabled: true }))).toBe(200);

    expect(await secretLength(home, LATER_SECRET)).toBeGreaterThanOrEqual(64);
    expect(await secretMode(home, LATER_SECRET)).toBe(0o600);
  });
});

describe('a request from a refused origin', () => {
  test('changes nothing on any of the three routes', async () => {
    const home = await scratch();
    const host = await startAt(home);
    const hostile = { origin: 'http://attacker.example' };
    const before = {
      configuration: await configurationText(home),
      keyed: await secretText(home, KEYED_SECRET),
      later: await secretText(home, LATER_SECRET),
    };

    const answers = [
      await fetch(new URL('/host/plugins', host.url), { headers: hostile }),
      await put(host, '/host/plugins/later', { enabled: true }, hostile),
      await put(
        host,
        `/host/plugins/keyed/secrets/${KEYED_SECRET}`,
        { value: SECRET_VALUE },
        hostile,
      ),
    ];

    expect(answers.map((answer) => answer.status)).toEqual([403, 403, 403]);
    expect({
      configuration: await configurationText(home),
      keyed: await secretText(home, KEYED_SECRET),
      later: await secretText(home, LATER_SECRET),
    }).toEqual(before);
  });
});

describe('a remote home', () => {
  /** A home whose files belong to the deployment: it reads secrets and refuses to write. */
  function remoteHome(environment: Record<string, string> = {}) {
    const writes: string[] = [];
    return {
      writes,
      bungalow: {
        mode: 'remote' as const,
        configurationLocation: 's3://bucket/configuration.json',
        readConfiguration: async () => undefined,
        writeConfiguration: () => {
          writes.push('configuration');
          throw new Error('The remote home cannot be written.');
        },
        readSecret: (key: string) => environment[key],
        writeSecret: () => {
          writes.push('secret');
          throw new Error('The remote home cannot be written.');
        },
        secretLocation: (key: string) =>
          `INTERBOROUGH_SECRET_${key.toUpperCase().replaceAll('-', '_')}`,
      },
    };
  }

  const declaration: PluginSecretDeclaration = { key: MINTED_SECRET, generated: true };
  const minted = (): BureauPluginEntry => ({
    descriptor: definePlugin({
      name: 'minted',
      version: '1.0.0',
      description: 'Gets a signing key from the host.',
      secrets: [declaration],
    }),
    source: 'package',
    location: '@fixture/minted',
  });

  async function manage(environment?: Record<string, string>) {
    const home = remoteHome(environment);
    const manager = await createPluginManager({
      bungalow: home.bungalow,
      plugins: [minted()],
      listing: async () => [],
      reservedSecretKeys: [],
      reservedSecretPrefixes: [],
    });
    return { home, manager };
  }

  test('does not create a generated secret, so the plugin is needs-setup', async () => {
    const { home, manager } = await manage();
    await manager.ensureGeneratedSecrets();
    const bureau = await createBureau({
      plugins: [minted()],
      pluginConfiguration: manager.settings(),
      pluginSecrets: manager.secrets,
    });
    try {
      const [plugin] = await ownPlugins(bureau);

      expect(home.writes).toEqual([]);
      expect(plugin).toMatchObject({
        status: 'needs-setup',
        problems: [{ code: 'secret-missing', key: MINTED_SECRET }],
      });
    } finally {
      await bureau.dispose();
    }
  });

  test('runs a plugin whose deployment sets the secret', async () => {
    const { manager } = await manage({ [MINTED_SECRET]: 'from-the-deployment' });
    const bureau = await createBureau({
      plugins: [minted()],
      pluginConfiguration: manager.settings(),
      pluginSecrets: manager.secrets,
    });
    try {
      const [plugin] = await ownPlugins(bureau);
      expect(plugin?.status).toBe('running');
    } finally {
      await bureau.dispose();
    }
  });

  test('refuses every write with the lock reason, and writes nothing', async () => {
    const { home, manager } = await manage();

    const outcomes = await Promise.allSettled([
      manager.update('minted', { enabled: false }),
      manager.saveSecret('minted', MINTED_SECRET, SECRET_VALUE),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ reason: { reason: 'deployment' } });
    }
    expect(home.writes).toEqual([]);
    const snapshot = await manager.snapshot();
    expect(snapshot.lockReason).toBe('deployment');
  });
});

describe('a secret write that stores the file and then fails', () => {
  /**
   * A local home whose `writeSecret` keeps the value and then throws, as Bungalow's does when the
   * rename lands and the directory sync after it fails: the secret is on disk, the call is an error.
   */
  function flakyHome() {
    const stored = new Map<string, string>();
    return {
      stored,
      bungalow: {
        mode: 'local' as const,
        configurationLocation: '/home/configuration.json',
        readConfiguration: async () => undefined,
        writeConfiguration: () => {},
        readSecret: (key: string) => stored.get(key),
        writeSecret: (key: string, value: string) => {
          stored.set(key, value);
          throw new Error('The directory could not be synced.');
        },
        secretLocation: (key: string) => `/home/secrets/${key}`,
      },
    };
  }

  async function standingOf(plugin: BureauPluginEntry, home: ReturnType<typeof flakyHome>) {
    const manager = await createPluginManager({
      bungalow: home.bungalow,
      plugins: [plugin],
      listing: async () => [],
      reservedSecretKeys: [],
      reservedSecretPrefixes: [],
    });
    const bureau = await createBureau({
      plugins: [plugin],
      pluginConfiguration: manager.settings(),
      pluginSecrets: manager.secrets,
    });
    return { manager, bureau };
  }

  const pluginStatus = async (bureau: Awaited<ReturnType<typeof standingOf>>['bureau']) => {
    const listed = await ownPlugins(bureau);
    return listed[0]?.status;
  };

  test('a saved secret still moves a needs-setup plugin to running, and the save still fails', async () => {
    const home = flakyHome();
    const keyed = fixturePlugins().find((entry) => entry.descriptor.name === 'keyed');
    if (keyed === undefined) throw new Error('The keyed fixture is missing.');
    const { manager, bureau } = await standingOf(keyed, home);
    try {
      expect(await pluginStatus(bureau)).toBe('needs-setup');

      const failure = await manager.saveSecret('keyed', KEYED_SECRET, SECRET_VALUE).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('The directory could not be synced.');
      await waitUntil(async () => (await pluginStatus(bureau)) === 'running', {
        message: 'the keyed plugin to leave needs-setup',
      });
    } finally {
      await bureau.dispose();
    }
  });

  test('a generated secret still moves a needs-setup plugin to running, and generation still fails', async () => {
    const home = flakyHome();
    const minted = fixturePlugins().find((entry) => entry.descriptor.name === 'minted');
    if (minted === undefined) throw new Error('The minted fixture is missing.');
    const { manager, bureau } = await standingOf(minted, home);
    try {
      expect(await pluginStatus(bureau)).toBe('needs-setup');

      const failure = await manager.ensureGeneratedSecrets().then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('The directory could not be synced.');
      await waitUntil(async () => (await pluginStatus(bureau)) === 'running', {
        message: 'the minted plugin to leave needs-setup',
      });
    } finally {
      await bureau.dispose();
    }
  });

  test('the provider-route writer the host hands out notifies the same way', async () => {
    const home = flakyHome();
    const keyed = fixturePlugins().find((entry) => entry.descriptor.name === 'keyed');
    if (keyed === undefined) throw new Error('The keyed fixture is missing.');
    const { manager, bureau } = await standingOf(keyed, home);
    try {
      expect(() => manager.writeSecret(KEYED_SECRET, SECRET_VALUE)).toThrow(
        'The directory could not be synced.',
      );
      await waitUntil(async () => (await pluginStatus(bureau)) === 'running', {
        message: 'the keyed plugin to leave needs-setup',
      });
    } finally {
      await bureau.dispose();
    }
  });
});

describe('/host/paths', () => {
  test('reports the providers the loaded plugins contribute, each with its plugin’s first secret', async () => {
    const home = await scratch();
    const lender: BureauPluginEntry = {
      descriptor: definePlugin({
        name: 'lender',
        version: '1.0.0',
        description: 'Contributes a model provider.',
        secrets: ['lender-api-key'],
        setup: () => ({
          providers: [providerNamed('lender')],
        }),
      }),
      source: 'package',
      location: '@fixture/lender',
    };
    const host = await startAt(home, [lender]);

    const paths = await pathsOf(host);

    expect(paths.providers).toEqual([
      { name: 'lender', secretFile: join(home, 'secrets', 'lender-api-key') },
    ]);
  });

  test('reports the three provider plugins the workspace ships when no plugin list is given', async () => {
    const home = await scratch();
    const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
    hosts.push(host);

    const paths = await pathsOf(host);

    expect(paths.providers).toEqual(
      ['anthropic', 'openai', 'gemini'].map((name) => ({
        name,
        secretFile: join(home, 'secrets', `${name}-api-key`),
      })),
    );
  });
});

describe('the host’s governed memory', () => {
  test('registers the embedders plugins contribute beside the built-in one', () => {
    const memory: GovernedMemory = createHostMemory(new MemoryStorage(), {
      detectors: [],
      embedders: [
        {
          id: 'keyed:tiny',
          embedder: async (texts) => texts.map(() => [0, 0, 0, 1]),
          dimension: 4,
        },
      ],
    });

    expect(memory.embedding.availability('keyed:tiny')).toBe('available');
  });
});
