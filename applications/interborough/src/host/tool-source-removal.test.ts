/**
 * COR-1931: the tool-source manager's removal over an in-memory home. These pin what the host test
 * does not reach: which agent files count as affected, the remote lock on a removal while the
 * preview still reads, and a sign-in that was still starting when the source was removed.
 */
import type { AnswerEncryptionKeys } from '@lostgradient/bureau';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentToolUse } from './tool-source-agents.ts';
import {
  createToolSourceManager,
  ToolSourceInputError,
  ToolSourceWriteLockedError,
  type ToolSourceAuditEntry,
  type ToolSourceManager,
  type ToolSourceState,
} from './tool-source-manager.ts';
import { keysOf, memoryHome } from './tool-source-memory-home.test-support.ts';
import { toolSourceRoutes } from './tool-source-routes.ts';
import {
  petsDocument,
  startMcpServer,
  startOAuthMcpServer,
} from './tool-source-servers.test-support.ts';
import { createToolSourceVault, toolSourceSecretKey } from './tool-source-vault.ts';

const owner = 'anonymous:local';

const petsSource = {
  id: 'pets',
  kind: 'openapi',
  specification: { type: 'document', document: petsDocument },
  baseUrl: 'http://127.0.0.1:9/',
  authentication: { type: 'api-key', header: 'x-api-key', credential: 'key' },
};

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const agents: AgentToolUse[] = [
  { id: 'reader', name: 'Reader', tools: ['pets__list-pets', 'lookup-order'], toolApproval: [] },
  {
    id: 'both',
    name: 'Both',
    tools: ['pets__delete-pet', 'pets__create-pet'],
    toolApproval: ['pets__delete-pet'],
  },
  { id: 'approval-only', name: 'Approval only', tools: [], toolApproval: ['pets__list-pets'] },
  {
    id: 'bystander',
    name: 'Bystander',
    tools: ['lookup-order', 'other__list-pets'],
    toolApproval: [],
  },
];

async function started(
  home: ReturnType<typeof memoryHome>,
  extra: {
    fetch?: typeof fetch;
    keys?: AnswerEncryptionKeys;
    agents?: readonly AgentToolUse[];
  } = {},
): Promise<{ manager: ToolSourceManager; audited: ToolSourceAuditEntry[] }> {
  const audited: ToolSourceAuditEntry[] = [];
  const manager = createToolSourceManager({
    bungalow: home.bungalow,
    keys: extra.keys ?? (await keysOf()),
    audit: async (entry) => {
      audited.push(entry);
    },
    origin: () => 'http://127.0.0.1:1',
    agentToolUse: async () => extra.agents ?? agents,
    ...(extra.fetch === undefined ? {} : { fetch: extra.fetch }),
  });
  closers.push(() => manager.close());
  await manager.start();
  return { manager, audited };
}

/** A home that already holds the pets source and its credential, as an earlier run left it. */
async function homeWithPets(mode: 'local' | 'remote' = 'local') {
  const local = memoryHome();
  const keys = await keysOf();
  const seeding = createToolSourceManager({
    bungalow: local.bungalow,
    keys,
    audit: async () => undefined,
    origin: () => 'http://127.0.0.1:1',
  });
  await seeding.connect({
    id: 'pets',
    source: petsSource,
    credentials: { key: 'pets-key-fixture' },
    principal: owner,
  });
  await seeding.close();
  const home = mode === 'local' ? local : memoryHome(mode);
  home.state.configuration = local.state.configuration;
  for (const [name, value] of local.state.secrets) home.state.secrets.set(name, value);
  return { home, keys };
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('the agents a removal affects', () => {
  test('are those whose files name a tool of the source in tools or toolApproval, and no one else', async () => {
    const { home, keys } = await homeWithPets();
    const { manager, audited } = await started(home, { keys });

    const preview = await manager.affectedAgents('pets');

    expect(preview.tools).toEqual(['pets__create-pet', 'pets__delete-pet', 'pets__list-pets']);
    expect(preview.affectedAgents).toEqual([
      { id: 'reader', name: 'Reader', tools: ['pets__list-pets'], toolApproval: [] },
      {
        id: 'both',
        name: 'Both',
        tools: ['pets__create-pet', 'pets__delete-pet'],
        toolApproval: ['pets__delete-pet'],
      },
      {
        id: 'approval-only',
        name: 'Approval only',
        tools: [],
        toolApproval: ['pets__list-pets'],
      },
    ]);
    // A preview changes and records nothing.
    expect(home.state.configuration).toContain('"pets"');
    expect(audited).toEqual([]);
  });

  test('are the same list a removal answers and records, and the file lists none for a source nobody uses', async () => {
    const { home, keys } = await homeWithPets();
    const { manager, audited } = await started(home, { keys });
    const preview = await manager.affectedAgents('pets');

    const removed = await manager.remove({ id: 'pets', principal: owner });

    expect(removed.affectedAgents).toEqual(preview.affectedAgents);
    expect(audited).toEqual([
      expect.objectContaining({
        type: 'tool.source.removed',
        detail: expect.objectContaining({
          sourceId: 'pets',
          affectedAgents: 'reader,both,approval-only',
          affectedAgentCount: 3,
        }),
      }),
    ]);
    expect(await failureOf(manager.affectedAgents('pets'))).toBeInstanceOf(ToolSourceInputError);
  });
});

describe('a remote home', () => {
  test('still previews the affected agents, and refuses the removal with the reason deployment', async () => {
    const { home, keys } = await homeWithPets('remote');
    const { manager, audited } = await started(home, { keys });
    const routes = toolSourceRoutes(manager, () => undefined, { principal: () => owner });
    const request = (method: string, path: string) =>
      Object.assign(new Request(`http://127.0.0.1${path}`, { method }), {
        params: { id: 'pets' },
      });

    const preview = await routes['/host/tool-sources/:id/affected-agents'].GET(
      request(
        'GET',
        '/host/tool-sources/pets/affected-agents',
      ) as unknown as Bun.BunRequest<'/host/tool-sources/:id/affected-agents'>,
    );
    const removal = await routes['/host/tool-sources/:id'].DELETE(
      request(
        'DELETE',
        '/host/tool-sources/pets',
      ) as unknown as Bun.BunRequest<'/host/tool-sources/:id'>,
    );
    const thrown = await failureOf(manager.remove({ id: 'pets', principal: owner }));

    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { affectedAgents: unknown[] }).affectedAgents).toHaveLength(
      3,
    );
    expect(removal.status).toBe(403);
    expect(await removal.json()).toMatchObject({ error: 'locked', reason: 'deployment' });
    expect(thrown).toBeInstanceOf(ToolSourceWriteLockedError);
    expect(home.state.configuration).toContain('"pets"');
    expect(audited).toEqual([]);
  });
});

const calendarSource = (origin: string, path = '/') => ({
  id: 'calendar',
  kind: 'mcp',
  transport: { type: 'http', url: `${origin}${path}`, authentication: { type: 'oauth' } },
});

/** A fetch whose first request waits for `release`, so a test changes the source while a sign-in starts. */
function gatedFetch() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held = false;
  const gated: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return fetch(input, init);
    },
    fetch,
  );
  return { gated, entered: entered.promise, release: release.resolve };
}

/** What the source's secret holds, parsed; an empty secret is an empty record. */
function storedSecret(home: ReturnType<typeof memoryHome>, id: string) {
  const text = home.state.secrets.get(toolSourceSecretKey(id)) ?? '';
  return text === '' ? {} : (JSON.parse(text) as { credentials?: object; oauth?: unknown });
}

describe('a sign-in that is starting when its source is removed', () => {
  test('leaves no OAuth state behind, and fails as an unknown source', async () => {
    const oauth = await startOAuthMcpServer();
    closers.push(() => oauth.stop());
    const home = memoryHome();
    const { gated, entered, release } = gatedFetch();
    const { manager } = await started(home, { fetch: gated });
    await manager.connect({
      id: 'calendar',
      source: calendarSource(oauth.origin),
      principal: owner,
    });

    const signingIn = manager.authorize('calendar');
    await entered;
    await manager.remove({ id: 'calendar', principal: owner });
    release();
    const failure = await failureOf(signingIn);

    expect(failure).toBeInstanceOf(ToolSourceInputError);
    expect((failure as ToolSourceInputError).kind).toBe('unknown-source');
    expect(home.state.secrets.get(toolSourceSecretKey('calendar')) ?? '').toBe('');
  });

  test('leaves the OAuth state of the old sign-in out of a source added again under the same id', async () => {
    const oauth = await startOAuthMcpServer();
    closers.push(() => oauth.stop());
    const home = memoryHome();
    const { gated, entered, release } = gatedFetch();
    const { manager } = await started(home, { fetch: gated });
    await manager.connect({
      id: 'calendar',
      source: calendarSource(oauth.origin),
      principal: owner,
    });

    const signingIn = manager.authorize('calendar');
    await entered;
    await manager.remove({ id: 'calendar', principal: owner });
    await manager.connect({
      id: 'calendar',
      source: calendarSource(oauth.origin, '/other'),
      principal: owner,
    });
    release();
    const failure = await failureOf(signingIn);

    expect(failure).toBeInstanceOf(ToolSourceInputError);
    expect(storedSecret(home, 'calendar')).not.toHaveProperty('oauth');
    const snapshot = await manager.snapshot();
    const [standing] = snapshot.sources;
    expect(standing).toMatchObject({ id: 'calendar', authorized: false });
  });
});

describe('a source that loaded nothing', () => {
  const named: AgentToolUse[] = [
    { id: 'searcher', name: 'Searcher', tools: ['down__search', 'lookup-order'], toolApproval: [] },
    { id: 'approver', name: 'Approver', tools: [], toolApproval: ['down__wipe'] },
    { id: 'near', name: 'Near', tools: ['down-town__search', 'downer__search'], toolApproval: [] },
  ];

  async function expectsTheAgentsToBeFound(
    home: ReturnType<typeof memoryHome>,
    prepare: (manager: ToolSourceManager) => Promise<unknown>,
    expectedState: ToolSourceState,
  ) {
    const { manager, audited } = await started(home, { agents: named });
    await prepare(manager);
    const snapshot = await manager.snapshot();
    const [standing] = snapshot.sources;
    expect(standing?.state).toBe(expectedState);
    expect(standing?.tools).toEqual([]);

    const preview = await manager.affectedAgents('down');
    const removed = await manager.remove({ id: 'down', principal: owner });

    const ids = ['searcher', 'approver'];
    expect(preview.affectedAgents.map((agent) => agent.id)).toEqual(ids);
    expect(preview.affectedAgents[0]).toMatchObject({ tools: ['down__search'] });
    expect(preview.affectedAgents[1]).toMatchObject({ toolApproval: ['down__wipe'] });
    expect(removed.affectedAgents).toEqual(preview.affectedAgents);
    expect(audited.at(-1)).toMatchObject({
      type: 'tool.source.removed',
      detail: { affectedAgents: 'searcher,approver', affectedAgentCount: 2 },
    });
  }

  test('is found when it failed to load', async () => {
    const home = memoryHome();
    // The description names a credential nobody stored, so it cannot load.
    home.state.configuration = JSON.stringify({
      toolSources: [{ source: { ...petsSource, id: 'down' } }],
    });

    await expectsTheAgentsToBeFound(home, async () => undefined, 'failed');
  });

  test('is found when it awaits a sign-in', async () => {
    const home = memoryHome();
    home.state.configuration = JSON.stringify({
      toolSources: [{ source: { ...calendarSource('http://127.0.0.1:9'), id: 'down' } }],
    });

    await expectsTheAgentsToBeFound(home, async () => undefined, 'needs-authorization');
  });

  test('is found when it was added since the host started', async () => {
    await expectsTheAgentsToBeFound(
      memoryHome(),
      (manager) =>
        manager.connect({
          id: 'down',
          source: { ...petsSource, id: 'down' },
          credentials: { key: 'k' },
          principal: owner,
        }),
      'pending-restart',
    );
  });
});

describe('the connection of a removed source', () => {
  test('is closed, so its tools fail until the host starts again, whatever it holds', async () => {
    const mcp = await startMcpServer('removal-token');
    closers.push(() => mcp.stop());
    // The source names no credential: the token is added to the request on its way out, so a
    // call fails after the removal only because the connection was closed, not because a
    // credential was refused.
    const authorizing: typeof fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set('authorization', 'Bearer removal-token');
        return fetch(input, { ...init, headers });
      },
      fetch,
    );
    const home = memoryHome();
    const keys = await keysOf();
    const source = {
      id: 'files',
      kind: 'mcp',
      transport: { type: 'http', url: `${mcp.origin}/` },
    };
    const seeding = await started(home, { keys });
    await seeding.manager.connect({ id: 'files', source, principal: owner });
    const { manager } = await started(home, { keys, fetch: authorizing });
    const lookup = manager.tools()['files__lookup'];
    expect(lookup).toBeDefined();
    expect(await lookup?.execute({})).toBeDefined();

    await manager.remove({ id: 'files', principal: owner });

    expect(await failureOf(Promise.resolve(lookup?.execute({})))).toBeDefined();
  });
});

/** An HTTP service that answers `/pets` and `/openapi.json`, and records what it was sent. */
function startPetService() {
  const requests: { path: string; apiKey: string | null; authorization: string | null }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/openapi.json') return Response.json(petsDocument);
      requests.push({
        path,
        apiKey: request.headers.get('x-api-key'),
        authorization: request.headers.get('authorization'),
      });
      return Response.json([{ id: 1 }]);
    },
  });
  closers.push(async () => {
    await server.stop(true);
  });
  return { origin: `http://127.0.0.1:${server.port}`, requests };
}

describe('the tools of a removed source', () => {
  const credentialKinds = [
    {
      name: 'an API key',
      authentication: { type: 'api-key', header: 'x-api-key', credential: 'key' },
      sent: (request: { apiKey: string | null; authorization: string | null }) => request.apiKey,
      value: 'removal-api-key',
    },
    {
      name: 'a bearer token',
      authentication: { type: 'bearer', credential: 'key' },
      sent: (request: { apiKey: string | null; authorization: string | null }) =>
        request.authorization,
      value: 'removal-bearer-token',
    },
  ] as const;
  const specifications = ['inline', 'url'] as const;

  for (const credentialKind of credentialKinds) {
    for (const specification of specifications) {
      test(`cannot reach an OpenAPI service with ${credentialKind.name} read at load (${specification} specification)`, async () => {
        const service = startPetService();
        const home = memoryHome();
        const keys = await keysOf();
        const source = {
          id: 'pets',
          kind: 'openapi',
          specification:
            specification === 'inline'
              ? { type: 'document', document: petsDocument }
              : { type: 'url', url: `${service.origin}/openapi.json` },
          baseUrl: `${service.origin}/`,
          authentication: credentialKind.authentication,
        };
        const seeding = await started(home, { keys });
        await seeding.manager.connect({
          id: 'pets',
          source,
          credentials: { key: credentialKind.value },
          principal: owner,
        });
        const { manager } = await started(home, { keys });
        const listPets = manager.tools()['pets__list-pets'];
        expect(listPets).toBeDefined();
        expect(await listPets?.execute({})).toBeDefined();
        expect(service.requests.map(credentialKind.sent)).toEqual(
          [
            credentialKind.value,
            // The bearer is sent with its scheme.
          ].map((value) =>
            credentialKind.sent === credentialKinds[1].sent ? `Bearer ${value}` : value,
          ),
        );

        await manager.remove({ id: 'pets', principal: owner });
        const failure = await failureOf(Promise.resolve(listPets?.execute({})));

        expect(failure).toBeInstanceOf(Error);
        expect(service.requests).toHaveLength(1);
        expect(home.state.secrets.get(toolSourceSecretKey('pets')) ?? '').toBe('');
      });
    }
  }

  test('keep their name, description, input, tags and metadata behind the gate', async () => {
    const { home, keys } = await homeWithPets();
    const ungated = createToolSourceManager({
      bungalow: home.bungalow,
      keys,
      audit: async () => undefined,
      origin: () => 'http://127.0.0.1:1',
    });
    closers.push(() => ungated.close());
    await ungated.start();
    const { manager } = await started(home, { keys });
    const gated = manager.tools()['pets__delete-pet'];
    const original = ungated.tools()['pets__delete-pet'];

    expect(gated).toBeDefined();
    expect(gated?.configuration.metadata).toEqual(original?.configuration.metadata);
    expect(gated?.configuration.tags).toEqual(original?.configuration.tags);
    expect(gated?.configuration.description).toBe(original?.configuration.description);
    expect(gated?.name).toBe(original?.name);
    expect(JSON.stringify(gated?.configuration.input)).toBe(
      JSON.stringify(original?.configuration.input),
    );
  });

  test('of a local command stop the child process and fail', async () => {
    const fixture = new URL(
      '../../../../packages/armorer/test/fixtures/tool-source-stdio-server.ts',
      import.meta.url,
    ).pathname;
    const directory = await mkdtemp(join(tmpdir(), 'interborough-removal-'));
    closers.push(() => rm(directory, { recursive: true, force: true }));
    const pidFile = join(directory, 'pids');
    const isRunning = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const home = memoryHome();
    const keys = await keysOf();
    const seeding = await started(home, { keys });
    await seeding.manager.connect({
      id: 'local',
      source: {
        id: 'local',
        kind: 'mcp',
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: [
            '--no-install',
            new URL('./tool-source-stdio-pid.test-support.ts', import.meta.url).pathname,
            pidFile,
            fixture,
          ],
          credentialEnv: { SOURCE_TOKEN: 'child-token' },
        },
      },
      credentials: { 'child-token': 'child-secret-value' },
      principal: owner,
    });
    const { manager } = await started(home, { keys });
    const read = manager.tools()['local__read-environment'];
    expect(await read?.execute({ name: 'SOURCE_TOKEN' })).toBe('child-secret-value');
    // The load may start a short-lived sibling first; the process that serves is the last one.
    const recorded = await readFile(pidFile, 'utf8');
    const pids = recorded.split('\n').filter(Boolean).map(Number);
    const serving = pids.at(-1) ?? 0;
    expect(isRunning(serving)).toBe(true);

    await manager.remove({ id: 'local', principal: owner });

    const failure = await failureOf(Promise.resolve(read?.execute({ name: 'SOURCE_TOKEN' })));
    expect(failure).toBeInstanceOf(Error);
    await waitUntil(() => !isRunning(serving), {
      message: 'the removed source’s child process to stop',
    });
  });

  test('read as pending a restart, not loaded, when the source is added again', async () => {
    const { home, keys } = await homeWithPets();
    const { manager } = await started(home, { keys });
    const loadedSnapshot = await manager.snapshot();
    expect(loadedSnapshot.sources[0]?.state).toBe('loaded');

    await manager.remove({ id: 'pets', principal: owner });
    await manager.connect({
      id: 'pets',
      source: petsSource,
      credentials: { key: 'pets-key-fixture' },
      principal: owner,
    });

    const snapshot = await manager.snapshot();
    expect(snapshot.sources[0]?.state).toBe('pending-restart');
    expect(snapshot.sources[0]?.tools).toEqual([]);
  });
});

describe('a sign-in whose source is replaced by a bearer source at the same address', () => {
  test('keeps the credential the replacement stored, and drops only the OAuth state', async () => {
    const oauth = await startOAuthMcpServer();
    closers.push(() => oauth.stop());
    const home = memoryHome();
    const { gated, entered, release } = gatedFetch();
    const { manager } = await started(home, { fetch: gated });
    await manager.connect({
      id: 'calendar',
      source: calendarSource(oauth.origin),
      principal: owner,
    });

    const signingIn = manager.authorize('calendar');
    await entered;
    await manager.connect({
      id: 'calendar',
      source: {
        id: 'calendar',
        kind: 'mcp',
        transport: {
          type: 'http',
          url: `${oauth.origin}/`,
          authentication: { type: 'bearer', credential: 'token' },
        },
      },
      credentials: { token: 'replacement-bearer' },
      principal: owner,
    });
    release();
    const failure = await failureOf(signingIn);

    expect(failure).toBeInstanceOf(ToolSourceInputError);
    const secret = storedSecret(home, 'calendar');
    expect(secret).not.toHaveProperty('oauth');
    expect(Object.keys(secret.credentials ?? {})).toEqual(['token']);
    const finalSnapshot = await manager.snapshot();
    const [standing] = finalSnapshot.sources;
    expect(standing?.credentials).toEqual(['token']);
  });
});

describe('a sign-in that outlives its source', () => {
  test('cannot erase the OAuth state of the source that replaced it', async () => {
    const oauth = await startOAuthMcpServer();
    closers.push(() => oauth.stop());
    const home = memoryHome();
    const keys = await keysOf();
    const { gated, entered, release } = gatedFetch();
    const { manager } = await started(home, { fetch: gated, keys });
    await manager.connect({
      id: 'calendar',
      source: calendarSource(oauth.origin),
      principal: owner,
    });

    const staleSignIn = manager.authorize('calendar');
    await entered;
    await manager.connect({
      id: 'calendar',
      source: calendarSource(oauth.origin, '/other'),
      principal: owner,
    });
    // The replacement signs in while the old call still waits for the server.
    await createToolSourceVault({ bungalow: home.bungalow, keys })
      .tokenStorage('calendar')
      .save({ tokens: { access_token: 'replacement-access', token_type: 'Bearer' } });
    release();
    const failure = await failureOf(staleSignIn);

    expect(failure).toBeInstanceOf(ToolSourceInputError);
    const finalSnapshot = await manager.snapshot();
    expect(finalSnapshot.sources[0]).toMatchObject({ id: 'calendar', authorized: true });
  });
});
