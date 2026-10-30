/**
 * COR-1932: `acceptsSecrets` per saved source tool. The flag is kept in the `tools` of the source's
 * `toolSources` entry, keyed by the tool's own name; it survives a restart, reaches the Armorer
 * tool metadata COR-1816 reads, is off by default, and a tool without it never receives a secret
 * answer. The sources are OpenAPI documents held in memory and every request goes to a stub fetch.
 */
import { createSecretAnswerResolver, type AnswerEncryptionKeys } from '@lostgradient/bureau';
import { MemoryStorage } from '@lostgradient/storage';
import { createToolbox, type Tool, type ToolSecretResolver } from 'armorer';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  createToolSourceManager,
  ToolSourceInputError,
  ToolSourceWriteLockedError,
  type ToolSourceAuditEntry,
  type ToolSourceManager,
} from './tool-source-manager.ts';
import { keysOf, memoryHome } from './tool-source-memory-home.test-support.ts';
import { toolSourceRoutes } from './tool-source-routes.ts';
import {
  petsDocument,
  startMcpServer,
  type TestServer,
} from './tool-source-servers.test-support.ts';

const owner = 'anonymous:local';

const petsSource = {
  id: 'pets',
  kind: 'openapi',
  specification: { type: 'document', document: petsDocument },
  baseUrl: 'http://pets.test/',
  authentication: { type: 'api-key', header: 'x-api-key', credential: 'key' },
};

const closers: ToolSourceManager[] = [];
const servers: TestServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const manager of closers.splice(0)) await manager.close();
});

/** A manager over `home`, as a host start would make one. `requests` collects the URLs the tools call. */
async function managerOver(
  home: ReturnType<typeof memoryHome>,
  keys: AnswerEncryptionKeys,
  requests: string[] = [],
  stubFetch = true,
) {
  const audited: ToolSourceAuditEntry[] = [];
  const warnings: string[] = [];
  const manager = createToolSourceManager({
    bungalow: home.bungalow,
    keys,
    audit: async (entry) => void audited.push(entry),
    origin: () => 'http://127.0.0.1:1',
    warn: (message) => void warnings.push(message),
    ...(stubFetch
      ? {
          fetch: Object.assign(
            async (input: RequestInfo | URL) => {
              requests.push(String(input instanceof Request ? input.url : input));
              return Response.json({ ok: true });
            },
            { preconnect: () => undefined },
          ),
        }
      : {}),
  });
  closers.push(manager);
  return { manager, audited, warnings };
}

async function connectPets(manager: ToolSourceManager): Promise<void> {
  await manager.connect({
    id: 'pets',
    source: petsSource,
    credentials: { key: 'k' },
    principal: owner,
  });
}

/** The first source the manager reports now. */
async function standingOf(manager: ToolSourceManager) {
  const snapshot = await manager.snapshot();
  return snapshot.sources[0];
}

/** The tools of a started manager, as the host hands them to the agent source. */
function toolOf(manager: ToolSourceManager, name: string): Tool {
  const tool = manager.tools()[name];
  if (tool === undefined) throw new Error(`The catalog holds no ${name}.`);
  return tool;
}

/** The toolbox a file agent's run builds from the catalog (Operative's `createAgent`), with `secretResolver`. */
function runToolbox(
  manager: ToolSourceManager,
  names: string[],
  secretResolver: ToolSecretResolver,
) {
  return createToolbox(
    names.map((name) => ({ ...toolOf(manager, name).configuration, name })),
    { secretResolver },
  );
}

describe('acceptsSecrets on a saved source tool', () => {
  test('survives a restart, reaches the tool metadata, and is off for every other tool', async () => {
    const home = memoryHome();
    const keys = await keysOf();
    const first = await managerOver(home, keys);
    await connectPets(first.manager);

    const change = await first.manager.configureTools({
      id: 'pets',
      tools: { 'delete-pet': { acceptsSecrets: true } },
    });

    expect(change).toEqual({ id: 'pets', changed: true, restartRequired: true });
    expect(first.audited.map((entry) => entry.type)).toEqual([
      'tool.source.connected',
      'tool.source.tools-configured',
    ]);
    expect(JSON.parse(home.state.configuration ?? '{}').toolSources[0].tools).toEqual({
      'delete-pet': { acceptsSecrets: true },
    });
    // Saved, not applied: the running host loads it at the next start.
    expect(await standingOf(first.manager)).toMatchObject({
      state: 'pending-restart',
    });

    await first.manager.close();
    const second = await managerOver(home, keys);
    await second.manager.start();

    expect(toolOf(second.manager, 'pets__delete-pet').metadata?.['acceptsSecrets']).toBe(true);
    expect(
      toolOf(second.manager, 'pets__delete-pet').configuration.metadata?.['acceptsSecrets'],
    ).toBe(true);
    for (const name of ['pets__list-pets', 'pets__create-pet']) {
      expect(toolOf(second.manager, name).metadata).not.toHaveProperty('acceptsSecrets');
    }
    const standing = await standingOf(second.manager);
    expect(standing?.state).toBe('loaded');
    expect(standing?.tools.map((tool) => [tool.name, tool.acceptsSecrets])).toEqual(
      expect.arrayContaining([
        ['pets__delete-pet', true],
        ['pets__list-pets', false],
        ['pets__create-pet', false],
      ]),
    );
    expect(standing?.unmatchedSettings).toEqual([]);
    expect(standing).not.toHaveProperty('settingsPending');
  });

  test('keeps the rest of the tool as the loader made it', async () => {
    const home = memoryHome();
    const keys = await keysOf();
    const first = await managerOver(home, keys);
    await connectPets(first.manager);
    await first.manager.start();
    const original = toolOf(first.manager, 'pets__delete-pet');
    await first.manager.configureTools({
      id: 'pets',
      tools: { 'delete-pet': { acceptsSecrets: true } },
    });
    await first.manager.close();
    const second = await managerOver(home, keys);
    await second.manager.start();

    const flagged = toolOf(second.manager, 'pets__delete-pet').configuration;

    // Every field but the metadata key rides along: nothing the loader set is dropped by the rebuild.
    const { metadata: _flaggedMetadata, ...flaggedRest } = flagged;
    const { metadata: _originalMetadata, ...originalRest } = original.configuration;
    expect(Object.keys(flaggedRest).toSorted()).toEqual(Object.keys(originalRest).toSorted());
    for (const key of ['identity', 'display', 'risk', 'availability', 'lifecycle'] as const) {
      expect(flagged[key]).toEqual(original.configuration[key]);
    }
    expect(flagged.tags).toEqual(original.configuration.tags);
    expect(flagged.description).toBe(original.configuration.description);
    expect({ ...flagged.metadata, acceptsSecrets: undefined }).toEqual({
      ...original.configuration.metadata,
      acceptsSecrets: undefined,
    });
  });

  test('defaults to off: a source with no settings, and a tool turned back off, carry no flag or entry', async () => {
    const home = memoryHome();
    const keys = await keysOf();
    const { manager } = await managerOver(home, keys);
    await connectPets(manager);
    expect(JSON.parse(home.state.configuration ?? '{}').toolSources[0]).not.toHaveProperty('tools');

    await manager.configureTools({ id: 'pets', tools: { 'delete-pet': { acceptsSecrets: true } } });
    await manager.configureTools({
      id: 'pets',
      tools: { 'delete-pet': { acceptsSecrets: false } },
    });

    expect(JSON.parse(home.state.configuration ?? '{}').toolSources[0]).not.toHaveProperty('tools');
    // Nothing changes when the request asks for what is already saved.
    expect(
      await manager.configureTools({
        id: 'pets',
        tools: { 'delete-pet': { acceptsSecrets: false } },
      }),
    ).toMatchObject({ changed: false });
  });

  test('keeps the flags when the source is connected again, and merges per tool', async () => {
    const home = memoryHome();
    const { manager } = await managerOver(home, await keysOf());
    await connectPets(manager);
    await manager.configureTools({ id: 'pets', tools: { 'delete-pet': { acceptsSecrets: true } } });
    await manager.configureTools({ id: 'pets', tools: { 'create-pet': { acceptsSecrets: true } } });

    await manager.connect({
      id: 'pets',
      source: { ...petsSource, allowOperations: ['deletePet', 'createPet'] },
      credentials: { key: 'k2' },
      principal: owner,
    });

    expect(JSON.parse(home.state.configuration ?? '{}').toolSources[0].tools).toEqual({
      'delete-pet': { acceptsSecrets: true },
      'create-pet': { acceptsSecrets: true },
    });
  });

  test('a tool without the flag never receives a secret answer; a flagged one does, from the Bureau resolver', async () => {
    const home = memoryHome();
    const keys = await keysOf();
    const first = await managerOver(home, keys);
    await connectPets(first.manager);
    await first.manager.configureTools({
      id: 'pets',
      tools: { 'delete-pet': { acceptsSecrets: true } },
    });
    await first.manager.close();
    const requests: string[] = [];
    const second = await managerOver(home, keys, requests);
    await second.manager.start();
    const asked: string[] = [];
    const names = ['pets__delete-pet', 'pets__create-pet'];

    // The resolver that answers; the unflagged tool must never reach it.
    const plaintext = runToolbox(second.manager, names, async (reference) => {
      asked.push(reference);
      return 'plaintext-id';
    });
    const refused = await plaintext.execute({
      id: 'call-1',
      name: 'pets__create-pet',
      arguments: { body: { secretRef: 'human-wait:run/password' } },
    });
    const accepted = await plaintext.execute({
      id: 'call-2',
      name: 'pets__delete-pet',
      arguments: { id: { secretRef: 'human-wait:run/password' } },
    });

    expect(refused.outcome).toBe('error');
    expect(JSON.stringify(refused)).toContain('secret-not-accepted');
    expect(accepted.outcome).toBe('success');
    expect(asked).toEqual(['human-wait:run/password']);
    expect(requests).toEqual(['http://pets.test/pets/plaintext-id']);

    // The real resolver (`createSecretAnswerResolver`, as the host builds it): no answer was given,
    // so the flagged tool is refused as unavailable and the unflagged one still never asks.
    const bureau = runToolbox(
      second.manager,
      names,
      createSecretAnswerResolver({ storage: new MemoryStorage(), keys }),
    );
    const unavailable = await bureau.execute({
      id: 'call-3',
      name: 'pets__delete-pet',
      arguments: { id: { secretRef: 'human-wait:run/password' } },
    });
    const stillRefused = await bureau.execute({
      id: 'call-4',
      name: 'pets__create-pet',
      arguments: { body: { secretRef: 'human-wait:run/password' } },
    });
    expect(JSON.stringify(unavailable)).toContain('secret-unavailable');
    expect(JSON.stringify(stillRefused)).toContain('secret-not-accepted');
    expect(requests).toHaveLength(1);
  });

  test('a setting for a tool the server does not list is a diagnostic, and applies to no other tool', async () => {
    const home = memoryHome();
    const keys = await keysOf();
    const first = await managerOver(home, keys);
    await connectPets(first.manager);
    await first.manager.configureTools({
      id: 'pets',
      tools: {
        'no-such-tool': { acceptsSecrets: true },
        'pets__delete-pet': { acceptsSecrets: true },
      },
    });
    await first.manager.close();
    const second = await managerOver(home, keys);
    await second.manager.start();

    const standing = await standingOf(second.manager);

    expect(standing?.state).toBe('loaded');
    expect(standing?.unmatchedSettings.map((entry) => entry.tool).toSorted()).toEqual([
      'no-such-tool',
      'pets__delete-pet',
    ]);
    // Keyed by the raw name: the qualified name an agent file uses reaches nothing.
    expect(standing?.tools.every((tool) => !tool.acceptsSecrets)).toBe(true);
    for (const name of Object.keys(second.manager.tools())) {
      expect(second.manager.tools()[name]?.metadata).not.toHaveProperty('acceptsSecrets');
    }
    expect(second.warnings.some((line) => line.includes('no-such-tool'))).toBe(true);
  });

  test('a setting on a tool the host does not offer is reported and unused', async () => {
    const home = memoryHome();
    const keys = await keysOf();
    const first = await managerOver(home, keys);
    await first.manager.connect({
      id: 'pets',
      source: { ...petsSource, allowOperations: ['listPets'] },
      credentials: { key: 'k' },
      principal: owner,
    });
    await first.manager.configureTools({
      id: 'pets',
      tools: { 'delete-pet': { acceptsSecrets: true } },
    });
    await first.manager.close();
    const second = await managerOver(home, keys);
    await second.manager.start();

    const standing = await standingOf(second.manager);

    expect(standing?.unmatchedSettings.map((entry) => entry.tool)).toEqual(['delete-pet']);
    expect(Object.keys(second.manager.tools())).toEqual(['pets__list-pets']);
  });

  test('reports a saved change as pending until the next start', async () => {
    const home = memoryHome();
    const keys = await keysOf();
    const first = await managerOver(home, keys);
    await connectPets(first.manager);
    await first.manager.close();
    const second = await managerOver(home, keys);
    await second.manager.start();

    await second.manager.configureTools({
      id: 'pets',
      tools: { 'delete-pet': { acceptsSecrets: true } },
    });

    const standing = await standingOf(second.manager);
    expect(standing).toMatchObject({ state: 'loaded', settingsPending: true });
    expect(second.manager.tools()['pets__delete-pet']?.metadata).not.toHaveProperty(
      'acceptsSecrets',
    );
  });

  test('refuses what it cannot use, naming the field, and writes nothing', async () => {
    const home = memoryHome();
    const { manager } = await managerOver(home, await keysOf());
    await connectPets(manager);
    const before = home.state.configuration;
    const cases: [unknown, string, unknown?][] = [
      [[], 'tools'],
      [{ 'delete-pet': 1 }, 'tools.delete-pet'],
      [{ 'delete-pet': { acceptsSecrets: 'true' } }, 'tools.delete-pet.acceptsSecrets'],
      [{ 'delete-pet': { acceptsSecret: true } }, 'tools.delete-pet.acceptsSecret'],
    ];

    for (const [tools, field] of cases) {
      const failure = await manager.configureTools({ id: 'pets', tools }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ToolSourceInputError);
      expect((failure as ToolSourceInputError).field).toBe(field);
    }
    const unknown = await manager.configureTools({ id: 'nope', tools: {} }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(unknown).toMatchObject({ kind: 'unknown-source' });
    expect(home.state.configuration).toBe(before);
  });

  test('is refused in a remote home with the reason deployment, on the route too', async () => {
    const home = memoryHome('remote');
    const { manager } = await managerOver(home, await keysOf());
    const failure = await manager
      .configureTools({ id: 'pets', tools: { 'delete-pet': { acceptsSecrets: true } } })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ToolSourceWriteLockedError);
    expect((failure as ToolSourceWriteLockedError).reason).toBe('deployment');
    expect(home.state.configuration).toBeUndefined();

    const routes = toolSourceRoutes(manager, () => undefined, { principal: () => owner });
    const request = Object.assign(
      new Request('http://127.0.0.1/host/tool-sources/pets/tools', {
        method: 'PUT',
        body: JSON.stringify({ tools: { 'delete-pet': { acceptsSecrets: true } } }),
      }),
      { params: { id: 'pets' } },
    );
    const response = await routes['/host/tool-sources/:id/tools'].PUT(
      request as unknown as Bun.BunRequest<'/host/tool-sources/:id/tools'>,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'locked', reason: 'deployment' });
  });

  test('is set on the route and answers 400 naming the field for a bad value', async () => {
    const home = memoryHome();
    const { manager } = await managerOver(home, await keysOf());
    await connectPets(manager);
    const routes = toolSourceRoutes(manager, () => undefined, { principal: () => owner });
    const put = (body: unknown) =>
      routes['/host/tool-sources/:id/tools'].PUT(
        Object.assign(
          new Request('http://127.0.0.1/host/tool-sources/pets/tools', {
            method: 'PUT',
            body: JSON.stringify(body),
          }),
          { params: { id: 'pets' } },
        ) as unknown as Bun.BunRequest<'/host/tool-sources/:id/tools'>,
      );

    const set = await put({ tools: { 'delete-pet': { acceptsSecrets: true } } });
    const bad = await put({ tools: { 'delete-pet': { acceptsSecrets: 'yes' } } });

    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ id: 'pets', changed: true, restartRequired: true });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: 'invalid',
      field: 'tools.delete-pet.acceptsSecrets',
    });
  });
});

describe('acceptsSecrets when a source is pointed somewhere else', () => {
  const flag = { 'delete-pet': { acceptsSecrets: true } };

  test('is dropped with the credentials when an OpenAPI baseUrl changes, kept when something else does, and audited', async () => {
    const home = memoryHome();
    const keys = await keysOf();
    const first = await managerOver(home, keys);
    await connectPets(first.manager);
    await first.manager.configureTools({ id: 'pets', tools: flag });

    // The same place with a narrower allow-list: still the owner's grant.
    await first.manager.connect({
      id: 'pets',
      source: { ...petsSource, allowOperations: ['deletePet', 'listPets'] },
      principal: owner,
    });
    expect(JSON.parse(home.state.configuration ?? '{}').toolSources[0].tools).toEqual(flag);

    // Another server: the flag was granted for the first one only.
    await first.manager.connect({
      id: 'pets',
      source: { ...petsSource, baseUrl: 'http://other.test/' },
      credentials: { key: 'other-key' },
      principal: owner,
    });
    expect(JSON.parse(home.state.configuration ?? '{}').toolSources[0]).not.toHaveProperty('tools');
    expect(first.audited.at(-1)).toMatchObject({
      type: 'tool.source.connected',
      detail: { revoked: ['delete-pet'] },
    });
    await first.manager.close();

    const requests: string[] = [];
    const second = await managerOver(home, keys, requests);
    await second.manager.start();
    expect(second.manager.tools()['pets__delete-pet']?.metadata).not.toHaveProperty(
      'acceptsSecrets',
    );
    const refused = await runToolbox(
      second.manager,
      ['pets__delete-pet'],
      async () => 'plain',
    ).execute({
      id: 'call-1',
      name: 'pets__delete-pet',
      arguments: { id: { secretRef: 'human-wait:run/password' } },
    });
    expect(JSON.stringify(refused)).toContain('secret-not-accepted');
    expect(requests).toEqual([]);
  });

  test('is dropped when a stdio source runs another command or another environment, and kept for the same command', async () => {
    const home = memoryHome();
    const { manager, audited } = await managerOver(home, await keysOf());
    const stdio = (command: string, env: Record<string, string> = {}) => ({
      id: 'local',
      kind: 'mcp',
      transport: { type: 'stdio', command, args: ['serve'], env },
    });
    const saved = () => JSON.parse(home.state.configuration ?? '{}').toolSources[0];
    await manager.connect({ id: 'local', source: stdio('first-server'), principal: owner });
    await manager.configureTools({ id: 'local', tools: { lookup: { acceptsSecrets: true } } });

    // Reconnecting the same command is the same place.
    await manager.connect({ id: 'local', source: stdio('first-server'), principal: owner });
    expect(saved().tools).toEqual({ lookup: { acceptsSecrets: true } });

    await manager.connect({ id: 'local', source: stdio('second-server'), principal: owner });
    expect(saved()).not.toHaveProperty('tools');
    expect(audited.at(-1)).toMatchObject({ detail: { revoked: ['lookup'] } });

    await manager.configureTools({ id: 'local', tools: { lookup: { acceptsSecrets: true } } });
    await manager.connect({
      id: 'local',
      source: stdio('second-server', { TARGET: 'elsewhere' }),
      principal: owner,
    });
    expect(saved()).not.toHaveProperty('tools');
  });

  test('names the tools granted and revoked in the audit record, and nothing else', async () => {
    const home = memoryHome();
    const { manager, audited } = await managerOver(home, await keysOf());
    await connectPets(manager);

    await manager.configureTools({
      id: 'pets',
      tools: { 'delete-pet': { acceptsSecrets: true }, 'create-pet': { acceptsSecrets: true } },
    });
    await manager.configureTools({
      id: 'pets',
      tools: { 'create-pet': { acceptsSecrets: false }, 'list-pets': { acceptsSecrets: true } },
    });

    const records = audited.filter((entry) => entry.type === 'tool.source.tools-configured');
    expect(records.map((entry) => entry.detail)).toEqual([
      {
        sourceId: 'pets',
        kind: 'openapi',
        owner,
        granted: ['create-pet', 'delete-pet'],
      },
      {
        sourceId: 'pets',
        kind: 'openapi',
        owner,
        granted: ['list-pets'],
        revoked: ['create-pet'],
      },
    ]);
  });
});

describe('acceptsSecrets on an MCP source tool', () => {
  test('is applied to the rebuilt tool, which keeps its tier and MCP metadata, and the unflagged tool stays refused', async () => {
    const server = await startMcpServer('mcp-token-fixture');
    servers.push(server);
    const home = memoryHome();
    const keys = await keysOf();
    const first = await managerOver(home, keys, [], false);
    await first.manager.connect({
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
      credentials: { token: 'mcp-token-fixture' },
      principal: owner,
    });
    await first.manager.start();
    const original = toolOf(first.manager, 'files__lookup');
    await first.manager.configureTools({
      id: 'files',
      tools: { lookup: { acceptsSecrets: true } },
    });
    await first.manager.close();

    const second = await managerOver(home, keys, [], false);
    await second.manager.start();

    const flagged = toolOf(second.manager, 'files__lookup');
    expect(flagged.metadata?.['acceptsSecrets']).toBe(true);
    expect(flagged.metadata?.['readOnly']).toBe(true);
    expect(flagged.metadata?.['mcp']).toEqual(original.metadata?.['mcp']);
    expect(second.manager.tools()['files__wipe']?.metadata).not.toHaveProperty('acceptsSecrets');
    const standing = await standingOf(second.manager);
    expect(standing?.tools.find((tool) => tool.name === 'files__lookup')).toMatchObject({
      tier: 'read-only',
      acceptsSecrets: true,
    });

    const asked: string[] = [];
    const toolbox = runToolbox(
      second.manager,
      ['files__lookup', 'files__wipe'],
      async (reference) => {
        asked.push(reference);
        return 'plain';
      },
    );
    const accepted = await toolbox.execute({
      id: 'call-1',
      name: 'files__lookup',
      arguments: { note: { secretRef: 'human-wait:run/password' } },
    });
    const refused = await toolbox.execute({
      id: 'call-2',
      name: 'files__wipe',
      arguments: { note: { secretRef: 'human-wait:run/password' } },
    });
    expect(accepted.outcome).toBe('success');
    expect(JSON.stringify(refused)).toContain('secret-not-accepted');
    expect(asked).toEqual(['human-wait:run/password']);
  });
});
