/**
 * COR-1931: the tool-source manager's removal over an in-memory home. These pin what the host test
 * does not reach: which agent files count as affected, the remote lock on a removal while the
 * preview still reads, and a sign-in that was still starting when the source was removed.
 */
import type { AnswerEncryptionKeys } from '@lostgradient/bureau';
import { afterEach, describe, expect, test } from 'bun:test';

import type { AgentToolUse } from './tool-source-agents.ts';
import {
  createToolSourceManager,
  ToolSourceInputError,
  ToolSourceWriteLockedError,
  type ToolSourceAuditEntry,
  type ToolSourceManager,
} from './tool-source-manager.ts';
import { keysOf, memoryHome } from './tool-source-memory-home.test-support.ts';
import { toolSourceRoutes } from './tool-source-routes.ts';
import { petsDocument, startOAuthMcpServer } from './tool-source-servers.test-support.ts';
import { toolSourceSecretKey } from './tool-source-vault.ts';

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
  extra: { fetch?: typeof fetch; keys?: AnswerEncryptionKeys } = {},
): Promise<{ manager: ToolSourceManager; audited: ToolSourceAuditEntry[] }> {
  const audited: ToolSourceAuditEntry[] = [];
  const manager = createToolSourceManager({
    bungalow: home.bungalow,
    keys: extra.keys ?? (await keysOf()),
    audit: async (entry) => void audited.push(entry),
    origin: () => 'http://127.0.0.1:1',
    agentToolUse: async () => agents,
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

describe('a sign-in that is starting when its source is removed', () => {
  test('leaves no OAuth state behind, and fails as an unknown source', async () => {
    const oauth = await startOAuthMcpServer();
    closers.push(() => oauth.stop());
    const home = memoryHome();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    // The first request the loader makes waits, so the removal lands while the sign-in starts.
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
    const { manager } = await started(home, { fetch: gated });
    await manager.connect({
      id: 'calendar',
      source: {
        id: 'calendar',
        kind: 'mcp',
        transport: { type: 'http', url: `${oauth.origin}/`, authentication: { type: 'oauth' } },
      },
      principal: owner,
    });

    const signingIn = manager.authorize('calendar');
    await entered.promise;
    await manager.remove({ id: 'calendar', principal: owner });
    release.resolve();
    const failure = await failureOf(signingIn);

    expect(failure).toBeInstanceOf(ToolSourceInputError);
    expect((failure as ToolSourceInputError).kind).toBe('unknown-source');
    expect(home.state.secrets.get(toolSourceSecretKey('calendar')) ?? '').toBe('');
  });
});
