/**
 * COR-1931: removing a saved tool source. The owner previews the agent files that name its tools,
 * removal answers the same list and audits it, no agent file is edited, and after the host starts
 * again each affected agent reads `invalid` with `unknown-tool` until the tool is detached. The
 * source's encrypted credential and any OAuth state of a sign-in in progress are cleared with it.
 * Every server is in-process on the loopback; every token is made up for the test.
 */
import { openBungalow } from '@lostgradient/bungalow';
import { auditTrailToolSourceOwnerId } from '@lostgradient/bureau';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enableDemoPlugin, pluginsWithUnseededDemo } from './demo-plugin.test-support.ts';
import { filesUnder } from './files-under.test-support.ts';
import { startHost, type Host } from './host.ts';
import {
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

const BEARER = 'bearer-fixture-removal-5d2f31';

/** A home with a model provider, so an agent file is valid until a check about its tools fails. */
async function home(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-tool-source-removal-'));
  directories.push(directory);
  await writeFile(
    join(directory, 'configuration.json'),
    JSON.stringify({ plugins: { anthropic: { configuration: { models: ['sonnet'] } } } }),
  );
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: directory },
  });
  try {
    bungalow.writeSecret('anthropic-api-key', 'fixture-anthropic-key-removal-31ce');
  } finally {
    bungalow.close();
  }
  return directory;
}

async function startAt(path: string): Promise<Host> {
  await enableDemoPlugin(path);
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: path },
    port: 0,
    plugins: pluginsWithUnseededDemo(),
  });
  hosts.push(host);
  return host;
}

async function restart(host: Host, path: string): Promise<Host> {
  await host.close();
  hosts.splice(hosts.indexOf(host), 1);
  return startAt(path);
}

function send(host: Host, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(new URL(path, host.url), {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

const agentFile = (frontmatter: string[]) =>
  ['---', 'model: anthropic/sonnet', ...frontmatter, '---', 'Help.', ''].join('\n');

/** The agent files, by name, exactly as a test writes them. */
const AGENT_FILES: Record<string, string> = {
  // Lists a tool of the source and approves it: valid before the removal.
  'reader.md': agentFile([
    'tools: [files__lookup, demo:lookup-order]',
    'toolApproval: { files__lookup: always }',
  ]),
  // Names a tool of the source only in toolApproval. It was already invalid, and still names it.
  'approver.md': agentFile([
    'tools: [demo:lookup-order]',
    'toolApproval: { files__wipe: blocked }',
  ]),
  // Names no tool of the source.
  'bystander.md': agentFile(['tools: [demo:lookup-order]']),
  'plain.md': agentFile([]),
};

async function writeAgents(path: string, host: Host): Promise<void> {
  await mkdir(join(path, 'agents'), { recursive: true });
  for (const [name, text] of Object.entries(AGENT_FILES)) {
    await writeFile(join(path, 'agents', name), text);
  }
  await host.bureau.agents.refresh();
}

/** The files under `directory` that hold `needle`, as it is or in a common encoding. */
async function filesHolding(directory: string, needle: string): Promise<string[]> {
  const encodings = [
    Buffer.from(needle),
    Buffer.from(Buffer.from(needle).toString('base64')),
    Buffer.from(Buffer.from(needle).toString('base64url')),
    Buffer.from(Buffer.from(needle).toString('hex')),
  ];
  return [...(await filesUnder(directory))]
    .filter(([, bytes]) => encodings.some((encoded) => bytes.includes(encoded)))
    .map(([path]) => path);
}

async function agentFilesOf(path: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const names = await readdir(join(path, 'agents'));
  for (const name of names.toSorted()) {
    found[name] = await readFile(join(path, 'agents', name), 'utf8');
  }
  return found;
}

function standingOf(host: Host, id: string) {
  const listing = host.bureau.agents.list().find((agent) => agent.id === id);
  return { state: listing?.state, problem: listing?.problem };
}

/** A host holding the `files` MCP source, loaded, with the agent files written. */
async function hostWithSourceAndAgents(): Promise<{ host: Host; path: string }> {
  const path = await home();
  const mcp = await startMcpServer(BEARER);
  servers.push(mcp);
  const first = await startAt(path);
  const connected = await send(first, 'PUT', '/host/tool-sources/files', {
    source: {
      id: 'files',
      kind: 'mcp',
      transport: {
        type: 'http',
        url: `${mcp.origin}/`,
        authentication: { type: 'bearer', credential: 'token' },
      },
    },
    credentials: { token: BEARER },
  });
  expect(connected.status).toBe(200);
  const host = await restart(first, path);
  await writeAgents(path, host);
  return { host, path };
}

describe('removing a saved tool source', () => {
  test('previews the agents that name its tools, including one named only in toolApproval', async () => {
    const { host } = await hostWithSourceAndAgents();
    expect(standingOf(host, 'reader').state).toBe('ready');

    const response = await send(host, 'GET', '/host/tool-sources/files/affected-agents');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: 'files',
      tools: ['files__lookup', 'files__wipe'],
      affectedAgents: [
        {
          id: 'approver',
          name: 'approver',
          tools: [],
          toolApproval: ['files__wipe'],
        },
        {
          id: 'reader',
          name: 'reader',
          tools: ['files__lookup'],
          toolApproval: ['files__lookup'],
        },
      ],
    });
    // A preview removes nothing.
    const snapshot = await host.toolSources.snapshot();
    expect(snapshot.sources.map((source) => source.id)).toEqual(['files']);
    expect(await send(host, 'GET', '/host/tool-sources/nope/affected-agents')).toMatchObject({
      status: 404,
    });
  });

  test('reports the affected agents and audits them, leaves every agent file as it was, and invalidates the agents only at the next start', async () => {
    const { host, path } = await hostWithSourceAndAgents();
    const before = await agentFilesOf(path);

    const removed = await send(host, 'DELETE', '/host/tool-sources/files');

    expect(removed.status).toBe(200);
    const body = (await removed.json()) as { affectedAgents: { id: string }[] };
    expect(body).toMatchObject({ id: 'files', changed: true, restartRequired: true });
    expect(body.affectedAgents.map((agent) => agent.id)).toEqual(['approver', 'reader']);
    const trail = await host.bureau.audit.query({ runId: auditTrailToolSourceOwnerId('files') });
    expect(trail.records.map((record) => [record.type, record.detail])).toEqual([
      ['tool.source.connected', { sourceId: 'files', kind: 'mcp' }],
      [
        'tool.source.removed',
        {
          sourceId: 'files',
          kind: 'mcp',
          affectedAgents: 'approver,reader',
          affectedAgentCount: 2,
        },
      ],
    ]);
    // No agent file was written, and none is named in a way that would have changed it.
    expect(await agentFilesOf(path)).toEqual(before);
    // The running catalog still holds the tools, so the agent is unchanged until the next start.
    await host.bureau.agents.refresh();
    expect(standingOf(host, 'reader').state).toBe('ready');

    const second = await restart(host, path);

    expect(await agentFilesOf(path)).toEqual(before);
    const reader = standingOf(second, 'reader');
    expect(reader.state).toBe('invalid');
    expect(reader.problem?.code).toBe('unknown-tool');
    expect(reader.problem?.message).toContain('files__lookup');
    expect(reader.problem?.issues).toEqual([
      {
        path: 'tools',
        message: '"files__lookup" is not a registered tool',
        reference: 'files__lookup',
      },
    ]);
    expect(standingOf(second, 'bystander').state).toBe('ready');
    expect(standingOf(second, 'plain').state).toBe('ready');
  });

  test('deletes the encrypted credential, so no file holds it and the secret is empty', async () => {
    const { host, path } = await hostWithSourceAndAgents();
    const secretPath = join(path, 'secrets', 'tool-source-files');
    const held = await readFile(secretPath, 'utf8');
    expect(held.length).toBeGreaterThan(0);
    // The ciphertext of the credential, which a scan can find while it is stored and not after.
    const ciphertext = (JSON.parse(held) as { credentials: { token: { ciphertext: string } } })
      .credentials.token.ciphertext;
    expect(ciphertext.length).toBeGreaterThan(0);
    expect(await filesHolding(path, ciphertext)).toEqual([secretPath]);
    expect(await filesHolding(path, BEARER)).toEqual([]);

    await send(host, 'DELETE', '/host/tool-sources/files');

    expect(await readFile(secretPath, 'utf8')).toBe('');
    const remaining = await host.toolSources.snapshot();
    expect(remaining.sources).toEqual([]);
    expect(await filesHolding(path, ciphertext)).toEqual([]);
    expect(await filesHolding(path, BEARER)).toEqual([]);
  });

  test('deletes the OAuth state of a sign-in that was still waiting, so a late callback finds nothing', async () => {
    const path = await home();
    const oauth = await startOAuthMcpServer();
    servers.push(oauth);
    const host = await startAt(path);
    await send(host, 'PUT', '/host/tool-sources/calendar', {
      source: {
        id: 'calendar',
        kind: 'mcp',
        transport: { type: 'http', url: `${oauth.origin}/`, authentication: { type: 'oauth' } },
      },
    });
    const started = await send(host, 'POST', '/host/tool-sources/calendar/authorize');
    const { authorizationUrl } = (await started.json()) as { authorizationUrl: string };
    const redirect = await fetch(authorizationUrl, { redirect: 'manual' });
    const callback = redirect.headers.get('location') ?? '';
    const secretPath = join(path, 'secrets', 'tool-source-calendar');
    // The verifier, the state and the sign-in are held while the sign-in waits.
    const waiting = await readFile(secretPath, 'utf8');
    expect(waiting.length).toBeGreaterThan(0);

    const removed = await send(host, 'DELETE', '/host/tool-sources/calendar');

    expect(removed.status).toBe(200);
    expect(await readFile(secretPath, 'utf8')).toBe('');
    expect(
      await filesHolding(path, new URL(authorizationUrl).searchParams.get('state') ?? '-'),
    ).toEqual([]);
    // The browser comes back after the removal: nothing is waiting, and no token is issued.
    const late = await fetch(callback);
    expect(late.status).toBe(400);
    expect(oauth.issuedAccessTokens).toEqual([]);
    expect(await readFile(secretPath, 'utf8')).toBe('');
  });
});
