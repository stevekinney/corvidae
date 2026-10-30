/**
 * COR-1930: the host reads the `toolSources` in `configuration.json`, loads them before the Bureau
 * is built, lists their tools by `<id>__<tool>` with the capability tiers Armorer maps, keeps every
 * credential encrypted, completes an MCP OAuth sign-in on `/host/oauth/callback/<id>`, and records
 * a local command in the audit trail. Every server is in-process on the loopback; every token is
 * made up for the test.
 */
import { ANONYMOUS_LOCAL_OWNER, auditTrailToolSourceOwnerId } from '@lostgradient/bureau';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';
import { ProviderConfigurationError } from './provider-configuration-error.ts';
import { ToolSourceOwnerOnlyError } from './tool-source-manager.ts';
import {
  petsDocument,
  startMcpServer,
  startOAuthMcpServer,
  type TestServer,
} from './tool-source-servers.test-support.ts';

const directories: string[] = [];
const hosts: Host[] = [];
const servers: TestServer[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const server of servers.splice(0)) await server.stop();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-tool-sources-'));
  directories.push(directory);
  return directory;
}

async function startAt(path: string): Promise<Host> {
  const host = await startHost({ environment: { INTERBOROUGH_HOME: path }, port: 0, seed: false });
  hosts.push(host);
  return host;
}

async function restart(host: Host, path: string): Promise<Host> {
  await host.close();
  hosts.splice(hosts.indexOf(host), 1);
  return startAt(path);
}

async function track<Server extends TestServer>(server: Promise<Server>): Promise<Server> {
  const started = await server;
  servers.push(started);
  return started;
}

function send(host: Host, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(new URL(path, host.url), {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

/** Every file under `directory`, read as bytes. */
async function filesUnder(directory: string): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>();
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    found.set(path, Buffer.from(await readFile(path)));
  }
  return found;
}

/** The files under `directory` that hold `needle`, in any of the encodings a store might use. */
async function filesHolding(directory: string, needle: string): Promise<string[]> {
  const encodings = [
    Buffer.from(needle),
    Buffer.from(needle, 'utf16le'),
    Buffer.from(Buffer.from(needle).toString('base64')),
    Buffer.from(Buffer.from(needle).toString('base64url')),
    Buffer.from(Buffer.from(needle).toString('hex')),
  ];
  return [...(await filesUnder(directory))]
    .filter(([, bytes]) => encodings.some((encoded) => bytes.includes(encoded)))
    .map(([path]) => path);
}

/** The sources the host reports now. */
async function sourcesOf(host: Host) {
  const snapshot = await host.toolSources.snapshot();
  return snapshot.sources;
}

/** The first source the host reports now. */
async function firstSourceOf(host: Host) {
  const sources = await sourcesOf(host);
  return sources[0];
}

/** The status a request answered with. */
async function statusOf(work: Promise<Response>): Promise<number> {
  const response = await work;
  return response.status;
}

/** The JSON a request answered with. */
async function jsonOf(work: Promise<Response>): Promise<any> {
  const response = await work;
  return response.json();
}

const BEARER = 'bearer-fixture-9c1d7e';
const API_KEY = 'apikey-fixture-4b8a02';

const mcpSource = (url: string) => ({
  id: 'files',
  kind: 'mcp',
  transport: { type: 'http', url, authentication: { type: 'bearer', credential: 'token' } },
});

const petsSource = {
  id: 'pets',
  kind: 'openapi',
  specification: { type: 'document', document: petsDocument },
  baseUrl: 'http://127.0.0.1:9/',
  authentication: { type: 'api-key', header: 'x-api-key', credential: 'key' },
};

describe('the plaintext scan', () => {
  test('finds a value planted in a file, in the encodings a store might use, so an empty result means something', async () => {
    const path = await home();
    await writeFile(join(path, 'plain.txt'), `x ${BEARER} y`);
    await writeFile(join(path, 'encoded.txt'), Buffer.from(API_KEY).toString('base64'));

    const planted = await filesHolding(path, BEARER);
    expect(planted.map((file) => file.slice(-9))).toEqual(['plain.txt']);
    const encoded = await filesHolding(path, API_KEY);
    expect(encoded.map((file) => file.slice(-11))).toEqual(['encoded.txt']);
    expect(await filesHolding(path, 'never-written')).toEqual([]);
  });
});

describe('saved tool sources', () => {
  test('list the tools of an MCP and an OpenAPI source after a restart, with their tiers, and keep no credential in plaintext', async () => {
    const path = await home();
    const mcp = await track(startMcpServer(BEARER));
    const first = await startAt(path);

    const connectedMcp = await send(first, 'PUT', '/host/tool-sources/files', {
      source: mcpSource(`${mcp.origin}/`),
      credentials: { token: BEARER },
    });
    const connectedPets = await send(first, 'PUT', '/host/tool-sources/pets', {
      source: petsSource,
      credentials: { key: API_KEY },
    });

    expect(connectedMcp.status).toBe(200);
    expect(await connectedMcp.json()).toEqual({
      id: 'files',
      changed: true,
      restartRequired: true,
    });
    expect(connectedPets.status).toBe(200);
    // Not listed yet: the Bureau was built before the change.
    expect(first.bureau.agents.tools().map((tool) => tool.name)).not.toContain('files__lookup');
    const pending: {
      sources: { id: string; state: string; credentials: string[] }[];
    } = await jsonOf(send(first, 'GET', '/host/tool-sources'));
    expect(pending.sources.map((source) => [source.id, source.state, source.credentials])).toEqual([
      ['files', 'pending-restart', ['token']],
      ['pets', 'pending-restart', ['key']],
    ]);

    const second = await restart(first, path);

    const tiers = new Map(second.bureau.agents.tools().map((tool) => [tool.name, tool.tier]));
    expect(tiers.get('files__lookup')).toBe('read-only');
    expect(tiers.get('files__wipe')).toBe('dangerous');
    expect(tiers.get('pets__list-pets')).toBe('read-only');
    expect(tiers.get('pets__create-pet')).toBe('mutating');
    expect(tiers.get('pets__delete-pet')).toBe('dangerous');
    expect(tiers.get('lookup-order')).toBe('read-only');
    // The credential reached the server through the vault, and only as the bearer.
    expect(mcp.authorizations).toContain(`Bearer ${BEARER}`);
    const listed: {
      sources: { id: string; state: string; tools: { name: string; tier: string }[] }[];
    } = await jsonOf(send(second, 'GET', '/host/tool-sources'));
    expect(listed.sources.map((source) => [source.id, source.state])).toEqual([
      ['files', 'loaded'],
      ['pets', 'loaded'],
    ]);
    expect(listed.sources[0]?.tools.map((tool) => tool.name).toSorted()).toEqual([
      'files__lookup',
      'files__wipe',
    ]);

    // No file in the home holds either credential, in any common encoding. The control: the
    // vault's secret is there, and so is the source in the configuration.
    expect(await filesHolding(path, BEARER)).toEqual([]);
    expect(await filesHolding(path, API_KEY)).toEqual([]);
    const present = await filesUnder(path);
    const files = [...present.keys()];
    expect(files.some((file) => file.endsWith(join('secrets', 'tool-source-files')))).toBe(true);
    expect(await readFile(join(path, 'configuration.json'), 'utf8')).toContain('"files"');
  });

  test('one source that cannot load is its own standing and never stops the host or the other source', async () => {
    const path = await home();
    const first = await startAt(path);
    await send(first, 'PUT', '/host/tool-sources/pets', {
      source: petsSource,
      credentials: { key: API_KEY },
    });
    // Nothing listens on port 9, so the connection is refused.
    const unreachable = await send(first, 'PUT', '/host/tool-sources/broken', {
      source: { ...mcpSource('http://127.0.0.1:9/mcp'), id: 'broken' },
      credentials: { token: BEARER },
    });
    expect(unreachable.status).toBe(200);

    const second = await restart(first, path);

    const names = second.bureau.agents.tools().map((tool) => tool.name);
    expect(names).toContain('pets__list-pets');
    const snapshot = await second.toolSources.snapshot();
    const broken = snapshot.sources.find((source) => source.id === 'broken');
    expect(broken?.state).toBe('failed');
    // The reason names no URL and no value.
    expect(broken?.message).not.toContain('127.0.0.1');
    expect(broken?.message).not.toContain(BEARER);
    expect(snapshot.sources.find((source) => source.id === 'pets')?.state).toBe('loaded');
  });

  test('completes an OAuth sign-in on the callback route, stores only ciphertext, and lists the tools after a restart', async () => {
    const path = await home();
    const oauth = await track(startOAuthMcpServer());
    const first = await startAt(path);
    const source = {
      id: 'calendar',
      kind: 'mcp',
      transport: { type: 'http', url: `${oauth.origin}/`, authentication: { type: 'oauth' } },
    };
    await send(first, 'PUT', '/host/tool-sources/calendar', { source });
    // Nothing is contacted until a person signs in.
    expect(await firstSourceOf(first)).toMatchObject({ authorized: false });

    const started = await send(first, 'POST', '/host/tool-sources/calendar/authorize');
    const { authorized, authorizationUrl } = (await started.json()) as {
      authorized: boolean;
      authorizationUrl: string;
    };
    expect(authorized).toBe(false);
    // The browser leg: the authorization server redirects back to this host's callback route.
    const redirect = await fetch(authorizationUrl, { redirect: 'manual' });
    const location = redirect.headers.get('location') ?? '';
    expect(redirect.status).toBe(302);
    expect(new URL(location).origin).toBe(first.url.origin);
    expect(new URL(location).pathname).toBe('/host/oauth/callback/calendar');
    // The verifier and state are stored while the sign-in waits, and are not in plaintext.
    const during = await filesUnder(path);
    expect([...during.keys()].some((file) => file.endsWith('tool-source-calendar'))).toBe(true);

    const callback = await fetch(location);
    expect(callback.status).toBe(200);
    expect(callback.headers.get('cache-control')).toBe('no-store');
    expect(callback.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await callback.text()).not.toContain('code');

    expect(await firstSourceOf(first)).toMatchObject({ authorized: true });
    const token = oauth.issuedAccessTokens[0] ?? '';
    const verifier = oauth.receivedVerifiers[0] ?? '';
    expect(token).not.toBe('');
    expect(verifier).not.toBe('');
    expect(await filesHolding(path, token)).toEqual([]);
    expect(await filesHolding(path, verifier)).toEqual([]);
    // A callback that arrives again has no sign-in waiting, whatever it carries.
    expect(await statusOf(fetch(location))).toBe(400);

    const second = await restart(first, path);

    expect(second.bureau.agents.tools().map((tool) => tool.name)).toContain('calendar__echo');
    expect(await firstSourceOf(second)).toMatchObject({ state: 'loaded' });
    expect(oauth.authorizations).toContain(`Bearer ${token}`);
    expect(await filesHolding(path, token)).toEqual([]);
  });

  test('refuses a callback whose state is not the one the sign-in recorded, and one with no sign-in waiting', async () => {
    const path = await home();
    const oauth = await track(startOAuthMcpServer());
    const host = await startAt(path);
    await send(host, 'PUT', '/host/tool-sources/calendar', {
      source: {
        id: 'calendar',
        kind: 'mcp',
        transport: { type: 'http', url: `${oauth.origin}/`, authentication: { type: 'oauth' } },
      },
    });

    const unsolicited = await fetch(
      new URL('/host/oauth/callback/calendar?code=forged&state=forged', host.url),
    );
    expect(unsolicited.status).toBe(400);

    await send(host, 'POST', '/host/tool-sources/calendar/authorize');
    const forged = await fetch(
      new URL('/host/oauth/callback/calendar?code=forged&state=forged&iss=x', host.url),
    );
    expect(forged.status).toBe(400);
    expect(oauth.issuedAccessTokens).toEqual([]);
    expect(await firstSourceOf(host)).toMatchObject({ authorized: false });
    const unknown = new URL('/host/oauth/callback/unknown?code=a&state=b', host.url);
    expect(await statusOf(fetch(unknown))).toBe(400);
  });

  test('refuses a local command from a principal other than the owner, and audits the owner’s addition with its command line and no environment value', async () => {
    const path = await home();
    const host = await startAt(path);
    const source = {
      id: 'shell',
      kind: 'mcp',
      transport: {
        type: 'stdio',
        command: 'bun',
        args: ['run', 'server.ts', '--name', 'a b'],
        env: { LEVEL: 'plain-env-value' },
        credentialEnv: { TOKEN: 'tok' },
      },
    };
    const request = { id: 'shell', source, credentials: { tok: 'env-secret-value' } };

    const refused = await host.toolSources
      .connect({ ...request, principal: 'user:alice' })
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(ToolSourceOwnerOnlyError);
    expect(await readFile(join(path, 'configuration.json'), 'utf8').catch(() => '')).not.toContain(
      'shell',
    );
    const before = await host.bureau.audit.query({ runId: auditTrailToolSourceOwnerId('shell') });
    expect(before.records).toEqual([]);
    expect(await filesHolding(path, 'env-secret-value')).toEqual([]);

    const added = await host.toolSources.connect({ ...request, principal: ANONYMOUS_LOCAL_OWNER });

    expect(added).toEqual({ id: 'shell', changed: true, restartRequired: true });
    const trail = await host.bureau.audit.query({ runId: auditTrailToolSourceOwnerId('shell') });
    expect(trail.records).toEqual([
      expect.objectContaining({
        type: 'tool.source.connected',
        resource: 'tool-source:shell',
        principal: ANONYMOUS_LOCAL_OWNER,
        detail: {
          sourceId: 'shell',
          kind: 'mcp',
          commandLine: 'bun run server.ts --name "a b"',
        },
      }),
    ]);
    // Neither the environment value nor the credential is in the trail, the configuration's
    // secret, or anywhere the credential would be a plaintext.
    expect(JSON.stringify(trail)).not.toContain('plain-env-value');
    expect(await filesHolding(path, 'env-secret-value')).toEqual([]);
  });

  test('refuses a description URL that is not http or https, or that carries a username or password, naming the field', async () => {
    const host = await startAt(await home());
    const bad = async (url: string) => {
      const response = await send(host, 'PUT', '/host/tool-sources/files', {
        source: mcpSource(url),
        credentials: { token: BEARER },
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    for (const url of [
      'ftp://example.com/mcp',
      'https://user:pass@example.com/mcp',
      'file:///etc/passwd',
      'not a url',
    ]) {
      const refused = await bad(url);
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ error: 'invalid', field: 'source.transport.url' });
      expect(JSON.stringify(refused.body)).not.toContain('example.com');
    }
    const spec = await send(host, 'PUT', '/host/tool-sources/pets', {
      source: {
        ...petsSource,
        specification: { type: 'url', url: 'https://user:pass@example.com/openapi.json' },
      },
      credentials: { key: API_KEY },
    });
    expect(spec.status).toBe(400);
    expect(await spec.json()).toMatchObject({ field: 'source.specification.url' });
  });

  test('removes a source and its credentials', async () => {
    const path = await home();
    const host = await startAt(path);
    await send(host, 'PUT', '/host/tool-sources/pets', {
      source: petsSource,
      credentials: { key: API_KEY },
    });

    const removed = await send(host, 'DELETE', '/host/tool-sources/pets');

    expect(removed.status).toBe(200);
    expect(JSON.parse(await readFile(join(path, 'configuration.json'), 'utf8'))).not.toHaveProperty(
      'toolSources',
    );
    expect(await sourcesOf(host)).toEqual([]);
    expect(await readFile(join(path, 'secrets', 'tool-source-pets'), 'utf8')).toBe('');
    expect(await statusOf(send(host, 'DELETE', '/host/tool-sources/pets'))).toBe(404);
  });

  test('stops the host, naming the field, for a toolSources entry it cannot use', async () => {
    const path = await home();
    await writeFile(
      join(path, 'configuration.json'),
      JSON.stringify({
        toolSources: [{ source: petsSource, tools: { 'list-pets': { acceptsSecret: true } } }],
      }),
    );

    const failure = await startAt(path).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderConfigurationError);
    expect((failure as ProviderConfigurationError).field).toBe(
      'toolSources[0].tools.list-pets.acceptsSecret',
    );
  });

  test('sets acceptsSecrets for a tool on the route, lists it after a restart, and reports a name the server does not list', async () => {
    const path = await home();
    const first = await startAt(path);
    await send(first, 'PUT', '/host/tool-sources/pets', {
      source: petsSource,
      credentials: { key: API_KEY },
    });

    const set = await send(first, 'PUT', '/host/tool-sources/pets/tools', {
      tools: { 'delete-pet': { acceptsSecrets: true }, 'no-such-tool': { acceptsSecrets: true } },
    });
    const invalid = await send(first, 'PUT', '/host/tool-sources/pets/tools', {
      tools: { 'delete-pet': { acceptsSecrets: 'yes' } },
    });
    const missing = await send(first, 'PUT', '/host/tool-sources/nope/tools', { tools: {} });

    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ id: 'pets', changed: true, restartRequired: true });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ field: 'tools.delete-pet.acceptsSecrets' });
    expect(missing.status).toBe(404);

    const second = await restart(first, path);
    const listed: {
      sources: {
        state: string;
        tools: { name: string; acceptsSecrets: boolean }[];
        unmatchedSettings: { tool: string }[];
      }[];
    } = await jsonOf(send(second, 'GET', '/host/tool-sources'));

    expect(listed.sources[0]?.state).toBe('loaded');
    expect(
      Object.fromEntries(
        listed.sources[0]?.tools.map((tool) => [tool.name, tool.acceptsSecrets]) ?? [],
      ),
    ).toEqual({ 'pets__list-pets': false, 'pets__create-pet': false, 'pets__delete-pet': true });
    expect(listed.sources[0]?.unmatchedSettings.map((entry) => entry.tool)).toEqual([
      'no-such-tool',
    ]);
  });
});
