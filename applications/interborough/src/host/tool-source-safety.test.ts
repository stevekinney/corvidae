/**
 * COR-1930 correction: what a saved tool source must not do. A tool name an agent file stores must
 * keep meaning the same tool; a credential must go only to the place it was given for and never to
 * a source that merely reuses an id; a sign-in must be recent, for the source that stands, and
 * finish in turn with every other change; a source that hangs must have its process stopped.
 */
import type { AnswerEncryptionKeys } from '@lostgradient/bureau';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createToolSourceManager,
  SIGN_IN_TIME_TO_LIVE_MILLISECONDS,
  ToolSourceInputError,
  type ToolSourceManager,
  type ToolSourceManagerOptions,
} from './tool-source-manager.ts';
import { keysOf, memoryHome } from './tool-source-memory-home.test-support.ts';
import {
  petsDocument,
  startMcpServer,
  startMcpServerListing,
  startOAuthMcpServer,
  type OAuthMcpServer,
  type TestServer,
} from './tool-source-servers.test-support.ts';
import { createToolSourceVault, toolSourceSecretKey } from './tool-source-vault.ts';

const owner = 'anonymous:local';

type Home = ReturnType<typeof memoryHome>;

const closers: ToolSourceManager[] = [];
const servers: TestServer[] = [];
const directories: string[] = [];
const started: number[] = [];

afterEach(async () => {
  for (const manager of closers.splice(0)) await manager.close();
  for (const server of servers.splice(0)) await server.stop();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  // Whatever a failing test left running.
  for (const pid of started.splice(0)) if (isRunning(pid)) process.kill(pid, 'SIGKILL');
});

function managerOver(
  home: Home,
  keys: AnswerEncryptionKeys,
  extra: Partial<ToolSourceManagerOptions> = {},
): ToolSourceManager {
  const manager = createToolSourceManager({
    bungalow: home.bungalow,
    keys,
    audit: async () => undefined,
    origin: () => 'http://127.0.0.1:1',
    ...extra,
  });
  closers.push(manager);
  return manager;
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** The decrypted secrets a home holds for `id`. */
function secretsOf(home: Home, keys: AnswerEncryptionKeys, id: string) {
  return createToolSourceVault({ bungalow: home.bungalow, keys }).read(id);
}

/** The value of one credential a home holds for `id`. */
async function credentialOf(
  home: Home,
  keys: AnswerEncryptionKeys,
  id: string,
  name: string,
): Promise<string | undefined> {
  const secrets = await secretsOf(home, keys, id);
  return secrets.credentials.get(name);
}

/** The state each source of the manager is in. */
async function standingsOf(manager: ToolSourceManager) {
  const snapshot = await manager.snapshot();
  return snapshot.sources;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('the name an agent file stores', () => {
  async function namesFor(listing: readonly string[]): Promise<Map<string, string>> {
    const token = 'bearer-for-names';
    const server = await startMcpServerListing(token, listing);
    servers.push(server);
    const home = memoryHome();
    const keys = await keysOf();
    const manager = managerOver(home, keys);
    await manager.connect({
      id: 'files',
      source: {
        id: 'files',
        kind: 'mcp',
        transport: {
          type: 'http',
          url: `${server.origin}/`,
          authentication: { type: 'bearer', credential: 'token' },
        },
      },
      credentials: { token },
      principal: owner,
    });
    const booted = managerOver(home, keys);
    await booted.start();
    const [standing] = await standingsOf(booted);
    expect(standing?.state).toBe('loaded');
    expect(standing?.skipped).toEqual([]);
    expect(Object.keys(booted.tools()).sort()).toEqual(
      (standing?.tools ?? []).map((tool) => tool.name).sort(),
    );
    return new Map((standing?.tools ?? []).map((tool) => [tool.tool, tool.name]));
  }

  test('keeps meaning the same tool when the server drops a tool that sanitizes to the same name, or lists them in another order', async () => {
    const both = await namesFor(['foo_bar', 'foo.bar']);
    const reordered = await namesFor(['foo.bar', 'foo_bar']);
    const withoutUnderscored = await namesFor(['foo.bar']);
    const withoutDotted = await namesFor(['foo_bar']);

    expect(both.get('foo_bar')).toBe('files__foo_bar');
    expect(both.get('foo.bar')).toMatch(/^files__foo_bar-[0-9a-f]{8}$/);
    expect(new Set(both.values()).size).toBe(2);
    // Whatever else the server lists, and in whatever order, each tool keeps its name.
    expect(reordered).toEqual(both);
    expect(withoutUnderscored.get('foo.bar')).toBe(both.get('foo.bar'));
    expect(withoutDotted.get('foo_bar')).toBe(both.get('foo_bar'));
    // The name of the tool that was dropped is never taken by the one that remains.
    expect(withoutUnderscored.has('foo_bar')).toBe(false);
    expect([...withoutUnderscored.values()]).not.toContain('files__foo_bar');
  });
});

describe('credentials', () => {
  const pets = (baseUrl = 'http://127.0.0.1:9/') => ({
    id: 'pets',
    kind: 'openapi',
    specification: { type: 'document', document: petsDocument },
    baseUrl,
    authentication: { type: 'api-key', header: 'x-api-key', credential: 'key' },
  });

  test('are dropped when the address of the source changes, unless new ones come with the change', async () => {
    const home = memoryHome();
    const keys = await keysOf();
    const manager = managerOver(home, keys);
    await manager.connect({
      id: 'pets',
      source: pets(),
      credentials: { key: 'key-for-the-first-address' },
      principal: owner,
    });
    const before = home.state.secrets.get(toolSourceSecretKey('pets'));
    const configurationBefore = home.state.configuration;

    const refused = await failureOf(
      manager.connect({ id: 'pets', source: pets('http://127.0.0.1:10/'), principal: owner }),
    );

    expect(refused).toBeInstanceOf(ToolSourceInputError);
    expect((refused as ToolSourceInputError).field).toBe('credentials.key');
    expect(home.state.secrets.get(toolSourceSecretKey('pets'))).toBe(before);
    expect(home.state.configuration).toBe(configurationBefore);

    await manager.connect({
      id: 'pets',
      source: pets('http://127.0.0.1:10/'),
      credentials: { key: 'key-for-the-second-address' },
      principal: owner,
    });
    expect(await credentialOf(home, keys, 'pets', 'key')).toBe('key-for-the-second-address');
  });

  test('are dropped when the kind of the source changes', async () => {
    const home = memoryHome();
    const keys = await keysOf();
    const manager = managerOver(home, keys);
    await manager.connect({
      id: 'pets',
      source: pets(),
      credentials: { key: 'key-for-the-service' },
      principal: owner,
    });
    const mcp = {
      id: 'pets',
      kind: 'mcp',
      transport: {
        type: 'http',
        url: 'http://127.0.0.1:9/',
        authentication: { type: 'bearer', credential: 'key' },
      },
    };

    const refused = await failureOf(manager.connect({ id: 'pets', source: mcp, principal: owner }));
    expect(refused).toBeInstanceOf(ToolSourceInputError);
    expect(await credentialOf(home, keys, 'pets', 'key')).toBe('key-for-the-service');

    await manager.connect({
      id: 'pets',
      source: mcp,
      credentials: { key: 'token-for-the-server' },
      principal: owner,
    });
    expect(await credentialOf(home, keys, 'pets', 'key')).toBe('token-for-the-server');
  });

  test('are kept when only something other than where they go changes', async () => {
    const home = memoryHome();
    const keys = await keysOf();
    const manager = managerOver(home, keys);
    await manager.connect({
      id: 'pets',
      source: pets(),
      credentials: { key: 'key-that-stays' },
      principal: owner,
    });
    await manager.connect({
      id: 'pets',
      source: { ...pets(), allowOperations: ['listPets'] },
      principal: owner,
    });
    expect(await credentialOf(home, keys, 'pets', 'key')).toBe('key-that-stays');
  });

  test('of a source that was removed are not picked up by a new source with the same id', async () => {
    const home = memoryHome();
    const keys = await keysOf();
    const manager = managerOver(home, keys);
    await manager.connect({
      id: 'pets',
      source: pets(),
      credentials: { key: 'key-of-the-removed-source' },
      principal: owner,
    });

    await manager.remove({ id: 'pets', principal: owner });
    expect(home.state.secrets.get(toolSourceSecretKey('pets'))).toBe('');

    const refused = await failureOf(
      manager.connect({ id: 'pets', source: pets(), principal: owner }),
    );
    expect(refused).toBeInstanceOf(ToolSourceInputError);
  });

  test('left behind by a source the configuration no longer lists are not picked up either', async () => {
    const home = memoryHome();
    const keys = await keysOf();
    const manager = managerOver(home, keys);
    await manager.connect({
      id: 'pets',
      source: pets(),
      credentials: { key: 'key-of-the-orphan' },
      principal: owner,
    });
    // The file is edited by hand: the source is gone, its secret is not.
    home.state.configuration = undefined;
    expect(home.state.secrets.get(toolSourceSecretKey('pets'))).not.toBe('');

    const refused = await failureOf(
      manager.connect({ id: 'pets', source: pets(), principal: owner }),
    );
    expect(refused).toBeInstanceOf(ToolSourceInputError);
    expect((refused as ToolSourceInputError).field).toBe('credentials.key');

    // A source that names no credential does not inherit one it never asked for.
    const openPets = { ...pets() } as Record<string, unknown>;
    delete openPets['authentication'];
    await manager.connect({ id: 'pets', source: openPets, principal: owner });
    const afterwards = await secretsOf(home, keys, 'pets');
    expect(afterwards.credentials.size).toBe(0);
  });

  test('and the sign-in with them are dropped when an OAuth source changes address', async () => {
    const home = memoryHome();
    const keys = await keysOf();
    const manager = managerOver(home, keys);
    const oauth = (url: string) => ({
      id: 'calendar',
      kind: 'mcp',
      transport: { type: 'http', url, authentication: { type: 'oauth' } },
    });
    await manager.connect({
      id: 'calendar',
      source: oauth('http://127.0.0.1:9/'),
      principal: owner,
    });
    const vault = createToolSourceVault({ bungalow: home.bungalow, keys });
    await vault.write('calendar', {
      credentials: new Map(),
      oauth: { tokens: { access_token: 'access-for-the-first-server', token_type: 'Bearer' } },
    });

    await manager.connect({
      id: 'calendar',
      source: oauth('http://127.0.0.1:10/'),
      principal: owner,
    });

    const afterwards = await vault.read('calendar');
    expect(afterwards.oauth).toBeUndefined();
  });
});

describe('a source that is replaced while its tools are loaded', () => {
  const bearerSource = (url: string) => ({
    id: 'files',
    kind: 'mcp',
    transport: {
      type: 'http',
      url,
      authentication: { type: 'bearer', credential: 'token' },
    },
  });

  test('never has the replacement’s token sent to the server its tools are still connected to', async () => {
    const first = await startMcpServer('token-for-the-first');
    const second = await startMcpServer('token-for-the-second');
    servers.push(first, second);
    const home = memoryHome();
    const keys = await keysOf();
    await managerOver(home, keys).connect({
      id: 'files',
      source: bearerSource(`${first.origin}/`),
      credentials: { token: 'token-for-the-first' },
      principal: owner,
    });
    const booted = managerOver(home, keys);
    await booted.start();
    const lookup = Object.values(booted.tools()).find((tool) => tool.name === 'lookup');
    expect(lookup).toBeDefined();
    await lookup?.execute({});

    // The same id and credential name, now going to another server with another token.
    await booted.connect({
      id: 'files',
      source: bearerSource(`${second.origin}/`),
      credentials: { token: 'token-for-the-second' },
      principal: owner,
    });
    const refused = await failureOf(Promise.resolve(lookup?.execute({})));

    expect(refused).toBeDefined();
    expect(first.authorizations).not.toContain('Bearer token-for-the-second');
    expect(second.authorizations).toEqual([]);
  });

  test('keeps working with a rotated token when it still goes to the same server', async () => {
    const server = await startMcpServer('token-after-rotation');
    servers.push(server);
    const home = memoryHome();
    const keys = await keysOf();
    const source = bearerSource(`${server.origin}/`);
    await managerOver(home, keys).connect({
      id: 'files',
      source,
      credentials: { token: 'token-after-rotation' },
      principal: owner,
    });
    const booted = managerOver(home, keys);
    await booted.start();
    const lookup = Object.values(booted.tools()).find((tool) => tool.name === 'lookup');

    await booted.connect({
      id: 'files',
      source,
      credentials: { token: 'token-after-rotation' },
      principal: owner,
    });

    expect(await lookup?.execute({})).toBeDefined();
  });

  test('lifts the fence again when the replacement could not be written', async () => {
    const first = await startMcpServer('token-for-the-first');
    servers.push(first);
    const home = memoryHome();
    const keys = await keysOf();
    await managerOver(home, keys).connect({
      id: 'files',
      source: bearerSource(`${first.origin}/`),
      credentials: { token: 'token-for-the-first' },
      principal: owner,
    });
    const booted = managerOver(home, keys);
    await booted.start();
    const lookup = Object.values(booted.tools()).find((tool) => tool.name === 'lookup');

    home.state.configurationFailure = 'before-replacing';
    const failed = await failureOf(
      booted.connect({
        id: 'files',
        source: bearerSource('http://127.0.0.1:9/'),
        credentials: { token: 'token-for-nowhere' },
        principal: owner,
      }),
    );

    expect(failed).toBeInstanceOf(Error);
    expect(await lookup?.execute({})).toBeDefined();
  });

  test('never gives a source re-added by hand elsewhere under the same id to tools loaded for the old one', async () => {
    const first = await startMcpServer('token-for-the-first');
    const second = await startMcpServer('token-for-the-first');
    servers.push(first, second);
    const home = memoryHome();
    const keys = await keysOf();
    await managerOver(home, keys).connect({
      id: 'files',
      source: bearerSource(`${first.origin}/`),
      credentials: { token: 'token-for-the-first' },
      principal: owner,
    });
    const booted = managerOver(home, keys);
    await booted.start();
    const lookup = Object.values(booted.tools()).find((tool) => tool.name === 'lookup');
    expect(await lookup?.execute({})).toBeDefined();

    // The file is edited by hand: the source is dropped and one of the same id points elsewhere.
    const edited = JSON.parse(home.state.configuration ?? '{}') as {
      toolSources: { source: { transport: { url: string } } }[];
    };
    const [entry] = edited.toolSources;
    if (entry === undefined) throw new Error('expected the saved source');
    entry.source.transport.url = `${second.origin}/`;
    home.state.configuration = JSON.stringify(edited);

    const refused = await failureOf(Promise.resolve(lookup?.execute({})));

    expect(refused).toBeDefined();
    expect(second.authorizations).toEqual([]);
  });
});

describe('a source whose stored secret cannot be read', () => {
  test('is repaired by connecting the same OAuth description again, so a fresh sign-in can begin', async () => {
    const home = memoryHome();
    const keys = await keysOf();
    const manager = managerOver(home, keys);
    const source = {
      id: 'calendar',
      kind: 'mcp',
      transport: { type: 'http', url: 'http://127.0.0.1:9/', authentication: { type: 'oauth' } },
    };
    await manager.connect({ id: 'calendar', source, principal: owner });
    home.state.secrets.set(toolSourceSecretKey('calendar'), 'damaged beyond reading');
    expect(await failureOf(secretsOf(home, keys, 'calendar'))).toBeDefined();

    const change = await manager.connect({ id: 'calendar', source, principal: owner });

    expect(change.changed).toBe(true);
    const repaired = await secretsOf(home, keys, 'calendar');
    expect(repaired.oauth).toBeUndefined();
  });
});

/** The first `Location` the authorization server answers with: the callback URL for the browser to return to. */
async function callbackAfterAuthorizing(manager: ToolSourceManager, id: string): Promise<string> {
  const started = await manager.authorize(id);
  if (started.authorized) throw new Error('Expected a sign-in to start.');
  const redirect = await fetch(started.authorizationUrl, { redirect: 'manual' });
  return redirect.headers.get('location') ?? '';
}

describe('a sign-in', () => {
  async function signingIn(extra: Partial<ToolSourceManagerOptions> = {}) {
    const oauth: OAuthMcpServer = await startOAuthMcpServer();
    servers.push(oauth);
    const home = memoryHome();
    const keys = await keysOf();
    const manager = managerOver(home, keys, extra);
    const source = {
      id: 'calendar',
      kind: 'mcp',
      transport: { type: 'http', url: `${oauth.origin}/`, authentication: { type: 'oauth' } },
    };
    await manager.connect({ id: 'calendar', source, principal: owner });
    return { oauth, home, keys, manager, source };
  }

  test('finishes while it is recent, and is refused once it has expired, with the token endpoint never reached', async () => {
    let clock = 1_000_000;
    const { oauth, manager } = await signingIn({ now: () => clock });
    const callback = await callbackAfterAuthorizing(manager, 'calendar');

    clock += SIGN_IN_TIME_TO_LIVE_MILLISECONDS + 1;
    const refused = await failureOf(manager.completeAuthorization('calendar', callback));

    expect(refused).toBeInstanceOf(ToolSourceInputError);
    expect((refused as ToolSourceInputError).field).toBe('callback');
    expect(oauth.issuedAccessTokens).toEqual([]);
    // The expired sign-in is dropped: the same callback finds none waiting.
    clock -= SIGN_IN_TIME_TO_LIVE_MILLISECONDS;
    const replay = await failureOf(manager.completeAuthorization('calendar', callback));
    expect((replay as ToolSourceInputError).message).toContain('no sign-in is waiting');
    expect(oauth.issuedAccessTokens).toEqual([]);
  });

  test('is accepted up to the moment it expires', async () => {
    let clock = 5_000_000;
    const { oauth, manager } = await signingIn({ now: () => clock });
    const callback = await callbackAfterAuthorizing(manager, 'calendar');

    clock += SIGN_IN_TIME_TO_LIVE_MILLISECONDS;
    await manager.completeAuthorization('calendar', callback);

    expect(oauth.issuedAccessTokens).toHaveLength(1);
  });

  test('is refused once the source has been removed, and nothing is stored for it', async () => {
    const { oauth, home, manager } = await signingIn();
    const callback = await callbackAfterAuthorizing(manager, 'calendar');
    await manager.remove({ id: 'calendar', principal: owner });

    const refused = await failureOf(manager.completeAuthorization('calendar', callback));

    expect(refused).toBeInstanceOf(ToolSourceInputError);
    expect(oauth.issuedAccessTokens).toEqual([]);
    expect(home.state.secrets.get(toolSourceSecretKey('calendar'))).toBe('');
  });

  test('is refused once the description it began for has changed, and the sign-in is dropped', async () => {
    const { oauth, home, manager } = await signingIn();
    const callback = await callbackAfterAuthorizing(manager, 'calendar');
    // The file is edited by hand while the person is at the authorization server.
    home.state.configuration = home.state.configuration?.replace('127.0.0.1:', 'localhost:');

    const refused = await failureOf(manager.completeAuthorization('calendar', callback));

    expect(refused).toBeInstanceOf(ToolSourceInputError);
    expect((refused as ToolSourceInputError).message).toContain('changed');
    expect(oauth.issuedAccessTokens).toEqual([]);
    const replay = await failureOf(manager.completeAuthorization('calendar', callback));
    expect((replay as ToolSourceInputError).message).toContain('no sign-in is waiting');
  });

  test('that is still exchanging its code when the source is removed finishes first, so no token outlives the removal', async () => {
    let reached = false;
    let release: () => void = () => undefined;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/token') {
        reached = true;
        await parked;
      }
      return fetch(input, init);
    }) as typeof fetch;
    const { oauth, home, manager } = await signingIn({ fetch: gate });
    const callback = await callbackAfterAuthorizing(manager, 'calendar');

    const completing = manager.completeAuthorization('calendar', callback);
    await waitUntil(() => reached, { message: 'the code exchange to reach the token endpoint' });
    const removing = manager.remove({ id: 'calendar', principal: owner });
    release();
    await completing;
    await removing;

    expect(oauth.issuedAccessTokens).toHaveLength(1);
    // Removed after the sign-in, not before it: nothing was written into the cleared secret.
    expect(home.state.secrets.get(toolSourceSecretKey('calendar'))).toBe('');
    expect(home.state.configuration).not.toContain('calendar');
  });

  test('has its token exchange cancelled at the deadline instead of holding every writer', async () => {
    const expiries: (() => void)[] = [];
    let reached = false;
    const stalled = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== '/token') return fetch(input, init);
      reached = true;
      // Answers only when it is cancelled.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')));
      });
    }) as typeof fetch;
    const { oauth, manager } = await signingIn({
      fetch: stalled,
      schedule: (expire) => {
        expiries.push(expire);
        return () => undefined;
      },
    });
    const callback = await callbackAfterAuthorizing(manager, 'calendar');
    expiries.length = 0;

    const completing = failureOf(manager.completeAuthorization('calendar', callback));
    await waitUntil(() => reached, { message: 'the code exchange to reach the token endpoint' });
    expiries[0]?.();
    const refused = await completing;

    expect(refused).toBeInstanceOf(ToolSourceInputError);
    expect(oauth.issuedAccessTokens).toEqual([]);
    // The queue is free again: another change goes through.
    await manager.remove({ id: 'calendar', principal: owner });
  });
});

describe('a stdio source that never answers', () => {
  async function hangingHome() {
    const directory = await mkdtemp(join(tmpdir(), 'interborough-hang-'));
    directories.push(directory);
    const file = join(directory, 'pids');
    const home = memoryHome();
    const keys = await keysOf();
    await managerOver(home, keys).connect({
      id: 'silent',
      source: {
        id: 'silent',
        kind: 'mcp',
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: [
            '--no-install',
            new URL('./tool-source-hang.test-support.ts', import.meta.url).pathname,
            file,
          ],
        },
      },
      principal: owner,
    });
    const pids = async (): Promise<number[]> => {
      const text = await readFile(file, 'utf8').catch(() => '');
      const found = text.split('\n').filter(Boolean).map(Number);
      started.push(...found);
      return found;
    };
    return { home, keys, pids };
  }

  test('has its process stopped when the load deadline passes, and is reported as not answering', async () => {
    const { home, keys, pids } = await hangingHome();
    const expiries: (() => void)[] = [];
    const manager = managerOver(home, keys, {
      schedule: (expire) => {
        expiries.push(expire);
        return () => undefined;
      },
    });

    const starting = manager.start();
    await waitUntil(
      async () => {
        const found = await pids();
        return found.length > 0;
      },
      { message: 'the source to start its process' },
    );
    // The default is 30 seconds: this is that deadline passing, without waiting for it.
    expiries[0]?.();
    await starting;

    const [standing] = await standingsOf(manager);
    expect(standing).toMatchObject({
      state: 'failed',
      message: 'The source did not answer in time.',
    });
    const everyone = await pids();
    await waitUntil(() => everyone.every((pid) => !isRunning(pid)), {
      message: 'every process the load started to stop',
    });
  });

  test('has its process stopped when the host closes while it is still connecting', async () => {
    const { home, keys, pids } = await hangingHome();
    const manager = managerOver(home, keys, { schedule: () => () => undefined });

    const starting = manager.start();
    await waitUntil(
      async () => {
        const found = await pids();
        return found.length > 0;
      },
      { message: 'the source to start its process' },
    );
    await manager.close();
    await starting;

    const everyone = await pids();
    await waitUntil(() => everyone.every((pid) => !isRunning(pid)), {
      message: 'every process the load started to stop',
    });
  });
});
