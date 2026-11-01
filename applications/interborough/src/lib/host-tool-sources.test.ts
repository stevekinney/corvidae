/** The client for the host's tool-source routes: what it sends, what it reads, and what it never repeats. */
import { describe, expect, test } from 'bun:test';

import {
  authorizeToolSource,
  getToolSources,
  HOST_TOOL_SOURCES_ROUTE,
  HostToolSourceError,
  previewToolSourceRemoval,
  removeToolSource,
  setAcceptsSecrets,
} from './host-tool-sources.ts';

const SNAPSHOT = {
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
    await setAcceptsSecrets('notes', { wipe: true, lookup: false }, { fetch });
    expect(seen).toEqual([
      {
        path: `${HOST_TOOL_SOURCES_ROUTE}/notes/tools`,
        method: 'PUT',
        body: JSON.stringify({
          tools: { wipe: { acceptsSecrets: true }, lookup: { acceptsSecrets: false } },
        }),
      },
    ]);
  });

  test('encodes an identifier that holds a character an address cannot', async () => {
    const { seen, fetch } = recording(() =>
      Response.json({ id: 'a b', changed: false, restartRequired: true }),
    );
    await setAcceptsSecrets('a b', {}, { fetch });
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
    expect(await failureOf(setAcceptsSecrets('notes', { wipe: true }, { fetch }))).toMatchObject({
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
      const failure = await failureOf(setAcceptsSecrets('notes', { wipe: true }, { fetch }));
      expect(failure).toBeInstanceOf(HostToolSourceError);
      expect(failure).toMatchObject({ kind, message: body.message });
    }
  });

  test('treats an answer that is not JSON as a failure with no message', async () => {
    const { fetch } = recording(() => new Response('<html>', { status: 502 }));
    expect(await failureOf(setAcceptsSecrets('notes', { wipe: true }, { fetch }))).toMatchObject({
      kind: 'failed',
      message: '',
    });
  });

  test('fails when a success answer is not the shape the host documents', async () => {
    const { fetch } = recording(() => Response.json({ id: 'notes' }));
    expect(await failureOf(setAcceptsSecrets('notes', { wipe: true }, { fetch }))).toMatchObject({
      kind: 'failed',
    });
  });
});

describe('authorizeToolSource', () => {
  test('posts to the source’s authorize route and reads the address to open', async () => {
    const { seen, fetch } = recording(() =>
      Response.json({ authorized: false, authorizationUrl: 'http://127.0.0.1:9/authorize' }),
    );
    const answer = await authorizeToolSource('ledger', { fetch });
    expect(seen).toEqual([
      { path: `${HOST_TOOL_SOURCES_ROUTE}/ledger/authorize`, method: 'POST', body: undefined },
    ]);
    expect(answer).toEqual({ authorized: false, authorizationUrl: 'http://127.0.0.1:9/authorize' });
  });

  test('reads that the stored tokens already work, and a refusal', async () => {
    const worked = recording(() => Response.json({ authorized: true }));
    expect(await authorizeToolSource('ledger', { fetch: worked.fetch })).toEqual({
      authorized: true,
    });
    const refused = recording(() =>
      Response.json(
        { error: 'invalid', field: 'source', message: 'Not an OAuth source.' },
        { status: 400 },
      ),
    );
    expect(await failureOf(authorizeToolSource('notes', { fetch: refused.fetch }))).toMatchObject({
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
        affectedAgents: [
          { id: 'writer', name: 'Writer', tools: ['notes__wipe'], toolApproval: [] },
        ],
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
    await removeToolSource('notes', { fetch: done.fetch });
    expect(done.seen).toEqual([
      { path: `${HOST_TOOL_SOURCES_ROUTE}/notes`, method: 'DELETE', body: undefined },
    ]);
    const refused = recording(() =>
      Response.json(
        { error: 'locked', reason: 'deployment', message: 'Change it there.' },
        { status: 403 },
      ),
    );
    expect(await failureOf(removeToolSource('notes', { fetch: refused.fetch }))).toMatchObject({
      kind: 'locked',
    });
  });
});
