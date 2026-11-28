/**
 * COR-1904 — who reaches A2A on the Interborough host. An operator who issues a managed A2A key makes every A2A JSON-RPC call present it, and one who also names
 * the public origin a reverse proxy serves (`INTERBOROUGH_PUBLIC_ORIGIN`) lets a caller with
 * that `Host` reach `/bureau/a2a/*`, `/bureau/assets/*` with the key and `POST /triggers/<workflow>`
 * (COR-2169, the describe at the end of this file), and nothing else. A host with neither is the loopback-only,
 * anonymous host COR-1819 shipped.
 *
 * One table, one row per caller, configuration, credential, and path, each run against the host
 * the row's configuration starts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { rejectionOf } from '@lostgradient/testing';

import { startHost, type Host } from './host.ts';
import { workspacePlugins } from './plugins.ts';
import { fakeProvider, writeProviderHome } from './stub-provider.ts';
import {
  HOOK_SECRET,
  hookPlugin,
  SIGNATURE_HEADER,
  THROW_HEADER,
  type HookPlugin,
} from './trigger-plugin.test-support.ts';
import { provisionA2aKey } from './workspace-home.test-support.ts';

const A2A_KEY = 'valid managed key';
const managedKeys = new WeakMap<Host, string>();
const PUBLIC_ORIGIN = 'https://agents.example.test';
const PUBLIC_HOST = 'agents.example.test';
const MEDIA = 'generated media';
const LOCAL_OWNER = 'anonymous:local';
const A2A_OWNER = 'api-key:a2a';

/** No key and no public origin; a key on loopback only; a key and a public origin. */
type Configuration = 'unkeyed' | 'keyed' | 'public';

type Caller = 'loopback' | 'remote';

type Operation =
  | { readonly kind: 'send'; readonly agent: string }
  | { readonly kind: 'card'; readonly agent: string }
  | { readonly kind: 'rpc'; readonly method: string }
  | { readonly kind: 'get'; readonly path: string }
  /** The content of an asset one owner holds, read at the route generated media names. */
  | { readonly kind: 'asset'; readonly owner: 'a2a' | 'local' }
  | { readonly kind: 'raw-send'; readonly path: string };

type Outcome =
  | { readonly kind: 'task'; readonly owner: string }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'guard' }
  | { readonly kind: 'card' }
  | { readonly kind: 'agents'; readonly view: 'every agent' | 'opted in only' }
  | { readonly kind: 'deployment' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'answered' }
  | { readonly kind: 'media' };

type Row = {
  readonly caller: Caller;
  readonly configurations: readonly Configuration[];
  readonly credential?: string;
  /** An `Origin` header, as a browser attaches to a cross-site request. */
  readonly origin?: string;
  /** The remote caller's `Host`, when it is not the public origin's bare name. */
  readonly hostHeader?: string;
  readonly operation: Operation;
  readonly expected: Outcome;
};

const EVERY: readonly Configuration[] = ['unkeyed', 'keyed', 'public'];
const KEYED: readonly Configuration[] = ['keyed', 'public'];

const ROWS: readonly Row[] = [
  // Loopback with no key: COR-1819's anonymous owner, unchanged.
  {
    caller: 'loopback',
    configurations: ['unkeyed'],
    operation: { kind: 'send', agent: 'open' },
    expected: { kind: 'task', owner: LOCAL_OWNER },
  },
  {
    caller: 'loopback',
    configurations: ['unkeyed'],
    operation: { kind: 'send', agent: 'closed' },
    expected: { kind: 'not-found' },
  },
  // Once a key is configured, an A2A call without it is refused on loopback too (part 1's rule).
  {
    caller: 'loopback',
    configurations: KEYED,
    operation: { kind: 'send', agent: 'open' },
    expected: { kind: 'unauthenticated' },
  },
  {
    caller: 'loopback',
    configurations: KEYED,
    credential: 'not-the-key',
    operation: { kind: 'send', agent: 'open' },
    expected: { kind: 'unauthenticated' },
  },
  {
    caller: 'loopback',
    configurations: KEYED,
    credential: A2A_KEY.slice(0, -1),
    operation: { kind: 'send', agent: 'open' },
    expected: { kind: 'unauthenticated' },
  },
  {
    caller: 'loopback',
    configurations: KEYED,
    credential: A2A_KEY,
    operation: { kind: 'send', agent: 'open' },
    expected: { kind: 'task', owner: A2A_OWNER },
  },
  {
    caller: 'loopback',
    configurations: KEYED,
    credential: A2A_KEY,
    operation: { kind: 'send', agent: 'closed' },
    expected: { kind: 'not-found' },
  },
  // The Interborough pages' own `/bureau/*` calls carry no credential: the owner, whatever is set.
  {
    caller: 'loopback',
    configurations: EVERY,
    operation: { kind: 'rpc', method: 'bureau.agents.list' },
    expected: { kind: 'agents', view: 'every agent' },
  },
  {
    caller: 'loopback',
    configurations: EVERY,
    operation: { kind: 'rpc', method: 'bureau.deployment.get' },
    expected: { kind: 'deployment' },
  },
  {
    caller: 'loopback',
    configurations: EVERY,
    operation: { kind: 'get', path: '/host/paths' },
    expected: { kind: 'answered' },
  },
  // A workspace service key invokes opted-in agents but cannot browse shared definitions.
  {
    caller: 'loopback',
    configurations: KEYED,
    credential: A2A_KEY,
    operation: { kind: 'rpc', method: 'bureau.agents.list' },
    expected: { kind: 'forbidden' },
  },
  {
    caller: 'loopback',
    configurations: KEYED,
    credential: A2A_KEY,
    operation: { kind: 'rpc', method: 'bureau.deployment.get' },
    expected: { kind: 'forbidden' },
  },
  // A remote `Host` with no public origin configured is refused everywhere, as before.
  {
    caller: 'remote',
    configurations: ['unkeyed', 'keyed'],
    operation: { kind: 'send', agent: 'open' },
    expected: { kind: 'guard' },
  },
  {
    caller: 'remote',
    configurations: ['keyed'],
    credential: A2A_KEY,
    operation: { kind: 'send', agent: 'open' },
    expected: { kind: 'guard' },
  },
  {
    caller: 'remote',
    configurations: ['unkeyed', 'keyed'],
    operation: { kind: 'card', agent: 'open' },
    expected: { kind: 'guard' },
  },
  {
    caller: 'remote',
    configurations: ['unkeyed', 'keyed'],
    operation: { kind: 'rpc', method: 'bureau.agents.list' },
    expected: { kind: 'guard' },
  },
  // The public origin reaches A2A with the key, and only A2A.
  {
    caller: 'remote',
    configurations: ['public'],
    operation: { kind: 'send', agent: 'open' },
    expected: { kind: 'unauthenticated' },
  },
  {
    caller: 'remote',
    configurations: ['public'],
    credential: 'not-the-key',
    operation: { kind: 'send', agent: 'open' },
    expected: { kind: 'unauthenticated' },
  },
  {
    caller: 'remote',
    configurations: ['public'],
    credential: A2A_KEY,
    operation: { kind: 'send', agent: 'open' },
    expected: { kind: 'task', owner: A2A_OWNER },
  },
  {
    caller: 'remote',
    configurations: ['public'],
    credential: A2A_KEY,
    operation: { kind: 'send', agent: 'closed' },
    expected: { kind: 'not-found' },
  },
  // The card is public, as the A2A specification has it.
  {
    caller: 'remote',
    configurations: ['public'],
    operation: { kind: 'card', agent: 'open' },
    expected: { kind: 'card' },
  },
  {
    caller: 'remote',
    configurations: ['public'],
    credential: A2A_KEY,
    origin: 'https://attacker.example',
    operation: { kind: 'send', agent: 'open' },
    expected: { kind: 'guard' },
  },
  {
    caller: 'remote',
    configurations: ['public'],
    credential: A2A_KEY,
    operation: { kind: 'rpc', method: 'bureau.agents.list' },
    expected: { kind: 'guard' },
  },
  {
    caller: 'remote',
    configurations: ['public'],
    credential: A2A_KEY,
    operation: { kind: 'rpc', method: 'bureau.deployment.get' },
    expected: { kind: 'guard' },
  },
  {
    caller: 'remote',
    configurations: ['public'],
    credential: A2A_KEY,
    operation: { kind: 'get', path: '/host/paths' },
    expected: { kind: 'guard' },
  },
  {
    caller: 'remote',
    configurations: ['public'],
    credential: A2A_KEY,
    operation: { kind: 'get', path: '/api/workflows' },
    expected: { kind: 'guard' },
  },
  {
    caller: 'remote',
    configurations: ['public'],
    credential: A2A_KEY,
    operation: { kind: 'get', path: '/' },
    expected: { kind: 'guard' },
  },
  // Generated media names `<origin>/bureau/assets/<id>/content`: the key reads its own, and the
  // Bureau's owner check refuses the rest. Without a key the guard refuses, because the Bureau
  // would serve a keyless request as the owner.
  {
    caller: 'loopback',
    configurations: EVERY,
    operation: { kind: 'asset', owner: 'local' },
    expected: { kind: 'media' },
  },
  {
    caller: 'remote',
    configurations: ['keyed'],
    credential: A2A_KEY,
    operation: { kind: 'asset', owner: 'a2a' },
    expected: { kind: 'guard' },
  },
  {
    caller: 'remote',
    configurations: ['public'],
    credential: A2A_KEY,
    operation: { kind: 'asset', owner: 'a2a' },
    expected: { kind: 'media' },
  },
  {
    caller: 'remote',
    configurations: ['public'],
    operation: { kind: 'asset', owner: 'a2a' },
    expected: { kind: 'unauthenticated' },
  },
  {
    caller: 'remote',
    configurations: ['public'],
    operation: { kind: 'asset', owner: 'local' },
    expected: { kind: 'unauthenticated' },
  },
  {
    caller: 'remote',
    configurations: ['public'],
    credential: 'not-the-key',
    operation: { kind: 'asset', owner: 'a2a' },
    expected: { kind: 'unauthenticated' },
  },
  {
    caller: 'remote',
    configurations: ['public'],
    credential: A2A_KEY,
    operation: { kind: 'asset', owner: 'local' },
    expected: { kind: 'not-found' },
  },
  // A proxy may write out the default port; any other port is another address.
  {
    caller: 'remote',
    configurations: ['public'],
    hostHeader: `${PUBLIC_HOST}:443`,
    credential: A2A_KEY,
    operation: { kind: 'send', agent: 'open' },
    expected: { kind: 'task', owner: A2A_OWNER },
  },
  {
    caller: 'remote',
    configurations: ['public'],
    hostHeader: `${PUBLIC_HOST}:8443`,
    credential: A2A_KEY,
    operation: { kind: 'send', agent: 'open' },
    expected: { kind: 'guard' },
  },
  // A path that only reads as A2A before its dot segments are resolved is not A2A.
  {
    caller: 'remote',
    configurations: ['public'],
    credential: A2A_KEY,
    operation: { kind: 'raw-send', path: '/bureau/a2a/../jsonrpc' },
    expected: { kind: 'guard' },
  },
  {
    caller: 'remote',
    configurations: ['public'],
    credential: A2A_KEY,
    operation: { kind: 'raw-send', path: '/assets/../bureau/a2a/open' },
    expected: { kind: 'guard' },
  },
];

const directories: string[] = [];
/** What the table's hosts report: a refused key is reported, and the table's wrong keys are refused. */
const warnings: string[] = [];

afterAll(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const agentFile = (name: string, a2a: boolean) =>
  [
    '---',
    `name: ${name}`,
    'description: An agent the authorization table reaches.',
    'model: anthropic/sonnet',
    `a2a: ${a2a}`,
    '---',
    'You answer briefly.',
    '',
  ].join('\n');

/** A home with a provider, one agent that opts into A2A and one that does not, and maybe a key. */
async function makeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-a2a-authorization-'));
  directories.push(home);
  await writeProviderHome(home);
  await mkdir(join(home, 'agents'), { recursive: true });
  await writeFile(join(home, 'agents', 'open.md'), agentFile('Open', true));
  await writeFile(join(home, 'agents', 'closed.md'), agentFile('Closed', false));
  return home;
}

async function startConfigured(configuration: Configuration): Promise<Host> {
  const home = await makeHome();
  const key = configuration === 'unkeyed' ? undefined : await provisionA2aKey(home);
  const host = await startHost({
    environment: {
      INTERBOROUGH_HOME: home,
      ...(configuration === 'public' ? { INTERBOROUGH_PUBLIC_ORIGIN: PUBLIC_ORIGIN } : {}),
    },
    port: 0,
    resolveProviderGenerate: fakeProvider('Answered.').resolver,
    warn: (message) => warnings.push(message),
  });
  if (key !== undefined) managedKeys.set(host, key);
  return host;
}

// A JSON-RPC body read back from the wire: each outcome reads the shape it needs.
type Json = any;

let sends = 0;
function sendBody(): string {
  sends += 1;
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'SendMessage',
    params: {
      message: { messageId: `authorization-${sends}`, role: 'ROLE_USER', parts: [{ text: 'Hi' }] },
    },
  });
}

function headersOf(row: Row): Record<string, string> {
  return {
    ...(row.caller === 'remote' ? { host: row.hostHeader ?? PUBLIC_HOST } : {}),
    ...(row.credential === undefined ? {} : { 'X-API-Key': row.credential }),
    ...(row.origin === undefined ? {} : { origin: row.origin }),
  };
}

/** A request sent as written, so its dot segments reach the host unresolved. */
async function rawStatus(host: Host, row: Row, path: string): Promise<number> {
  const body = sendBody();
  const head = [
    `POST ${path} HTTP/1.1`,
    `Host: ${row.caller === 'remote' ? PUBLIC_HOST : host.url.host}`,
    'Content-Type: application/json',
    'A2A-Version: 1.0',
    ...(row.credential === undefined ? [] : [`X-API-Key: ${row.credential}`]),
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
  ].join('\r\n');
  const text = await new Promise<string>((resolve, reject) => {
    let received = '';
    void Bun.connect({
      hostname: host.url.hostname,
      port: Number(host.url.port),
      socket: {
        open: (socket) => void socket.write(`${head}\r\n\r\n${body}`),
        data: (_socket, chunk) => void (received += new TextDecoder().decode(chunk)),
        close: () => resolve(received),
        error: (_socket, error) => reject(error),
      },
    });
  });
  return Number(text.split(' ')[1]);
}

/** Whether a 403 is the request guard's, which answers before anything reaches the Bureau. */
async function isGuardRefusal(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  const text = await response.clone().text();
  return text.startsWith('Forbidden:');
}

async function rpcOutcome(response: Response): Promise<Outcome> {
  const body: Json = await response.json();
  if (body.error !== undefined) {
    if (body.error.data?.httpStatus === 403) return { kind: 'forbidden' };
    throw new Error(`unexpected error ${JSON.stringify(body.error)}`);
  }
  if (Array.isArray(body.result.agents) && body.result.id !== undefined) {
    return { kind: 'deployment' };
  }
  const names: string[] = body.result.agents.map((agent: Json) => agent.name);
  if (names.length === 1 && names[0] === 'open') return { kind: 'agents', view: 'opted in only' };
  expect(names).toContain('open');
  expect(names).toContain('closed');
  return { kind: 'agents', view: 'every agent' };
}

async function outcomeOf(host: Host, row: Row): Promise<Outcome> {
  const { operation } = row;
  if (row.credential === A2A_KEY) {
    const key = managedKeys.get(host);
    if (key === undefined) throw new Error('Managed key unavailable for keyed test');
    row = { ...row, credential: key };
  }
  if (operation.kind === 'raw-send') {
    return (await rawStatus(host, row, operation.path)) === 403
      ? { kind: 'guard' }
      : { kind: 'answered' };
  }
  const path =
    operation.kind === 'send'
      ? `/bureau/a2a/${operation.agent}`
      : operation.kind === 'card'
        ? `/bureau/a2a/${operation.agent}/.well-known/agent-card.json`
        : operation.kind === 'rpc'
          ? '/bureau/jsonrpc'
          : operation.kind === 'asset'
            ? `/bureau/assets/${assetIds[operation.owner]}/content`
            : operation.path;
  const init: RequestInit =
    operation.kind === 'send' || operation.kind === 'rpc'
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', ...headersOf(row) },
          body:
            operation.kind === 'send'
              ? sendBody()
              : JSON.stringify({ jsonrpc: '2.0', id: 1, method: operation.method, params: {} }),
        }
      : { headers: headersOf(row) };
  const response = await fetch(new URL(path, host.url), init);
  if (await isGuardRefusal(response)) return { kind: 'guard' };
  if (response.status === 401) return { kind: 'unauthenticated' };
  if (response.status === 404) return { kind: 'not-found' };
  if (operation.kind === 'rpc') return rpcOutcome(response);
  if (operation.kind === 'card') {
    expect(response.status).toBe(200);
    return { kind: 'card' };
  }
  if (operation.kind === 'asset') {
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(MEDIA);
    return { kind: 'media' };
  }
  if (operation.kind === 'get') {
    expect(response.status).toBe(200);
    return { kind: 'answered' };
  }
  const body: Json = await response.json();
  const id = body.result?.task?.id;
  if (typeof id !== 'string') throw new Error(`unexpected answer ${JSON.stringify(body)}`);
  const owner = await host.bureau.ownerOf({ kind: 'run', id });
  return { kind: 'task', owner: owner ?? 'none' };
}

/** The asset each owner holds on the host under test, by the row's owner name. */
let assetIds: Record<'a2a' | 'local', string> = { a2a: '', local: '' };

/** Admits a small text asset as `owner`, as a task's generated media would be. */
async function admitMedia(host: Host, owner: string): Promise<string> {
  const assets = host.bureau.assets;
  if (assets === undefined) throw new Error('The host has no asset service.');
  const admission = await assets.admit(
    {
      source: { kind: 'inline', bytes: new TextEncoder().encode(MEDIA) },
      declaredMediaType: 'text/plain',
    },
    { id: owner },
  );
  await admission.work.result();
  return admission.assetId;
}

function describeRow(row: Row): string {
  const { operation } = row;
  const target =
    operation.kind === 'send' || operation.kind === 'card'
      ? `${operation.kind} ${operation.agent}`
      : operation.kind === 'asset'
        ? `asset of ${operation.owner}`
        : operation.kind === 'rpc'
          ? operation.method
          : `${operation.kind} ${operation.path}`;
  const credential =
    row.credential === undefined
      ? 'no key'
      : row.credential === A2A_KEY
        ? 'the key'
        : `wrong key "${row.credential}"`;
  const origin = row.origin === undefined ? '' : `, Origin ${row.origin}`;
  const hostHeader = row.hostHeader === undefined ? '' : `, Host ${row.hostHeader}`;
  return `${row.caller}${hostHeader}, ${credential}${origin}: ${target} → ${row.expected.kind}`;
}

for (const configuration of EVERY)
  describe(`a host ${configuration === 'unkeyed' ? 'with no A2A key' : configuration === 'keyed' ? 'with an A2A key' : 'with an A2A key and a public origin'}`, () => {
    let host: Host;
    beforeAll(async () => {
      host = await startConfigured(configuration);
      assetIds = {
        a2a: await admitMedia(host, A2A_OWNER),
        local: await admitMedia(host, LOCAL_OWNER),
      };
    });
    afterAll(async () => {
      await host.close();
    });

    for (const row of ROWS.filter((entry) => entry.configurations.includes(configuration))) {
      test(describeRow(row), async () => {
        expect(await outcomeOf(host, row)).toEqual(row.expected);
      });
    }
  });

describe('the public origin', () => {
  test('is the address the Agent Card names', async () => {
    const host = await startConfigured('public');
    try {
      const response = await fetch(
        new URL('/bureau/a2a/open/.well-known/agent-card.json', host.url),
      );
      const card: Json = await response.json();
      expect(card.supportedInterfaces.map((entry: Json) => entry.url)).toEqual([
        `${PUBLIC_ORIGIN}/bureau/a2a/open`,
      ]);
      expect(Object.keys(card.securitySchemes).length).toBeGreaterThan(0);
    } finally {
      await host.close();
    }
  });

  test('without an A2A key stops the host before it listens', async () => {
    const home = await makeHome();

    const failure = await rejectionOf(
      startHost({
        environment: { INTERBOROUGH_HOME: home, INTERBOROUGH_PUBLIC_ORIGIN: PUBLIC_ORIGIN },
        port: 0,
      }),
    );

    expect(String(failure)).toContain('requires a managed A2A key');
  });

  test('revokes managed keys across processes without reopening public A2A', async () => {
    const home = await makeHome();
    const environment = { INTERBOROUGH_HOME: home };
    let now = Date.now();
    const runtime = {
      ...createDefaultRuntimeServices(),
      clock: { now: () => now, nowISO: () => new Date(now).toISOString() },
    };
    let host = await startHost({ environment, runtime, port: 0, plugins: [] });
    const management = (method: string, params: object, credential?: string) =>
      fetch(new URL('/host/api-keys/jsonrpc', host.url), {
        method: 'POST',
        headers: {
          origin: host.url.origin,
          'content-type': 'application/json',
          ...(credential === undefined ? {} : { 'x-api-key': credential }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    const mediaRequest = (id: string, key?: string) =>
      fetch(new URL(`/bureau/assets/${id}/content`, host.url), {
        headers: {
          host: PUBLIC_HOST,
          ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
        },
      });
    const principalWithKey = (key: string) =>
      fetch(new URL('/api/v1/principal', host.url), { headers: { 'x-api-key': key } });
    const openPublic = () =>
      startHost({
        environment: { ...environment, INTERBOROUGH_PUBLIC_ORIGIN: PUBLIC_ORIGIN },
        runtime,
        port: 0,
        plugins: [],
      });
    try {
      const legacyLocal = await principalWithKey('unknown-local-header');
      expect(legacyLocal.status).toBe(200);
      expect(await legacyLocal.json()).toMatchObject({ subject: LOCAL_OWNER });
      const issueResponse = await management('api.keys.issue', {
        subject: 'a2a',
        label: 'Asset reader',
        scopes: ['bureau.assets:read'],
      });
      const { result: issued }: { result: { id: string; secret: string } } =
        await issueResponse.json();
      const unknownAfterIssue = await principalWithKey('unknown-local-header');
      expect(unknownAfterIssue.status).toBe(401);
      const owned = await admitMedia(host, A2A_OWNER);
      const foreign = await admitMedia(host, LOCAL_OWNER);
      await host.close();
      host = await openPublic();
      const ownedMedia = await mediaRequest(owned, issued.secret);
      const foreignMedia = await mediaRequest(foreign, issued.secret);
      const anonymousMedia = await mediaRequest(owned);
      expect(ownedMedia.status).toBe(200);
      expect(foreignMedia.status).toBe(404);
      expect(anonymousMedia.status).toBe(401);
      for (const operation of ['list', 'issue', 'rotate', 'revoke']) {
        const denied = await management(`api.keys.${operation}`, { id: issued.id }, issued.secret);
        expect(denied.status).toBe(403);
      }
      const rotateResponse = await management('api.keys.rotate', { id: issued.id });
      const { result: rotated }: { result: { id: string; secret: string; retiresAt: number } } =
        await rotateResponse.json();
      const rotatedMedia = await mediaRequest(owned, rotated.secret);
      expect(rotatedMedia.status).toBe(200);
      now = rotated.retiresAt;
      const retiredMedia = await mediaRequest(owned, issued.secret);
      expect(retiredMedia.status).toBe(401);
      const revokeResponse = await management('api.keys.revoke', { id: rotated.id });
      const revoked = await revokeResponse.json();
      expect(revoked.result).toEqual({ id: rotated.id, revoked: true });
      const revokedMedia = await mediaRequest(owned, rotated.secret);
      expect(revokedMedia.status).toBe(401);
      await host.close();
      host = await openPublic();
      const restartedRevoked = await mediaRequest(owned, rotated.secret);
      const restartedAnonymous = await mediaRequest(owned);
      expect(restartedRevoked.status).toBe(401);
      expect(restartedAnonymous.status).toBe(401);
      const revokedPrincipal = await principalWithKey(rotated.secret);
      expect(revokedPrincipal.status).toBe(401);
      const card = await fetch(new URL('/bureau/a2a/.well-known/agent-card.json', host.url), {
        headers: { host: PUBLIC_HOST },
      });
      expect(card.status).toBe(200);
    } finally {
      await host.close();
    }
  });

  test.each(['http://agents.example.test', 'https://agents.example.test/a2a', 'not a url'])(
    'that is not an https origin (%s) stops the host',
    async (origin) => {
      const home = await makeHome();

      const failure = await rejectionOf(
        startHost({
          environment: { INTERBOROUGH_HOME: home, INTERBOROUGH_PUBLIC_ORIGIN: origin },
          port: 0,
        }),
      );

      expect(String(failure)).toContain('INTERBOROUGH_PUBLIC_ORIGIN');
    },
  );

  test('named by its old name stops the host with a renamed-to message, whatever the new name holds (COR-2169)', async () => {
    const home = await makeHome();

    for (const environment of [
      { INTERBOROUGH_HOME: home, INTERBOROUGH_A2A_PUBLIC_ORIGIN: PUBLIC_ORIGIN },
      {
        INTERBOROUGH_HOME: home,
        INTERBOROUGH_A2A_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
        INTERBOROUGH_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      },
    ]) {
      const failure = await rejectionOf(startHost({ environment, port: 0 }));
      expect(String(failure)).toContain(
        'INTERBOROUGH_A2A_PUBLIC_ORIGIN was renamed to INTERBOROUGH_PUBLIC_ORIGIN',
      );
    }
  });
});

describe('the A2A key', () => {
  test('is not in a refusal the host reports', async () => {
    const warnings: string[] = [];
    const home = await makeHome();
    const key = await provisionA2aKey(home);
    const host = await startHost({
      environment: { INTERBOROUGH_HOME: home },
      port: 0,
      warn: (message) => warnings.push(message),
    });
    try {
      const response = await fetch(new URL('/bureau/a2a/open', host.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', 'X-API-Key': 'x' },
        body: sendBody(),
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(key);
      expect(warnings.some((warning) => warning.includes('A2A authentication refused'))).toBe(true);
      expect(warnings.join('\n')).not.toContain(key);
    } finally {
      await host.close();
    }
  });
});

/**
 * COR-2169 — `POST /triggers/<workflow-id>` through a real host, its guards and a real plugin that
 * authenticates with `verifyHmacSignature`. The handler's own rows (the cap on a stream, the bytes,
 * the signal, the statuses) are `trigger-routes.test.ts`.
 */
describe('trigger deliveries (COR-2169)', () => {
  /** What a started host collected, besides the host itself. */
  interface TriggerHost {
    readonly host: Host;
    readonly plugin: HookPlugin;
    readonly warnings: string[];
    readonly logs: string[];
  }

  const hostsStarted: Host[] = [];
  let deliveries = 0;

  async function startTriggerHost(configuration: Configuration): Promise<TriggerHost> {
    const home = await makeHome();
    if (configuration !== 'unkeyed') await provisionA2aKey(home);
    await mkdir(join(home, 'workflows'), { recursive: true });
    const steps = [
      {
        kind: 'activity',
        handler: 'agent',
        input: { agent: 'open', message: 'a delivery arrived' },
      },
    ];
    const files = {
      hook: { trigger: { kind: 'hooks:hook' } },
      paused: { trigger: { kind: 'hooks:hook' }, paused: true },
      waiting: { trigger: { kind: 'gated:hook' } },
      scheduled: { trigger: { kind: 'schedule', spec: '1h' } },
    };
    for (const [name, definition] of Object.entries(files)) {
      await writeFile(
        join(home, 'workflows', `${name}.json`),
        JSON.stringify({ name, agent: 'open', steps, ...definition }),
      );
    }
    const plugin = hookPlugin();
    const warnings: string[] = [];
    const logs: string[] = [];
    const host = await startHost({
      environment: {
        INTERBOROUGH_HOME: home,
        ...(configuration === 'public' ? { INTERBOROUGH_PUBLIC_ORIGIN: PUBLIC_ORIGIN } : {}),
      },
      port: 0,
      plugins: [...workspacePlugins(), ...plugin.entries],
      resolveProviderGenerate: fakeProvider('Answered.').resolver,
      warn: (message) => warnings.push(message),
      log: (message) => logs.push(message),
    });
    hostsStarted.push(host);
    await host.bureau.workflows?.refresh();
    return { host, plugin, warnings, logs };
  }

  afterAll(async () => {
    for (const host of hostsStarted.splice(0)) await host.close();
  });

  const signed = (body: string | Uint8Array): string =>
    `sha256=${createHmac('sha256', HOOK_SECRET).update(body).digest('hex')}`;

  interface Delivery {
    readonly path?: string;
    readonly method?: string;
    readonly body?: string | Uint8Array<ArrayBuffer>;
    readonly signature?: string | null;
    /** The `Host` header; the public origin's when the caller comes through the proxy. */
    readonly host?: string;
    readonly headers?: Record<string, string>;
  }

  async function deliver(
    { host }: TriggerHost,
    {
      path = '/triggers/hook',
      method = 'POST',
      // A body of its own: the plugin keys a delivery by the digest of its signed bytes.
      body = `{"event":"push","delivery":${(deliveries += 1)}}`,
      ...rest
    }: Delivery = {},
  ): Promise<{ status: number; text: string; response: Response }> {
    const signature = rest.signature === undefined ? signed(body) : rest.signature;
    const response = await fetch(new URL(path, host.url), {
      method,
      headers: {
        ...(rest.host === undefined ? {} : { host: rest.host }),
        ...(signature === null ? {} : { [SIGNATURE_HEADER]: signature }),
        ...rest.headers,
      },
      ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
    });
    return { status: response.status, text: await response.text(), response };
  }

  /** A request written to the socket as given, with no body unless one is given. */
  async function raw(
    { host }: TriggerHost,
    lines: readonly string[],
    body = '',
  ): Promise<{ status: number; text: string }> {
    const head = [...lines, 'Connection: close'].join('\r\n');
    const text = await new Promise<string>((resolve, reject) => {
      let received = '';
      void Bun.connect({
        hostname: host.url.hostname,
        port: Number(host.url.port),
        socket: {
          open: (socket) => void socket.write(`${head}\r\n\r\n${body}`),
          data: (_socket, chunk) => void (received += new TextDecoder().decode(chunk)),
          close: () => resolve(received),
          error: (_socket, error) => reject(error),
        },
      });
    });
    return {
      status: Number(text.split(' ')[1]),
      text: text.slice(text.indexOf('\r\n\r\n') + 4),
    };
  }

  const runsOf = async ({ host }: TriggerHost, workflow = 'hook'): Promise<number> => {
    const page = await host.bureau.workflows?.listRuns({ workflow, limit: 50, offset: 0 });
    return page?.runs.length ?? 0;
  };

  describe('on loopback, and through the public origin', () => {
    let served: TriggerHost;
    beforeAll(async () => {
      served = await startTriggerHost('public');
    });

    test('a correctly signed delivery reaches receive on loopback and starts a run', async () => {
      const before = await runsOf(served);
      const answer = await deliver(served, { headers: { 'x-delivery': 'loopback-1' } });
      expect(answer.status).toBe(202);
      expect(JSON.parse(answer.text)).toMatchObject({ outcome: 'started' });
      expect(await runsOf(served)).toBe(before + 1);
      expect(
        served.host.routeInventory.find((e) => e.key === 'POST /triggers/:workflow'),
      ).toMatchObject({
        resourceClass: 'deployment-operator',
        admission: 'trigger-receive',
      });
    });

    test('a correctly signed delivery reaches receive through the public origin, with no key', async () => {
      const body = '{"event":"push","delivery":"public-1"}';
      const answer = await deliver(served, { host: PUBLIC_HOST, body });
      expect(answer.status).toBe(202);
      expect(JSON.parse(answer.text)).toMatchObject({ outcome: 'started' });
      // The same signed delivery again is one run: the key is a digest of the signed bytes, so a
      // replay cannot change it, and a header it adds or drops does not matter.
      const again = await deliver(served, {
        host: PUBLIC_HOST,
        body,
        headers: { 'x-delivery': 'a-new-header' },
      });
      expect(JSON.parse(again.text)).toMatchObject({ outcome: 'duplicate' });
      const bare = await deliver(served, { host: PUBLIC_HOST, body });
      expect(JSON.parse(bare.text)).toMatchObject({ outcome: 'duplicate' });
    });

    test('the origin the public host names is accepted, a foreign Origin is not', async () => {
      const own = await deliver(served, {
        host: PUBLIC_HOST,
        headers: { origin: PUBLIC_ORIGIN, 'x-delivery': 'public-origin' },
      });
      expect(own.status).toBe(202);
      const before = served.plugin.contexts.length;
      for (const row of [
        { host: PUBLIC_HOST, headers: { origin: 'https://attacker.example' } },
        { headers: { origin: 'https://attacker.example' } },
        { headers: { origin: PUBLIC_ORIGIN } },
      ]) {
        const answer = await deliver(served, row);
        expect(answer.status).toBe(403);
        expect(answer.text.startsWith('Forbidden:')).toBe(true);
      }
      expect(served.plugin.contexts).toHaveLength(before);
    });

    test('verifies the bytes it was sent: a body that is not UTF-8 arrives intact', async () => {
      const bytes = Uint8Array.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0x7f, 0x01]);
      const answer = await deliver(served, {
        body: bytes,
        headers: { 'content-type': 'application/octet-stream', 'x-delivery': 'bytes-1' },
      });
      expect(answer.status).toBe(202);
      expect(served.plugin.verified.at(-1)).toEqual(bytes);
    });

    test('a missing or wrong signature is the plugin’s refusal, and starts nothing', async () => {
      const before = await runsOf(served);
      for (const signature of [null, 'sha256=', signed('another body')]) {
        const answer = await deliver(served, { signature });
        expect(answer.status).toBe(401);
        expect(answer.text).toBe('signature refused');
      }
      expect(await runsOf(served)).toBe(before);
    });

    test('a percent-encoded identifier is the decoded one, and one that names no workflow is a 404 that touches nothing', async () => {
      const decoded = await deliver(served, {
        path: '/triggers/ho%6Fk',
        headers: { 'x-delivery': 'enc-1' },
      });
      expect(decoded.status).toBe(202);
      const before = served.plugin.contexts.length;
      for (const host of [undefined, PUBLIC_HOST]) {
        for (const path of ['/triggers/hook%00', '/triggers/%20']) {
          const answer = await deliver(served, { path, ...(host === undefined ? {} : { host }) });
          expect(answer.status, path).toBe(404);
          expect(answer.text, path).toBe('');
        }
      }
      // An encoded slash decodes to an identifier that names no workflow on loopback; through the
      // public origin the guard refuses it before the router decodes it.
      const slash = '/triggers/..%2Fhost%2Fstatus';
      const local = await deliver(served, { path: slash });
      expect([local.status, local.text]).toEqual([404, '']);
      const remote = await deliver(served, { path: slash, host: PUBLIC_HOST });
      expect(remote.status).toBe(403);
      expect(served.plugin.contexts).toHaveLength(before);
    });

    test('an unknown workflow, one whose trigger does not receive, and one whose plugin needs setup answer with a status and no body', async () => {
      const before = served.plugin.contexts.length;
      const unknown = await deliver(served, { path: '/triggers/ghost' });
      const scheduled = await deliver(served, { path: '/triggers/scheduled' });
      const waiting = await deliver(served, { path: '/triggers/waiting' });
      expect([unknown.status, scheduled.status, waiting.status]).toEqual([404, 405, 503]);
      expect([unknown.text, scheduled.text, waiting.text]).toEqual(['', '', '']);
      for (const { response } of [unknown, scheduled, waiting]) {
        // The server adds the length and the date; nothing says what the answer is about.
        expect([...response.headers.keys()].toSorted()).toEqual(['content-length', 'date']);
        expect(response.headers.get('content-length')).toBe('0');
      }
      expect(served.plugin.contexts).toHaveLength(before);
      // The setup refusal names the workflow and the error, never the secret's name or any text.
      const lines = served.warnings
        .filter((warning) => warning.includes('host.trigger.failure'))
        .map((warning) => JSON.parse(warning));
      expect(lines).toContainEqual({
        event: 'host.trigger.failure',
        workflow: 'waiting',
        error: 'PluginNeedsSetupError',
      });
      expect(JSON.stringify(lines)).not.toContain('gated-token');
    });

    test('a paused workflow still calls receive: the plugin answers, its fire is skipped, and no run starts', async () => {
      const answer = await deliver(served, {
        path: '/triggers/paused',
        headers: { 'x-delivery': 'p-1' },
      });
      expect(answer.status).toBe(202);
      expect(JSON.parse(answer.text)).toEqual({ outcome: 'skipped', reason: 'paused' });
      expect(await runsOf(served, 'paused')).toBe(0);
    });

    test('M57: a thrown error’s text, the secret and the signature appear in no response, log line or event', async () => {
      const signature = signed('{"event":"push"}');
      const answer = await deliver(served, { signature, headers: { [THROW_HEADER]: '1' } });
      expect(answer.status).toBe(500);
      expect(answer.text).toBe('');
      expect([...answer.response.headers.keys()].toSorted()).toEqual(['content-length', 'date']);
      await served.host.bureau.internals.taskRegistry.flush();
      const envelopes: unknown[] = [];
      for await (const envelope of served.host.bureau.internals.eventFeed.feed.replay()) {
        envelopes.push(envelope);
      }
      const everything = JSON.stringify([
        answer.text,
        [...answer.response.headers],
        served.warnings,
        served.logs,
        envelopes,
        await served.host.bureau.plugins.list(),
      ]);
      for (const canary of [HOOK_SECRET, signature, 'delivery failed']) {
        expect(everything).not.toContain(canary);
      }
      expect(
        served.warnings
          .filter((warning) => warning.includes('host.trigger.failure'))
          .map((warning) => JSON.parse(warning)),
      ).toContainEqual({ event: 'host.trigger.failure', workflow: 'hook', error: 'Error' });
    });

    test('M54: a Content-Length over 4 MiB is answered 413 before any body is read, and receive is not called', async () => {
      const before = served.plugin.contexts.length;
      for (const hostHeader of [served.host.url.host, PUBLIC_HOST]) {
        const answer = await raw(served, [
          'POST /triggers/hook HTTP/1.1',
          `Host: ${hostHeader}`,
          `Content-Length: ${4 * 1024 * 1024 + 1}`,
        ]);
        expect(answer.status).toBe(413);
        expect(answer.text).toBe('');
      }
      expect(served.plugin.contexts).toHaveLength(before);
    });

    test('every other path and method through the public origin is still refused by the guard', async () => {
      const before = served.plugin.contexts.length;
      const refusals: Array<[string, string]> = [
        ['GET', '/triggers/hook'],
        ['PUT', '/triggers/hook'],
        ['DELETE', '/triggers/hook'],
        ['POST', '/triggers/a/b'],
        ['POST', '/triggers'],
        ['POST', '/host/status'],
        ['POST', '/host/restart'],
        ['GET', '/host/status'],
        ['GET', '/host/session'],
        ['GET', '/api/runs'],
        ['POST', '/bureau/jsonrpc'],
        ['GET', '/'],
        ['GET', '/openrpc.json'],
      ];
      for (const [method, path] of refusals) {
        const answer = await deliver(served, { method, path, host: PUBLIC_HOST, signature: null });
        expect(answer.status, `${method} ${path}`).toBe(403);
        expect(answer.text.startsWith('Forbidden:'), `${method} ${path}`).toBe(true);
      }
      expect(served.plugin.contexts).toHaveLength(before);
    });

    // A guard and the handler it protects must see one path: a request whose raw target is
    // ambiguous (a dot segment, an encoded dot, slash or backslash, a double slash) is refused by
    // the guard before any prefix is stripped, whatever it resolves to.
    // Which check refuses a target is part of the row. Bun resolves dot segments, `%2e` segments
    // and literal backslashes in `request.url` before the guard reads it, so a target that holds
    // only those arrives as the path it resolves to, which no public surface admits, and the
    // loopback-Host check refuses it; a target with an encoded slash or backslash or a double slash
    // arrives as written, and the ambiguous-path check refuses it. Each text names the check that
    // would be missing if a row failed.
    const AMBIGUOUS_PATH = 'Forbidden: this path is not accepted.';
    const LOOPBACK_HOST = 'Forbidden: this host answers only to its own address.';
    const AMBIGUOUS_TARGETS: ReadonlyArray<readonly [string, string]> = [
      ['/bureau/../triggers/x', LOOPBACK_HOST],
      ['/bureau/a2a/../../triggers/x', LOOPBACK_HOST],
      ['/bureau/%2e%2e/triggers/x', LOOPBACK_HOST],
      ['/bureau/%2E%2E/triggers/x', LOOPBACK_HOST],
      ['/bureau/%2e%2E/triggers/x', LOOPBACK_HOST],
      ['/bureau/./../triggers/x', LOOPBACK_HOST],
      ['/triggers/../bureau/jsonrpc', LOOPBACK_HOST],
      ['/triggers/x/../../bureau/jsonrpc', LOOPBACK_HOST],
      ['/triggers/%2e%2e/bureau/jsonrpc', LOOPBACK_HOST],
      // No route matches a double slash under /triggers, so the loopback guard answers the fallback.
      ['/triggers//x', LOOPBACK_HOST],
      ['/bureau//triggers/x', AMBIGUOUS_PATH],
      ['/bureau/a2a//open', AMBIGUOUS_PATH],
      ['/triggers/x%2f..%2f..%2fbureau%2fjsonrpc', AMBIGUOUS_PATH],
      ['/triggers/x%2F..%2F..%2Fbureau%2Fjsonrpc', AMBIGUOUS_PATH],
      ['/triggers/x%5c..%5cbureau', AMBIGUOUS_PATH],
      ['/bureau/assets/..%2fjsonrpc', AMBIGUOUS_PATH],
      ['http://agents.example.test/bureau/../triggers/x', LOOPBACK_HOST],
      ['http://agents.example.test/triggers/../bureau/jsonrpc', LOOPBACK_HOST],
    ];

    test.each(AMBIGUOUS_TARGETS)(
      'an ambiguous target %p is refused by the guard before the Bureau or receive',
      async (target, refusal) => {
        const before = served.plugin.contexts.length;
        const answer = await raw(
          served,
          [`POST ${target} HTTP/1.1`, `Host: ${PUBLIC_HOST}`, 'Content-Length: 0'],
          '',
        );
        // The guard's own 403: Bureau's answer to a path it was handed would be a 404 or a 200.
        expect(answer.status).toBe(403);
        expect(answer.text).toBe(refusal);
        expect(served.plugin.contexts).toHaveLength(before);
      },
    );

    test('the positive rows hold: a trigger delivery, an A2A card and an asset behave as before', async () => {
      const delivered = await deliver(served, {
        host: PUBLIC_HOST,
        headers: { 'x-delivery': 'rows-1' },
      });
      expect(delivered.status).toBe(202);
      const card = await fetch(
        new URL('/bureau/a2a/open/.well-known/agent-card.json', served.host.url),
        {
          headers: { host: PUBLIC_HOST },
        },
      );
      expect(card.status).toBe(200);
      const asset = await fetch(new URL('/bureau/assets/none/content', served.host.url), {
        headers: { host: PUBLIC_HOST },
      });
      // An asset needs a credential at the guard: 401 here, never the 403 of a refused path.
      expect(asset.status).toBe(401);
    });
  });

  describe('a host with an A2A key and no public origin', () => {
    test('refuses the public Host for a trigger delivery, and still serves loopback', async () => {
      const served = await startTriggerHost('keyed');
      const refused = await deliver(served, { host: PUBLIC_HOST });
      expect(refused.status).toBe(403);
      expect(refused.text.startsWith('Forbidden:')).toBe(true);
      const local = await deliver(served);
      expect(local.status).toBe(202);
    });
  });

  describe('the session, CSRF and A2A-key guards of every other route are unchanged', () => {
    test('a cross-site page cannot post to loopback, and a request with no Origin is a local one', async () => {
      const served = await startTriggerHost('unkeyed');
      const forged = await deliver(served, {
        headers: { origin: 'https://attacker.example', 'x-delivery': 'csrf' },
      });
      expect(forged.status).toBe(403);
      for (const path of ['/host/status', '/host/session', '/api/agents']) {
        const crossSite = await fetch(new URL(path, served.host.url), {
          headers: { origin: 'https://attacker.example' },
        });
        expect(crossSite.status, path).toBe(403);
        const remote = await fetch(new URL(path, served.host.url), {
          headers: { host: PUBLIC_HOST },
        });
        expect(remote.status, path).toBe(403);
      }
    });
  });
});
