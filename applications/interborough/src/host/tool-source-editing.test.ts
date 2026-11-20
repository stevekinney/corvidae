/**
 * COR-2436, Edit connection: the read the Connect tools page edits a saved source from, and the
 * save it makes. The read sends a description that names credentials and holds none, refuses a
 * caller who may not change sources before it looks the source up, and refuses a source the page
 * cannot show exactly. The save keeps a stored credential left blank and the per-tool settings,
 * replaces the same source id, and is fenced on the revision the page read.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { createHostMutationContext, HostMutationError } from './host-mutation-context.ts';
import {
  createToolSourceManager,
  ToolSourceInputError,
  ToolSourceNotEditableError,
  ToolSourceWriteLockedError,
  type ToolSourceManager,
} from './tool-source-manager.ts';
import {
  fixtureToolSourceMutation,
  keysOf,
  memoryHome,
} from './tool-source-memory-home.test-support.ts';
import { toolSourceRoutes } from './tool-source-routes.ts';
import { localWorkspaceMembership } from './workspace-principal.ts';

const closers: ToolSourceManager[] = [];
afterEach(async () => {
  for (const manager of closers.splice(0)) await manager.close();
});

const owner = 'anonymous:local';

const github = (url = 'http://127.0.0.1:9/mcp') =>
  ({
    id: 'github',
    kind: 'mcp',
    transport: { type: 'http', url, authentication: { type: 'bearer', credential: 'token' } },
  }) as const;

async function managerOver(home: ReturnType<typeof memoryHome>): Promise<ToolSourceManager> {
  const manager = createToolSourceManager({
    bungalow: home.bungalow,
    keys: await keysOf(),
    audit: async () => {},
    origin: () => 'http://127.0.0.1:1',
  });
  closers.push(manager);
  return manager;
}

/** A mutation as the routes make one, at `expectedRevision`, for a member who may or may not manage. */
async function mutationAt(expectedRevision: string | null, manages = true) {
  const directory = localWorkspaceMembership('fixture-workspace');
  const member = await directory.resolveOwnerMembership?.(owner);
  if (member == null) throw new Error('Missing local fixture member');
  const identity = member;
  const later = manages ? identity : { ...identity, capabilities: [] };
  return createHostMutationContext(
    identity,
    { operationId: crypto.randomUUID(), expectedRevision },
    async () => later,
  );
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function saved(manager: ToolSourceManager, source: Record<string, unknown> = github()) {
  await manager.connect({
    id: 'github',
    source,
    credentials: { token: 'SECRET-TOKEN-7f3a' },
    principal: owner,
    name: 'GitHub',
    description: 'An MCP server for issues and files in your repositories.',
    tools: { delete_branch: { enabled: false } },
  });
}

describe('reading a saved source to edit it', () => {
  test('sends the description, labels, credential names and revision, and never a value', async () => {
    const home = memoryHome();
    const manager = await managerOver(home);
    await saved(manager);
    const { configurationRevision } = await manager.snapshot();

    const editing = await manager.editing('github', await mutationAt(null));

    expect(editing).toEqual({
      id: 'github',
      source: github(),
      name: 'GitHub',
      description: 'An MCP server for issues and files in your repositories.',
      credentials: ['token'],
      configurationRevision,
    });
    expect(JSON.stringify(editing)).not.toContain('SECRET-TOKEN-7f3a');
  });

  test('refuses a caller who may not change sources before it looks the source up', async () => {
    const home = memoryHome();
    const manager = await managerOver(home);
    await saved(manager);

    const known = await failureOf(manager.editing('github', await mutationAt(null, false)));
    const unknown = await failureOf(manager.editing('nothing', await mutationAt(null, false)));

    // The same refusal for a source that exists and one that does not.
    expect(known).toBeInstanceOf(HostMutationError);
    expect(unknown).toBeInstanceOf(HostMutationError);
  });

  test('answers unknown-source for a source that is not saved, and is refused on a remote home', async () => {
    const manager = await managerOver(memoryHome());
    const missing = await failureOf(manager.editing('nothing', await mutationAt(null)));
    expect(missing).toBeInstanceOf(ToolSourceInputError);
    expect((missing as ToolSourceInputError).kind).toBe('unknown-source');

    const remote = await managerOver(memoryHome('remote'));
    expect(await failureOf(remote.editing('github'))).toBeInstanceOf(ToolSourceWriteLockedError);
  });

  test('refuses a source the page cannot show exactly, saying why', async () => {
    const reasons: Record<string, unknown> = {};
    for (const [label, source] of [
      ['query', github('http://127.0.0.1:9/mcp?key=QUERY-KEY')],
      [
        'scope',
        {
          id: 'github',
          kind: 'mcp',
          transport: {
            type: 'http',
            url: 'http://127.0.0.1:9/mcp',
            authentication: { type: 'oauth', scope: 'repo' },
          },
        },
      ],
      [
        'command',
        { id: 'github', kind: 'mcp', transport: { type: 'stdio', command: 'github-mcp' } },
      ],
    ] as const) {
      const home = memoryHome();
      const manager = await managerOver(home);
      await manager.connect({
        id: 'github',
        source,
        credentials: label === 'query' ? { token: 'k' } : {},
        principal: owner,
      });
      const failure = await failureOf(manager.editing('github', await mutationAt(null)));
      expect(failure).toBeInstanceOf(ToolSourceNotEditableError);
      expect(JSON.stringify(failure)).not.toContain('QUERY-KEY');
      reasons[label] = (failure as ToolSourceNotEditableError).reason;
    }
    expect(reasons).toEqual({
      query: 'address-query',
      scope: 'unshown-settings',
      command: 'local-command',
    });
  });
});

describe('the routes of an edit', () => {
  test('the PUT saves the labels it names, and the read answers 409 not-editable with the reason', async () => {
    const home = memoryHome();
    const manager = await managerOver(home);
    const routes = toolSourceRoutes(manager, () => undefined, {
      mutation: fixtureToolSourceMutation(manager, owner),
    });
    const put = Object.assign(
      new Request('http://127.0.0.1/host/tool-sources/github', {
        method: 'PUT',
        body: JSON.stringify({
          source: github(),
          credentials: { token: 'k' },
          name: 'GitHub',
          description: 'Issues and files.',
        }),
      }),
      { params: { id: 'github' } },
    );
    const saving = await routes['/host/tool-sources/:id'].PUT(
      put as unknown as Bun.BunRequest<'/host/tool-sources/:id'>,
    );
    expect(saving.status).toBe(200);
    const snapshot = await manager.snapshot();
    expect(snapshot.sources[0]).toMatchObject({ name: 'GitHub', description: 'Issues and files.' });

    await manager.connect({
      id: 'github',
      source: github('http://127.0.0.1:9/mcp?key=QUERY-KEY'),
      credentials: { token: 'k' },
      principal: owner,
    });
    const read = Object.assign(new Request('http://127.0.0.1/host/tool-sources/github/editing'), {
      params: { id: 'github' },
    });
    const refused = await routes['/host/tool-sources/:id/editing'].GET(
      read as unknown as Bun.BunRequest<'/host/tool-sources/:id/editing'>,
    );
    expect(refused.status).toBe(409);
    const body = await refused.text();
    expect(JSON.parse(body)).toMatchObject({ error: 'not-editable', reason: 'address-query' });
    expect(body).not.toContain('QUERY-KEY');
  });
});

describe('testing an edit with a stored credential left blank', () => {
  test('uses the stored credential only while the source still goes to the same place', async () => {
    const seen: string[] = [];
    const home = memoryHome();
    const manager = createToolSourceManager({
      bungalow: home.bungalow,
      keys: await keysOf(),
      audit: async () => {},
      origin: () => 'http://127.0.0.1:1',
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('authorization') ?? '');
        return new Response('down', { status: 503 });
      }) as unknown as typeof fetch,
    });
    closers.push(manager);
    await saved(manager);

    // The same address, no token: the probe sends the stored one.
    await manager.probe(
      { id: 'github', source: github(), principal: owner },
      await mutationAt(null),
    );
    expect(seen.some((value) => value === 'Bearer SECRET-TOKEN-7f3a')).toBe(true);

    // Another address, no token: refused before anything is contacted.
    seen.length = 0;
    const elsewhere = await failureOf(
      manager.probe(
        { id: 'github', source: github('http://127.0.0.1:8/elsewhere'), principal: owner },
        await mutationAt(null),
      ),
    );
    expect(elsewhere).toBeInstanceOf(ToolSourceInputError);
    expect((elsewhere as ToolSourceInputError).field).toBe('credentials.token');
    expect(seen).toEqual([]);
  });
});

describe('a probe with the key left blank, while another administrator re-points the source', () => {
  // The re-point commits after the probe's Nth read of the configuration. Whichever read it is, the
  // key stored for the new address must never be sent to the address the probe was asked about.
  for (const after of [1, 2, 3, 4]) {
    test(`never sends the new address's key to the old one (re-point after read ${String(after)})`, async () => {
      const sent: string[] = [];
      const home = memoryHome();
      let armed = false;
      let reads = 0;
      let manager: ToolSourceManager | undefined;
      const bungalow = {
        ...home.bungalow,
        readConfiguration: async () => {
          const read = await home.bungalow.readConfiguration();
          if (armed) {
            reads += 1;
            if (reads === after) {
              armed = false;
              await manager?.connect({
                id: 'github',
                source: github('http://127.0.0.1:8/elsewhere'),
                credentials: { token: 'KEY-FOR-THE-NEW-ADDRESS' },
                principal: owner,
                name: 'GitHub',
              });
            }
          }
          return read;
        },
      };
      manager = createToolSourceManager({
        bungalow,
        keys: await keysOf(),
        audit: async () => {},
        origin: () => 'http://127.0.0.1:1',
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          sent.push(
            `${String(input instanceof Request ? input.url : input)} ${new Headers(init?.headers).get('authorization') ?? ''}`,
          );
          return new Response('down', { status: 503 });
        }) as unknown as typeof fetch,
      });
      closers.push(manager);
      await saved(manager);

      armed = true;
      await failureOf(
        manager.probe({ id: 'github', source: github(), principal: owner }, await mutationAt(null)),
      );

      expect(
        sent.filter((line) => line.includes('127.0.0.1:9') && line.includes('KEY-FOR')),
      ).toEqual([]);
    });
  }
});

describe('saving an edit', () => {
  test('keeps the stored credential left blank and the per-tool settings, under the same id', async () => {
    const home = memoryHome();
    const manager = await managerOver(home);
    await saved(manager);
    const before = await manager.editing('github', await mutationAt(null));

    // The page's save: the same description, no credential, no tools, a new name, at the revision read.
    const change = await manager.connect(
      { id: 'github', source: before.source, principal: owner, name: 'GitHub Enterprise' },
      await mutationAt(before.configurationRevision),
    );

    expect(change.changed).toBe(true);
    const after = await manager.editing('github', await mutationAt(null));
    expect(after.name).toBe('GitHub Enterprise');
    expect(after.credentials).toEqual(['token']);
    const document = JSON.parse(home.state.configuration ?? '{}') as {
      toolSources: { source: { id: string }; tools?: unknown }[];
    };
    expect(document.toolSources).toHaveLength(1);
    expect(document.toolSources[0]?.tools).toEqual({ delete_branch: { enabled: false } });
  });

  test('is refused when the source changed since the page read it', async () => {
    const home = memoryHome();
    const manager = await managerOver(home);
    await saved(manager);
    const read = await manager.editing('github', await mutationAt(null));
    // Another tab saves first.
    await manager.connect(
      { id: 'github', source: read.source, principal: owner, name: 'Someone else' },
      await mutationAt(read.configurationRevision),
    );

    const stale = await failureOf(
      manager.connect(
        { id: 'github', source: read.source, principal: owner, name: 'Mine' },
        await mutationAt(read.configurationRevision),
      ),
    );

    expect(stale).toBeDefined();
    const after = await manager.editing('github', await mutationAt(null));
    expect(after.name).toBe('Someone else');
  });
});
