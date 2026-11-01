/**
 * COR-1991: a probe contacts a tool source that is not saved yet and reports what it lists. It
 * writes, stores and records nothing, spawns a local command only for the owner, runs against a
 * deadline of its own, and never repeats an address, a command or a value in what it answers.
 * Every server is in-process on the loopback and every token is made up for the test.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createToolSourceManager,
  ToolSourceInputError,
  ToolSourceOwnerOnlyError,
  ToolSourceWriteLockedError,
  type ToolSourceAuditEntry,
  type ToolSourceManager,
  type ToolSourceManagerOptions,
} from './tool-source-manager.ts';
import { keysOf, memoryHome } from './tool-source-memory-home.test-support.ts';
import { toolSourceRoutes } from './tool-source-routes.ts';
import {
  petsDocument,
  startMcpServer,
  startOAuthMcpServer,
  type TestServer,
} from './tool-source-servers.test-support.ts';

const owner = 'anonymous:local';
const TOKEN = 'probe-token-that-must-never-be-answered';

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
  for (const pid of started.splice(0)) if (isRunning(pid)) process.kill(pid, 'SIGKILL');
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function managerOver(
  mode: 'local' | 'remote' = 'local',
  extra: Partial<ToolSourceManagerOptions> = {},
) {
  const home = memoryHome(mode);
  const audited: ToolSourceAuditEntry[] = [];
  const manager = createToolSourceManager({
    bungalow: home.bungalow,
    keys: await keysOf(),
    audit: async (entry) => void audited.push(entry),
    origin: () => 'http://127.0.0.1:1',
    ...extra,
  });
  closers.push(manager);
  return { manager, home, audited };
}

async function track<Server extends TestServer>(server: Promise<Server>): Promise<Server> {
  const started = await server;
  servers.push(started);
  return started;
}

const mcpSource = (id: string, url: string) => ({
  id,
  kind: 'mcp',
  transport: {
    type: 'http',
    url: `${url}/`,
    authentication: { type: 'bearer', credential: 'token' },
  },
});

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('probing an MCP server', () => {
  test('lists its tools under the names an agent file would use, with their tiers, and saves nothing', async () => {
    const server = await track(startMcpServer(TOKEN));
    const { manager, home, audited } = await managerOver();

    const probe = await manager.probe({
      id: 'notes',
      source: mcpSource('notes', server.origin),
      credentials: { token: TOKEN },
      principal: owner,
    });

    expect(probe).toEqual({
      outcome: 'listed',
      tools: [
        { name: 'notes__lookup', tool: 'lookup', tier: 'read-only' },
        { name: 'notes__wipe', tool: 'wipe', tier: 'dangerous' },
      ],
      skipped: [],
    });
    // Nothing was stored, written or recorded, and the source is not in the list.
    expect(home.state.secrets.size).toBe(0);
    expect(home.state.configuration).toBeUndefined();
    expect(audited).toEqual([]);
    const { sources } = await manager.snapshot();
    expect(sources).toEqual([]);
    expect(server.authorizations).toContain(`Bearer ${TOKEN}`);
  });

  test('answers that the source failed when the credential is refused, and the answer holds neither the token nor the address', async () => {
    const server = await track(startMcpServer(TOKEN));
    const { manager } = await managerOver();

    const probe = await manager.probe({
      id: 'notes',
      source: mcpSource('notes', server.origin),
      credentials: { token: 'the-wrong-token-value' },
      principal: owner,
    });

    expect(probe.outcome).toBe('failed');
    const text = JSON.stringify(probe);
    expect(text).not.toContain('the-wrong-token-value');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain(new URL(server.origin).port);
    expect(probe).toMatchObject({ message: expect.stringContaining('could not be reached') });
  });

  test('answers that the source failed when nothing listens, without the address', async () => {
    const { manager } = await managerOver();

    const probe = await manager.probe({
      id: 'gone',
      source: {
        id: 'gone',
        kind: 'mcp',
        transport: { type: 'http', url: 'http://127.0.0.1:9/' },
      },
      principal: owner,
    });

    expect(probe.outcome).toBe('failed');
    expect(JSON.stringify(probe)).not.toContain('127.0.0.1');
  });

  test('reports an OAuth server as needing a sign-in, and stores nothing of the registration', async () => {
    const server = await track(startOAuthMcpServer());
    const { manager, home } = await managerOver();

    const probe = await manager.probe({
      id: 'ledger',
      source: {
        id: 'ledger',
        kind: 'mcp',
        transport: {
          type: 'http',
          url: `${server.origin}/`,
          authentication: { type: 'oauth' },
        },
      },
      principal: owner,
    });

    expect(probe).toEqual({ outcome: 'needs-authorization' });
    expect(home.state.secrets.size).toBe(0);
    expect(home.state.configuration).toBeUndefined();
  });
});

describe('probing an OpenAPI service', () => {
  test('lists the operations of an embedded document, tiered by method', async () => {
    const { manager } = await managerOver();

    const probe = await manager.probe({
      id: 'pets',
      source: {
        id: 'pets',
        kind: 'openapi',
        specification: { type: 'document', document: petsDocument },
        baseUrl: 'http://127.0.0.1:9/',
      },
      principal: owner,
    });

    expect(probe.outcome).toBe('listed');
    if (probe.outcome !== 'listed') return;
    expect(probe.tools.map((tool) => tool.name).sort()).toEqual([
      'pets__create-pet',
      'pets__delete-pet',
      'pets__list-pets',
    ]);
  });
});

describe('a probe that is not allowed', () => {
  test('is refused for a request that names no value for a credential the description names', async () => {
    const server = await track(startMcpServer(TOKEN));
    const { manager } = await managerOver();

    const failure = await failureOf(
      manager.probe({
        id: 'notes',
        source: mcpSource('notes', server.origin),
        principal: owner,
      }),
    );

    expect(failure).toBeInstanceOf(ToolSourceInputError);
    expect((failure as ToolSourceInputError).field).toBe('credentials.token');
    // The server was not contacted: the request was refused before anything left the host.
    expect(server.authorizations).toEqual([]);
  });

  test('is refused for an address that is not http or https, or that holds a username', async () => {
    const { manager } = await managerOver();

    for (const url of ['ftp://127.0.0.1/', 'http://user:secret@127.0.0.1/']) {
      const failure = await failureOf(
        manager.probe({
          id: 'odd',
          source: { id: 'odd', kind: 'mcp', transport: { type: 'http', url } },
          principal: owner,
        }),
      );
      expect(failure).toBeInstanceOf(ToolSourceInputError);
      expect((failure as ToolSourceInputError).message).not.toContain('secret');
    }
  });

  test('is refused for a reserved identifier and for an identifier the description does not carry', async () => {
    const { manager } = await managerOver();
    const source = {
      id: 'other',
      kind: 'mcp',
      transport: { type: 'http', url: 'http://127.0.0.1:9/' },
    };

    const mismatch = await failureOf(manager.probe({ id: 'notes', source, principal: owner }));
    const reserved = await failureOf(
      manager.probe({ id: 'bureau', source: { ...source, id: 'bureau' }, principal: owner }),
    );

    expect((mismatch as ToolSourceInputError).field).toBe('source.id');
    expect((reserved as ToolSourceInputError).field).toBe('id');
  });

  test('is refused on a remote home, which cannot save the source', async () => {
    const { manager } = await managerOver('remote');

    const failure = await failureOf(
      manager.probe({
        id: 'pets',
        source: {
          id: 'pets',
          kind: 'openapi',
          specification: { type: 'document', document: petsDocument },
          baseUrl: 'http://127.0.0.1:9/',
        },
        principal: owner,
      }),
    );

    expect(failure).toBeInstanceOf(ToolSourceWriteLockedError);
  });

  test('is refused for a local command when the principal is not the owner, and spawns nothing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interborough-probe-'));
    directories.push(directory);
    const file = join(directory, 'pids');
    const { manager } = await managerOver();

    const failure = await failureOf(
      manager.probe({
        id: 'silent',
        source: hangingCommand(file),
        principal: 'someone-else',
      }),
    );

    expect(failure).toBeInstanceOf(ToolSourceOwnerOnlyError);
    expect(await readFile(file, 'utf8').catch(() => '')).toBe('');
  });
});

/** A local command that records its process id in `file` and never answers the handshake. */
function hangingCommand(file: string) {
  return {
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
  };
}

describe('a probe of a source that never answers', () => {
  test('stops at its own deadline, reports it in words that name no command, and stops the process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interborough-probe-'));
    directories.push(directory);
    const file = join(directory, 'pids');
    const deadlines: { expire: () => void; milliseconds: number }[] = [];
    const { manager } = await managerOver('local', {
      probeTimeoutMilliseconds: 1234,
      schedule: (expire, milliseconds) => {
        deadlines.push({ expire, milliseconds });
        return () => undefined;
      },
    });

    const probing = manager.probe({ id: 'silent', source: hangingCommand(file), principal: owner });
    const pids = async (): Promise<number[]> => {
      const text = await readFile(file, 'utf8').catch(() => '');
      const found = text.split('\n').filter(Boolean).map(Number);
      started.push(...found);
      return found;
    };
    await waitUntil(
      async () => {
        const found = await pids();
        return found.length > 0;
      },
      { message: 'the command to start' },
    );
    // The product option is the deadline the probe asked for; this is that deadline passing.
    expect(deadlines.map((deadline) => deadline.milliseconds)).toEqual([1234]);
    deadlines[0]?.expire();
    const probe = await probing;

    expect(probe).toEqual({ outcome: 'failed', message: 'The source did not answer in time.' });
    const everyone = await pids();
    await waitUntil(() => everyone.every((pid) => !isRunning(pid)), {
      message: 'every process the probe started to stop',
    });
  });

  test('asks for ten seconds by default, not the thirty of a load at boot', async () => {
    const deadlines: number[] = [];
    const { manager } = await managerOver('local', {
      loadTimeoutMilliseconds: 111,
      schedule: (_expire, milliseconds) => {
        deadlines.push(milliseconds);
        return () => undefined;
      },
    });

    await manager.probe({
      id: 'pets',
      source: {
        id: 'pets',
        kind: 'openapi',
        specification: { type: 'document', document: petsDocument },
        baseUrl: 'http://127.0.0.1:9/',
      },
      principal: owner,
    });

    expect(deadlines).toEqual([10_000]);
  });
});

describe('the probe route', () => {
  function post(manager: ToolSourceManager, id: string, body: unknown, principal = owner) {
    const routes = toolSourceRoutes(manager, () => undefined, { principal: () => principal });
    const request = Object.assign(
      new Request(`http://127.0.0.1/host/tool-sources/${id}/probe`, {
        method: 'POST',
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      { params: { id } },
    );
    return routes['/host/tool-sources/:id/probe'].POST(
      request as unknown as Bun.BunRequest<'/host/tool-sources/:id/probe'>,
    );
  }

  test('answers 200 with what the source lists', async () => {
    const server = await track(startMcpServer(TOKEN));
    const { manager } = await managerOver();

    const response = await post(manager, 'notes', {
      source: mcpSource('notes', server.origin),
      credentials: { token: TOKEN },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: 'listed' });
  });

  test('answers 200 with the reason a source failed, and the answer holds no credential', async () => {
    const server = await track(startMcpServer(TOKEN));
    const { manager } = await managerOver();

    const response = await post(manager, 'notes', {
      source: mcpSource('notes', server.origin),
      credentials: { token: 'a-different-token-value' },
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('failed');
    expect(text).not.toContain('a-different-token-value');
    expect(text).not.toContain('127.0.0.1');
  });

  test('answers 400 naming the field for a body that cannot be used, and 403 owner-only for a command', async () => {
    const { manager } = await managerOver();

    const notJson = await post(manager, 'notes', 'not json');
    const missing = await post(manager, 'notes', {
      source: mcpSource('notes', 'http://127.0.0.1:9'),
    });
    const command = await post(
      manager,
      'silent',
      { source: hangingCommand('/nonexistent/pids') },
      'someone-else',
    );

    expect(notJson.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: 'invalid', field: 'credentials.token' });
    expect(command.status).toBe(403);
    expect(await command.json()).toMatchObject({ error: 'owner-only' });
  });
});
