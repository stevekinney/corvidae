/** The client for the host's tool-source routes: what it sends, what it reads, and what it never repeats. */
import { describe, expect, test } from 'bun:test';

import {
  authorizeToolSource,
  connectToolSource,
  getToolSources,
  HOST_TOOL_SOURCES_ROUTE,
  HostToolSourceError,
  previewToolSourceRemoval,
  probeToolSource,
  removeToolSource,
  setAcceptsSecrets,
} from './host-tool-sources.ts';

const MUTATION = { operationId: 'sign-in-test', expectedRevision: null };

const SNAPSHOT = {
  configurationRevision: null,
  sources: [
    {
      id: 'notes',
      kind: 'mcp',
      localCommand: false,
      state: 'loaded',
      tools: [
        {
          name: 'notes__wipe',
          tool: 'wipe',
          acceptsSecrets: false,
          savedAcceptsSecrets: true,
          tier: 'dangerous',
        },
      ],
      skipped: [],
      unmatchedSettings: [],
      settingsPending: true,
      credentials: ['notes-token'],
    },
    {
      id: 'ledger',
      kind: 'mcp',
      localCommand: false,
      state: 'needs-authorization',
      tools: [],
      skipped: [],
      unmatchedSettings: [],
      credentials: [],
      authorized: false,
    },
  ],
};

type Seen = { path: string; method: string | undefined; body: string | undefined };

function recording(respond: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const entry: Seen = {
      path: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    seen.push(entry);
    return respond(entry);
  };
  return { seen, fetch };
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('getToolSources', () => {
  test('asks the host and reads each source, its tools and the saved setting beside the applied one', async () => {
    const { seen, fetch } = recording(() => Response.json(SNAPSHOT));
    const snapshot = await getToolSources({ fetch });
    expect(seen.map((entry) => entry.path)).toEqual([HOST_TOOL_SOURCES_ROUTE]);
    expect(snapshot.sources.map((source) => source.id)).toEqual(['notes', 'ledger']);
    expect(snapshot.sources[0]?.tools[0]).toMatchObject({
      acceptsSecrets: false,
      savedAcceptsSecrets: true,
    });
    expect(snapshot.sources[1]?.authorized).toBe(false);
    expect(snapshot.lockReason).toBeUndefined();
  });

  test('reads the reason a remote host refuses writes', async () => {
    const { fetch } = recording(() => Response.json({ ...SNAPSHOT, lockReason: 'deployment' }));
    const snapshot = await getToolSources({ fetch });
    expect(snapshot.lockReason).toBe('deployment');
  });

  test('fails for a refused request and for an answer it cannot read', async () => {
    const refused = recording(() => new Response('no', { status: 403 }));
    expect(await failureOf(getToolSources({ fetch: refused.fetch }))).toBeInstanceOf(Error);
    const unreadable = recording(() => Response.json({ sources: 'none' }));
    expect(await failureOf(getToolSources({ fetch: unreadable.fetch }))).toBeDefined();
  });
});

describe('setAcceptsSecrets', () => {
  test('puts the named tools’ own names to the source’s tools route and nothing else', async () => {
    const { seen, fetch } = recording(() =>
      Response.json({ id: 'notes', changed: true, restartRequired: true }),
    );
    await setAcceptsSecrets('notes', { wipe: true, lookup: false }, { mutation: MUTATION, fetch });
    expect(seen).toEqual([
      {
        path: `${HOST_TOOL_SOURCES_ROUTE}/notes/tools`,
        method: 'PUT',
        body: JSON.stringify({
          tools: { wipe: { acceptsSecrets: true }, lookup: { acceptsSecrets: false } },
          ...MUTATION,
        }),
      },
    ]);
  });

  test('encodes an identifier that holds a character an address cannot', async () => {
    const { seen, fetch } = recording(() =>
      Response.json({ id: 'a b', changed: false, restartRequired: true }),
    );
    await setAcceptsSecrets('a b', {}, { mutation: MUTATION, fetch });
    expect(seen[0]?.path).toBe(`${HOST_TOOL_SOURCES_ROUTE}/a%20b/tools`);
  });

  test('names the field the host refused, in the host’s words', async () => {
    const { fetch } = recording(() =>
      Response.json(
        {
          error: 'invalid',
          field: 'tools.wipe.acceptsSecrets',
          message: 'expected true or false.',
        },
        { status: 400 },
      ),
    );
    expect(
      await failureOf(setAcceptsSecrets('notes', { wipe: true }, { mutation: MUTATION, fetch })),
    ).toMatchObject({
      kind: 'invalid',
      field: 'tools.wipe.acceptsSecrets',
      message: 'expected true or false.',
    });
  });

  test('reports each kind of refusal by kind', async () => {
    const answers = [
      [{ error: 'locked', reason: 'deployment', message: 'Change it there.' }, 403, 'locked'],
      [{ error: 'owner-only', message: 'Only the owner.' }, 403, 'owner-only'],
      [{ error: 'not-found', field: 'source', message: 'Not a source.' }, 404, 'not-found'],
      [{ error: 'partial', message: 'Half done.' }, 500, 'partial'],
      [{ error: 'failed', message: 'Nope.' }, 500, 'failed'],
    ] as const;
    for (const [body, status, kind] of answers) {
      const { fetch } = recording(() => Response.json(body, { status }));
      const failure = await failureOf(
        setAcceptsSecrets('notes', { wipe: true }, { mutation: MUTATION, fetch }),
      );
      expect(failure).toBeInstanceOf(HostToolSourceError);
      expect(failure).toMatchObject({ kind, message: body.message });
    }
  });

  test('treats an answer that is not JSON as a failure with no message', async () => {
    const { fetch } = recording(() => new Response('<html>', { status: 502 }));
    expect(
      await failureOf(setAcceptsSecrets('notes', { wipe: true }, { mutation: MUTATION, fetch })),
    ).toMatchObject({
      kind: 'failed',
      message: '',
    });
  });

  test('fails when a success answer is not the shape the host documents', async () => {
    const { fetch } = recording(() => Response.json({ id: 'notes' }));
    expect(
      await failureOf(setAcceptsSecrets('notes', { wipe: true }, { mutation: MUTATION, fetch })),
    ).toMatchObject({
      kind: 'failed',
    });
  });
});

describe('setToolSettings (COR-2022)', () => {
  test('puts only the fields a control changed, so the host keeps the rest', async () => {
    const { seen, fetch } = recording(() =>
      Response.json({ id: 'notes', changed: true, restartRequired: true }),
    );
    const tools = { wipe: { enabled: false }, lookup: { approval: null } };

    await setToolSettings('notes', tools, { mutation: MUTATION, fetch });

    expect(seen).toEqual([
      {
        path: `${HOST_TOOL_SOURCES_ROUTE}/notes/tools`,
        method: 'PUT',
        body: JSON.stringify({
          tools: { wipe: { enabled: false }, lookup: { approval: null } },
          ...MUTATION,
        }),
      },
    ]);
  });

  test('names the field the host refused, Blocked among them', async () => {
    const { fetch } = recording(() =>
      Response.json(
        {
          error: 'invalid',
          field: 'tools.wipe.approval',
          message: 'Invalid tools.wipe.approval: blocked is set for one agent, on its Access tab.',
        },
        { status: 400 },
      ),
    );

    expect(
      await failureOf(
        setToolSettings('notes', { wipe: { approval: 'always' } }, { mutation: MUTATION, fetch }),
      ),
    ).toMatchObject({ kind: 'invalid', field: 'tools.wipe.approval' });
  });
});

describe('testToolSource (COR-2022)', () => {
  test('posts to the saved source’s test route and reads the answer as a probe’s', async () => {
    const { seen, fetch } = recording(() =>
      Response.json({
        outcome: 'listed',
        tools: [{ name: 'notes__wipe', tool: 'wipe', tier: 'dangerous' }],
        skipped: [],
      }),
    );

    const answer = await testToolSource('notes', { fetch });

    expect(seen).toEqual([
      { path: `${HOST_TOOL_SOURCES_ROUTE}/notes/test`, method: 'POST', body: '{}' },
    ]);
    expect(answer).toMatchObject({ outcome: 'listed', tools: [{ tool: 'wipe' }] });
  });

  test('reports a failed test as an answer, and a missing source as a refusal', async () => {
    const failed = recording(() =>
      Response.json({ outcome: 'failed', message: 'The source did not answer in time.' }),
    );
    expect(await testToolSource('notes', { fetch: failed.fetch })).toEqual({
      outcome: 'failed',
      message: 'The source did not answer in time.',
    });
    const missing = recording(() =>
      Response.json(
        { error: 'not-found', field: 'source', message: 'Not a source.' },
        { status: 404 },
      ),
    );
    expect(await failureOf(testToolSource('nope', { fetch: missing.fetch }))).toMatchObject({
      kind: 'not-found',
    });
  });
});

describe('a source’s standing fields (COR-2022)', () => {
  test('reads its name, description, address, lastTested and each tool’s level', async () => {
    const source = {
      ...SNAPSHOT.sources[0],
      name: 'Notes',
      description: 'Notes you keep.',
      address: 'https://mcp.notes.example/mcp',
      lastTested: '2026-11-11T09:00:00.000Z',
      tools: [
        {
          name: 'notes__lookup',
          tool: 'lookup',
          acceptsSecrets: false,
          savedAcceptsSecrets: false,
          enabled: true,
          savedEnabled: true,
          tier: 'read-only',
          approval: 'never',
          approvalSaved: false,
        },
        {
          name: 'notes__wipe',
          tool: 'wipe',
          acceptsSecrets: false,
          savedAcceptsSecrets: false,
          enabled: true,
          savedEnabled: false,
          tier: 'dangerous',
          approval: 'always',
          approvalSaved: false,
        },
      ],
    };
    const { fetch } = recording(() => Response.json({ ...SNAPSHOT, sources: [source] }));

    const [read] = (await getToolSources({ fetch })).sources;

    expect(read).toMatchObject({
      name: 'Notes',
      description: 'Notes you keep.',
      address: 'https://mcp.notes.example/mcp',
      lastTested: '2026-11-11T09:00:00.000Z',
    });
    expect(read?.tools.map((tool) => tool.approval)).toEqual(['never', 'always']);
    // Saved off counts as off, whatever the running host still offers (row 31r).
    expect(read === undefined ? undefined : toolsOnCount(read)).toEqual({ on: 1, total: 2 });
    // A source from a host that sends none of them still reads, its tools all on.
    expect(toolsOnCount(SNAPSHOT.sources[0] as Parameters<typeof toolsOnCount>[0])).toEqual({
      on: 1,
      total: 1,
    });
  });

  test('refuses Blocked as a tool’s level in the answer', async () => {
    const source = {
      ...SNAPSHOT.sources[0],
      tools: [{ ...SNAPSHOT.sources[0]?.tools[0], approval: 'blocked' }],
    };
    const { fetch } = recording(() => Response.json({ ...SNAPSHOT, sources: [source] }));
    expect(await failureOf(getToolSources({ fetch }))).toBeDefined();
  });
});

describe('authorizeToolSource', () => {
  test('a new sign-in fetches the committed revision before allocating its request identity', async () => {
    const { seen, fetch } = recording((entry) =>
      entry.path === HOST_TOOL_SOURCES_ROUTE
        ? Response.json({ ...SNAPSHOT, configurationRevision: 'current-revision' })
        : Response.json({ authorized: true }),
    );
    await authorizeToolSource('ledger', { fetch });
    expect(seen.map((entry) => entry.path)).toEqual([
      HOST_TOOL_SOURCES_ROUTE,
      `${HOST_TOOL_SOURCES_ROUTE}/ledger/authorize`,
    ]);
    expect(JSON.parse(seen[1]?.body ?? '{}')).toMatchObject({
      expectedRevision: 'current-revision',
      operationId: expect.any(String),
    });
  });

  test('posts to the source’s authorize route and reads the address to open', async () => {
    const { seen, fetch } = recording(() =>
      Response.json({ authorized: false, authorizationUrl: 'http://127.0.0.1:9/authorize' }),
    );
    const answer = await authorizeToolSource('ledger', { fetch, mutation: MUTATION });
    expect(seen).toEqual([
      {
        path: `${HOST_TOOL_SOURCES_ROUTE}/ledger/authorize`,
        method: 'POST',
        body: JSON.stringify(MUTATION),
      },
    ]);
    expect(answer).toEqual({ authorized: false, authorizationUrl: 'http://127.0.0.1:9/authorize' });
  });

  test('reads that the stored tokens already work, and a refusal', async () => {
    const worked = recording(() => Response.json({ authorized: true }));
    expect(
      await authorizeToolSource('ledger', { fetch: worked.fetch, mutation: MUTATION }),
    ).toEqual({
      authorized: true,
    });
    const refused = recording(() =>
      Response.json(
        { error: 'invalid', field: 'source', message: 'Not an OAuth source.' },
        { status: 400 },
      ),
    );
    expect(
      await failureOf(authorizeToolSource('notes', { fetch: refused.fetch, mutation: MUTATION })),
    ).toMatchObject({
      kind: 'invalid',
    });
  });
});

describe('previewToolSourceRemoval and removeToolSource', () => {
  test('reads the agents a removal would break, and changes nothing', async () => {
    const { seen, fetch } = recording(() =>
      Response.json({
        id: 'notes',
        tools: ['notes__wipe'],
        affectedAgents: [{ id: 'writer', name: 'Writer', tools: ['notes__wipe'], approvals: [] }],
      }),
    );
    const preview = await previewToolSourceRemoval('notes', { fetch });
    expect(seen).toEqual([
      {
        path: `${HOST_TOOL_SOURCES_ROUTE}/notes/affected-agents`,
        method: undefined,
        body: undefined,
      },
    ]);
    expect(preview.affectedAgents.map((agent) => agent.id)).toEqual(['writer']);
  });

  test('deletes the source, and reports a refusal', async () => {
    const done = recording(() =>
      Response.json({ id: 'notes', changed: true, restartRequired: true, affectedAgents: [] }),
    );
    await removeToolSource('notes', { mutation: MUTATION, fetch: done.fetch });
    expect(done.seen).toEqual([
      {
        path: `${HOST_TOOL_SOURCES_ROUTE}/notes`,
        method: 'DELETE',
        body: JSON.stringify(MUTATION),
      },
    ]);
    const refused = recording(() =>
      Response.json(
        { error: 'locked', reason: 'deployment', message: 'Change it there.' },
        { status: 403 },
      ),
    );
    expect(
      await failureOf(removeToolSource('notes', { mutation: MUTATION, fetch: refused.fetch })),
    ).toMatchObject({
      kind: 'locked',
    });
  });
});

describe('probeToolSource and connectToolSource (COR-1991)', () => {
  const request = {
    source: { id: 'notes', kind: 'mcp', transport: { type: 'http', url: 'http://127.0.0.1:9/' } },
    credentials: { token: 'a-value' },
  };

  test('snapshots proxied source input before awaiting', async () => {
    const source = { ...request.source, id: 'notes' };
    const proxied = new Proxy(
      { source: new Proxy(source, {}), credentials: new Proxy({ token: 'original' }, {}) },
      {},
    );
    const connect = recording(() =>
      Response.json({ id: 'notes', changed: true, restartRequired: true }),
    );
    const pending = connectToolSource('notes', proxied, {
      mutation: MUTATION,
      fetch: connect.fetch,
    });
    source.id = 'changed';
    await pending;
    expect(JSON.parse(connect.seen[0]?.body ?? '{}')).toMatchObject({
      source: { id: 'notes' },
      credentials: { token: 'original' },
    });
  });

  test('send the description and the credentials in one body to the route of the source', async () => {
    const probe = recording(() => Response.json({ outcome: 'listed', tools: [], skipped: [] }));
    const connect = recording(() =>
      Response.json({ id: 'notes', changed: true, restartRequired: true }),
    );

    await probeToolSource('notes', request, { fetch: probe.fetch });
    await connectToolSource('notes', request, { mutation: MUTATION, fetch: connect.fetch });

    expect(probe.seen).toEqual([
      { path: '/host/tool-sources/notes/probe', method: 'POST', body: JSON.stringify(request) },
    ]);
    expect(connect.seen).toEqual([
      {
        path: '/host/tool-sources/notes',
        method: 'PUT',
        body: JSON.stringify({ ...MUTATION, ...request }),
      },
    ]);
  });

  test('ask a connect not to replace a source when the page says so, and read the host’s refusal', async () => {
    const created = recording(() =>
      Response.json({ error: 'exists', field: 'id', message: 'Already saved.' }, { status: 409 }),
    );

    const failure = await failureOf(
      connectToolSource(
        'notes',
        { ...request, create: true },
        { mutation: MUTATION, fetch: created.fetch },
      ),
    );

    expect(JSON.parse(created.seen[0]?.body ?? '{}')).toMatchObject({ create: true });
    expect(failure).toMatchObject({ kind: 'exists', message: 'Already saved.' });
    const plain = recording(() =>
      Response.json({ id: 'notes', changed: true, restartRequired: true }),
    );
    await connectToolSource('notes', request, { mutation: MUTATION, fetch: plain.fetch });
    expect(JSON.parse(plain.seen[0]?.body ?? '{}')).not.toHaveProperty('create');
  });

  test('read each outcome of a probe', async () => {
    const answer = async (body: unknown) =>
      probeToolSource('notes', request, { fetch: recording(() => Response.json(body)).fetch });

    expect(
      await answer({
        outcome: 'listed',
        tools: [{ name: 'notes__lookup', tool: 'lookup', tier: null }],
        skipped: [{ tool: 'a__b', reason: 'its name has two underscores' }],
      }),
    ).toMatchObject({ outcome: 'listed', tools: [{ tier: null }] });
    expect(await answer({ outcome: 'needs-authorization' })).toEqual({
      outcome: 'needs-authorization',
    });
    expect(
      await answer({ outcome: 'failed', message: 'The source did not answer in time.' }),
    ).toEqual({
      outcome: 'failed',
      message: 'The source did not answer in time.',
    });
    expect(await failureOf(answer({ outcome: 'maybe' }))).toBeInstanceOf(HostToolSourceError);
  });

  test('send the name, description and choice of tools a connect carries, and read what is available now (COR-2022)', async () => {
    const connect = recording(() =>
      Response.json({
        id: 'notes',
        changed: true,
        restartRequired: false,
        available: ['notes__lookup'],
      }),
    );
    const chosen = {
      ...request,
      create: true as const,
      name: 'Notes',
      description: 'Notes you keep.',
      tools: { wipe: { enabled: false }, lookup: { approval: 'always' as const } },
    };

    const change = await connectToolSource('notes', chosen, {
      mutation: MUTATION,
      fetch: connect.fetch,
    });

    expect(JSON.parse(connect.seen[0]?.body ?? '{}')).toEqual({
      ...MUTATION,
      ...chosen,
    });
    expect(change).toEqual({
      id: 'notes',
      changed: true,
      restartRequired: false,
      available: ['notes__lookup'],
    });
    // With no tools chosen the request still carries the empty choice: the source joins with none.
    const none = recording(() =>
      Response.json({ id: 'notes', changed: true, restartRequired: false, available: [] }),
    );
    await connectToolSource(
      'notes',
      { ...request, tools: {} },
      { mutation: MUTATION, fetch: none.fetch },
    );
    expect(JSON.parse(none.seen[0]?.body ?? '{}')).toMatchObject({ tools: {} });
  });

  test('read a probe’s titles, descriptions and the OpenAPI test call', async () => {
    const { fetch } = recording(() =>
      Response.json({
        outcome: 'listed',
        tools: [
          {
            name: 'notes__lookup',
            tool: 'lookup',
            tier: 'read-only',
            title: 'Look up',
            description: 'Finds a note.',
          },
        ],
        skipped: [],
        test: { tool: 'lookup', title: 'Look up', passed: true },
      }),
    );

    expect(await probeToolSource('notes', request, { fetch })).toEqual({
      outcome: 'listed',
      tools: [
        {
          name: 'notes__lookup',
          tool: 'lookup',
          tier: 'read-only',
          title: 'Look up',
          description: 'Finds a note.',
        },
      ],
      skipped: [],
      test: { tool: 'lookup', title: 'Look up', passed: true },
    });
  });

  test('turn a refusal into the host’s words and the field it names, and never repeat the body', async () => {
    const refused = recording(() =>
      Response.json(
        {
          error: 'invalid',
          field: 'credentials.token',
          message: 'Invalid credentials.token: a value is required.',
        },
        { status: 400 },
      ),
    );

    const failure = await failureOf(probeToolSource('notes', request, { fetch: refused.fetch }));

    expect(failure).toBeInstanceOf(HostToolSourceError);
    expect(failure).toMatchObject({ kind: 'invalid', field: 'credentials.token' });
    expect((failure as Error).message).not.toContain('a-value');
    const owner = recording(() =>
      Response.json({ error: 'owner-only', message: 'Only the owner may.' }, { status: 403 }),
    );
    expect(
      await failureOf(
        connectToolSource('notes', request, { mutation: MUTATION, fetch: owner.fetch }),
      ),
    ).toMatchObject({
      kind: 'owner-only',
    });
  });
});
