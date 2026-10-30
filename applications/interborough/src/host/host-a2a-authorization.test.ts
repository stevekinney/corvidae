/**
 * COR-1904 — who reaches A2A on the Interborough host. An operator who stores an A2A key (the
 * Bungalow secret `a2a-api-key`) makes every A2A JSON-RPC call present it, and one who also names
 * the public origin a reverse proxy serves (`INTERBOROUGH_A2A_PUBLIC_ORIGIN`) lets a caller with
 * that `Host` reach `/bureau/a2a/*`, and nothing else. A host with neither is the loopback-only,
 * anonymous host COR-1819 shipped.
 *
 * One table, one row per caller, configuration, credential, and path, each run against the host
 * the row's configuration starts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openBungalow } from '@lostgradient/bungalow';
import { rejectionOf } from '@lostgradient/testing';

import { fakeProvider, writeProviderHome } from './fake-provider.test-support.ts';
import { startHost, type Host } from './host.ts';

/** The operator's A2A key. The secret file ends in a newline, as one written by `echo` does. */
const A2A_KEY = 'host-a2a-key-0123456789';
const PUBLIC_ORIGIN = 'https://agents.example.test';
const PUBLIC_HOST = 'agents.example.test';
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
  | { readonly kind: 'answered' };

type Row = {
  readonly caller: Caller;
  readonly configurations: readonly Configuration[];
  readonly credential?: string;
  /** An `Origin` header, as a browser attaches to a cross-site request. */
  readonly origin?: string;
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
  // The A2A key is not an operator: it sees only the agents that opt in (part 1's rules).
  {
    caller: 'loopback',
    configurations: KEYED,
    credential: A2A_KEY,
    operation: { kind: 'rpc', method: 'bureau.agents.list' },
    expected: { kind: 'agents', view: 'opted in only' },
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
async function makeHome(key: string | undefined): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-a2a-authorization-'));
  directories.push(home);
  await writeProviderHome(home);
  await mkdir(join(home, 'agents'), { recursive: true });
  await writeFile(join(home, 'agents', 'open.md'), agentFile('Open', true));
  await writeFile(join(home, 'agents', 'closed.md'), agentFile('Closed', false));
  if (key !== undefined) {
    const bungalow = await openBungalow({
      name: 'interborough',
      environment: { INTERBOROUGH_HOME: home },
    });
    try {
      bungalow.writeSecret('a2a-api-key', key);
    } finally {
      bungalow.close();
    }
  }
  return home;
}

async function startConfigured(configuration: Configuration): Promise<Host> {
  const home = await makeHome(configuration === 'unkeyed' ? undefined : `${A2A_KEY}\n`);
  return startHost({
    environment: {
      INTERBOROUGH_HOME: home,
      ...(configuration === 'public' ? { INTERBOROUGH_A2A_PUBLIC_ORIGIN: PUBLIC_ORIGIN } : {}),
    },
    port: 0,
    seed: false,
    resolveProviderGenerate: fakeProvider('Answered.').resolver,
    warn: (message) => warnings.push(message),
  });
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
    ...(row.caller === 'remote' ? { host: PUBLIC_HOST } : {}),
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

function describeRow(row: Row): string {
  const { operation } = row;
  const target =
    operation.kind === 'send' || operation.kind === 'card'
      ? `${operation.kind} ${operation.agent}`
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
  return `${row.caller}, ${credential}${origin}: ${target} → ${row.expected.kind}`;
}

for (const configuration of EVERY)
  describe(`a host ${configuration === 'unkeyed' ? 'with no A2A key' : configuration === 'keyed' ? 'with an A2A key' : 'with an A2A key and a public origin'}`, () => {
    let host: Host;
    beforeAll(async () => {
      host = await startConfigured(configuration);
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
    const home = await makeHome(undefined);

    const failure = await rejectionOf(
      startHost({
        environment: { INTERBOROUGH_HOME: home, INTERBOROUGH_A2A_PUBLIC_ORIGIN: PUBLIC_ORIGIN },
        port: 0,
        seed: false,
      }),
    );

    expect(String(failure)).toContain('a2a-api-key');
  });

  test.each(['http://agents.example.test', 'https://agents.example.test/a2a', 'not a url'])(
    'that is not an https origin (%s) stops the host',
    async (origin) => {
      const home = await makeHome(A2A_KEY);

      const failure = await rejectionOf(
        startHost({
          environment: { INTERBOROUGH_HOME: home, INTERBOROUGH_A2A_PUBLIC_ORIGIN: origin },
          port: 0,
          seed: false,
        }),
      );

      expect(String(failure)).toContain('INTERBOROUGH_A2A_PUBLIC_ORIGIN');
    },
  );
});

describe('the A2A key', () => {
  test('that is blank stops the host, and is never echoed', async () => {
    const home = await makeHome('  \n');

    const failure = await rejectionOf(
      startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0, seed: false }),
    );

    expect(String(failure)).toContain('a2a-api-key');
  });

  test('is not in a refusal the host reports', async () => {
    const warnings: string[] = [];
    const home = await makeHome(A2A_KEY);
    const host = await startHost({
      environment: { INTERBOROUGH_HOME: home },
      port: 0,
      seed: false,
      warn: (message) => warnings.push(message),
    });
    try {
      const response = await fetch(new URL('/bureau/a2a/open', host.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', 'X-API-Key': 'x' },
        body: sendBody(),
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(A2A_KEY);
      expect(warnings.some((warning) => warning.includes('A2A authentication refused'))).toBe(true);
      expect(warnings.join('\n')).not.toContain(A2A_KEY);
    } finally {
      await host.close();
    }
  });
});
