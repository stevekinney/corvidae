/**
 * COR-2022: what a saved source carries besides its description, and how it reads back. A source
 * has a `name`, a `description` and an `address` a person recognises it by, and when the host last
 * reached it (`lastTested`); each tool has a Default asks level beside acceptsSecrets and enabled,
 * saved one control at a time. A connection carries the person's choice of tools, and a saved
 * source can be tested with what the vault holds for it. The sources are OpenAPI documents held in
 * memory and every request goes to a stub fetch.
 */
import type { AnswerEncryptionKeys } from '@lostgradient/bureau';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  createToolSourceManager,
  ToolSourceInputError,
  type ToolSourceManager,
} from './tool-source-manager.ts';
import {
  fixtureToolSourceMutation,
  keysOf,
  memoryHome,
} from './tool-source-memory-home.test-support.ts';
import { toolSourceRoutes } from './tool-source-routes.ts';
import { petsDocument } from './tool-source-servers.test-support.ts';

const owner = 'anonymous:local';

/** The moment the manager's clock reads, so `lastTested` can be compared exactly. */
const NOW = Date.UTC(2026, 10, 11, 9, 0, 0);

const petsSource = {
  id: 'pets',
  kind: 'openapi',
  specification: { type: 'document', document: petsDocument },
  baseUrl: 'http://pets.test/',
  authentication: { type: 'api-key', header: 'x-api-key', credential: 'key' },
};

const closers: ToolSourceManager[] = [];

afterEach(async () => {
  for (const manager of closers.splice(0)) await manager.close();
});

/** A manager over `home`, as a host start would make one, whose tools call a stub fetch. */
function managerOver(home: ReturnType<typeof memoryHome>, keys: AnswerEncryptionKeys) {
  const manager = createToolSourceManager({
    bungalow: home.bungalow,
    keys,
    audit: async () => undefined,
    origin: () => 'http://127.0.0.1:1',
    now: () => NOW,
    fetch: Object.assign(async () => Response.json({ ok: true }), {
      preconnect: () => undefined,
    }),
  });
  closers.push(manager);
  return manager;
}

/** The first `toolSources` entry as the configuration file holds it. */
function savedEntry(home: ReturnType<typeof memoryHome>): Record<string, unknown> {
  return JSON.parse(home.state.configuration ?? '{}').toolSources[0];
}

/** The first source the manager reports now. */
async function standingOf(manager: ToolSourceManager) {
  const snapshot = await manager.snapshot();
  return snapshot.sources[0];
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('a saved source’s name, description and choice of tools', () => {
  test('are saved on connect, trimmed, and read back with the address', async () => {
    const home = memoryHome();
    const manager = managerOver(home, await keysOf());

    await manager.connect({
      id: 'pets',
      source: petsSource,
      credentials: { key: 'k' },
      principal: owner,
      name: ' Payments API ',
      description: 'Invoices and refunds.',
      tools: {
        'delete-pet': { enabled: false },
        'create-pet': { approval: 'always' },
        // `null` is the tier's level, which leaves nothing behind.
        'list-pets': { approval: null },
      },
    });

    expect(savedEntry(home)).toMatchObject({
      name: 'Payments API',
      description: 'Invoices and refunds.',
    });
    expect(savedEntry(home)['tools']).toEqual({
      'delete-pet': { enabled: false },
      'create-pet': { approval: 'always' },
    });
    expect(await standingOf(manager)).toMatchObject({
      id: 'pets',
      name: 'Payments API',
      description: 'Invoices and refunds.',
      // An uploaded spec is shown by its base URL.
      address: 'http://pets.test/',
    });
  });

  test('load at the next start with each tool on or off at its Default asks level', async () => {
    const home = memoryHome();
    const keys = await keysOf();
    const first = managerOver(home, keys);
    await first.connect({
      id: 'pets',
      source: petsSource,
      credentials: { key: 'k' },
      principal: owner,
      tools: { 'delete-pet': { enabled: false }, 'create-pet': { approval: 'always' } },
    });
    // Not live and not loaded: nothing has reached it yet.
    expect(await standingOf(first)).not.toHaveProperty('lastTested');
    await first.close();

    const second = managerOver(home, keys);
    await second.start();
    const standing = await standingOf(second);

    expect(standing?.state).toBe('loaded');
    expect(standing?.lastTested).toBe(new Date(NOW).toISOString());
    expect(
      standing?.tools
        .map((tool) => [tool.tool, tool.enabled, tool.approval, tool.approvalSaved])
        .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
    ).toEqual([
      ['create-pet', true, 'always', true],
      // A dangerous tool starts on Always; it is off, and its level stays the tier's.
      ['delete-pet', false, 'always', false],
      ['list-pets', true, 'never', false],
    ]);
    expect(Object.keys(second.tools()).toSorted()).toEqual(['pets__create-pet', 'pets__list-pets']);
  });

  test('a connect that changes only a label writes it and keeps the tools and credentials', async () => {
    const home = memoryHome();
    const manager = managerOver(home, await keysOf());
    const connect = (extra: Record<string, unknown>) =>
      manager.connect({ id: 'pets', source: petsSource, principal: owner, ...extra });
    await connect({
      credentials: { key: 'k' },
      name: 'Pets',
      description: 'A pet store.',
      tools: { 'delete-pet': { enabled: false } },
    });

    // No credentials: the one held goes to the same place, so it is kept.
    const renamed = await connect({ name: 'Pet store', description: '' });

    expect(renamed).toMatchObject({ id: 'pets', changed: true });
    expect(savedEntry(home)).toMatchObject({
      name: 'Pet store',
      tools: { 'delete-pet': { enabled: false } },
    });
    expect(savedEntry(home)).not.toHaveProperty('description');
    // Labels left out are kept, and the same request again changes nothing.
    expect(await connect({})).toMatchObject({ changed: false });
    expect(savedEntry(home)).toMatchObject({ name: 'Pet store' });
  });

  test('refuses Blocked, a level it does not know, and a label it cannot show, writing nothing', async () => {
    const home = memoryHome();
    const manager = managerOver(home, await keysOf());
    const cases: [Record<string, unknown>, string][] = [
      [{ tools: { 'delete-pet': { approval: 'blocked' } } }, 'tools.delete-pet.approval'],
      [{ tools: { 'delete-pet': { approval: 'sometimes' } } }, 'tools.delete-pet.approval'],
      [{ tools: { 'delete-pet': { approval: true } } }, 'tools.delete-pet.approval'],
      [{ name: '' }, 'name'],
      [{ name: '   ' }, 'name'],
      [{ name: 'Pay\nments' }, 'name'],
      [{ name: 'x'.repeat(81) }, 'name'],
      [{ description: 42 }, 'description'],
      [{ description: 'y'.repeat(501) }, 'description'],
    ];
    for (const [extra, field] of cases) {
      const failure = await failureOf(
        manager.connect({
          id: 'pets',
          source: petsSource,
          credentials: { key: 'k' },
          principal: owner,
          ...extra,
        }),
      );
      expect(failure, field).toBeInstanceOf(ToolSourceInputError);
      expect((failure as ToolSourceInputError).field).toBe(field);
    }
    expect(home.state.configuration).toBeUndefined();
  });
});

describe('a tool’s settings, saved one control at a time', () => {
  test('a Default asks level keeps the tool off, the On checkbox keeps the level, and defaults leave nothing', async () => {
    const home = memoryHome();
    const manager = managerOver(home, await keysOf());
    await manager.connect({
      id: 'pets',
      source: petsSource,
      credentials: { key: 'k' },
      principal: owner,
      name: 'Pets',
      tools: { 'delete-pet': { enabled: false } },
    });

    await manager.configureTools({
      id: 'pets',
      tools: { 'delete-pet': { approval: 'on-changes' } },
    });
    expect(savedEntry(home)['tools']).toEqual({
      'delete-pet': { enabled: false, approval: 'on-changes' },
    });

    // The Accepts secrets switch, which sends only its own field, no longer turns the tool back on.
    await manager.configureTools({ id: 'pets', tools: { 'delete-pet': { acceptsSecrets: true } } });
    expect(savedEntry(home)['tools']).toEqual({
      'delete-pet': { acceptsSecrets: true, enabled: false, approval: 'on-changes' },
    });

    await manager.configureTools({ id: 'pets', tools: { 'delete-pet': { enabled: true } } });
    const standing = await standingOf(manager);
    expect(standing?.state).toBe('pending-restart');

    await manager.configureTools({
      id: 'pets',
      tools: { 'delete-pet': { acceptsSecrets: false, approval: null } },
    });
    expect(savedEntry(home)).not.toHaveProperty('tools');
    // A change to the tools keeps the source's labels.
    expect(savedEntry(home)).toMatchObject({ name: 'Pets' });
  });

  test('Blocked is refused for a tool of a source', async () => {
    const home = memoryHome();
    const manager = managerOver(home, await keysOf());
    await manager.connect({
      id: 'pets',
      source: petsSource,
      credentials: { key: 'k' },
      principal: owner,
    });
    const before = home.state.configuration;

    const failure = await failureOf(
      manager.configureTools({ id: 'pets', tools: { 'delete-pet': { approval: 'blocked' } } }),
    );

    expect(failure).toBeInstanceOf(ToolSourceInputError);
    expect((failure as ToolSourceInputError).field).toBe('tools.delete-pet.approval');
    expect((failure as Error).message).toContain('Access tab');
    expect(home.state.configuration).toBe(before);
  });
});

describe('a saved source’s address', () => {
  test('is cut to its origin and path, so a key in its query or fragment never leaves', async () => {
    const home = memoryHome();
    const manager = managerOver(home, await keysOf());
    await manager.connect({
      id: 'tracker',
      source: {
        id: 'tracker',
        kind: 'mcp',
        transport: { type: 'http', url: 'https://mcp.example.test/mcp?key=hunter2#also-hunter2' },
      },
      principal: owner,
    });

    const snapshot = await manager.snapshot();

    expect(snapshot.sources[0]).toMatchObject({
      address: 'https://mcp.example.test/mcp',
      name: null,
      description: null,
    });
    expect(JSON.stringify(snapshot)).not.toContain('hunter2');
  });
});

describe('testing a saved source (Test connection)', () => {
  test('lists its tools with the credentials the vault holds and moves lastTested', async () => {
    const home = memoryHome();
    const manager = managerOver(home, await keysOf());
    await manager.connect({
      id: 'pets',
      source: petsSource,
      credentials: { key: 'k' },
      principal: owner,
    });
    const before = home.state.configuration;

    const answer = await manager.test('pets');

    expect(answer.outcome).toBe('listed');
    expect(
      answer.outcome === 'listed' ? answer.tools.map((tool) => tool.tool).toSorted() : [],
    ).toEqual(['create-pet', 'delete-pet', 'list-pets']);
    expect((await standingOf(manager))?.lastTested).toBe(new Date(NOW).toISOString());
    // A test saves nothing, and the running host's catalog is not touched.
    expect(home.state.configuration).toBe(before);
    expect(Object.keys(manager.tools())).toEqual([]);
  });

  test('answers 200 on its route, and 404 for a source the configuration does not list', async () => {
    const home = memoryHome();
    const manager = managerOver(home, await keysOf());
    await manager.connect({
      id: 'pets',
      source: petsSource,
      credentials: { key: 'k' },
      principal: owner,
    });
    const routes = toolSourceRoutes(manager, () => undefined, {
      mutation: fixtureToolSourceMutation(manager, owner),
    });
    const post = (id: string) =>
      routes['/host/tool-sources/:id/test'].POST(
        Object.assign(
          new Request(`http://127.0.0.1/host/tool-sources/${id}/test`, { method: 'POST' }),
          { params: { id } },
        ) as unknown as Bun.BunRequest<'/host/tool-sources/:id/test'>,
      );

    const listed = await post('pets');
    const missing = await post('nope');

    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ outcome: 'listed' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'not-found' });
  });
});
