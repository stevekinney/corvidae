/** The client for the host's provider routes: what it sends, what it reads, and what it never repeats. */
import { describe, expect, test } from 'bun:test';

import {
  connectProvider,
  disconnectProvider,
  getProviders,
  HOST_CATALOG_ROUTE,
  HOST_PROVIDERS_RELOAD_ROUTE,
  HOST_PROVIDERS_ROUTE,
  HostProviderError,
  reloadProviders,
  replaceCatalogEdits,
  testProviderKey,
  type CatalogEdit,
  type ProvidersSnapshot,
} from './host-providers.ts';

const KEY = 'sk-test-key-that-must-never-be-repeated';

const mutation = { operationId: 'test-operation', expectedRevision: 'test-revision' };

const SNAPSHOT: ProvidersSnapshot = {
  configurationRevision: 'test-revision',
  providers: [
    { name: 'anthropic', configured: true, hasKey: true, connected: true, models: ['sonnet'] },
    { name: 'openai', configured: false, hasKey: false, connected: false },
  ],
  catalog: [
    {
      provider: 'anthropic',
      model: 'haiku',
      off: true,
      decisions: { kinds: ['boolean', 'structured'], only: true },
    },
    {
      // Lowered media limits survive a read, so the page writes them back unchanged (COR-2413).
      provider: 'anthropic',
      model: 'sonnet',
      mediaLimits: [{ scope: 'per-part', modality: 'image', maxBytes: 1_048_576 }],
      mediaCounts: [{ modality: 'image', maxPerRequest: 4 }],
    },
  ],
  models: [
    {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      aliases: ['sonnet'],
      contextWindowTokens: 200_000,
      maxOutputTokens: 64_000,
      streaming: true,
      tools: true,
      structuredOutput: true,
      decisions: { kinds: ['boolean'], only: false },
      images: true,
      pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15, currency: 'USD' },
      off: false,
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

describe('getProviders', () => {
  test('asks the host and parses the providers, the models and the catalog edits', async () => {
    const { seen, fetch } = recording(() => Response.json(SNAPSHOT));
    const snapshot = await getProviders({ fetch });
    expect(seen.map((entry) => entry.path)).toEqual([HOST_PROVIDERS_ROUTE]);
    expect(snapshot.providers.map((provider) => provider.name)).toEqual(['anthropic', 'openai']);
    expect(snapshot.models[0]?.aliases).toEqual(['sonnet']);
    expect(snapshot.catalog).toEqual(SNAPSHOT.catalog);
    expect(snapshot.models[0]?.decisions).toEqual({ kinds: ['boolean'], only: false });
    expect(snapshot.lockReason).toBeUndefined();
  });

  test('reads the reason a remote host refuses writes', async () => {
    const { fetch } = recording(() => Response.json({ ...SNAPSHOT, lockReason: 'deployment' }));
    const snapshot = await getProviders({ fetch });
    expect(snapshot.lockReason).toBe('deployment');
  });

  test('fails for a refused request and for an answer it cannot read', async () => {
    const refused = recording(() => new Response('no', { status: 403 }));
    expect(await failureOf(getProviders({ fetch: refused.fetch }))).toBeInstanceOf(Error);
    const unreadable = recording(() => Response.json({ providers: 'none' }));
    expect(await failureOf(getProviders({ fetch: unreadable.fetch }))).toBeDefined();
  });
});

describe('a read the host answers with an error', () => {
  test('carries the status the page words ("didn’t come back (503)")', async () => {
    const failing = recording(() => new Response('unavailable', { status: 503 }));
    const error = await failureOf(getProviders({ fetch: failing.fetch }));
    expect(error).toBeInstanceOf(HostProviderError);
    expect((error as HostProviderError).status).toBe(503);
    expect((error as HostProviderError).kind).toBe('failed');
  });
});

describe('connectProvider', () => {
  test('puts the key to the provider’s route and nothing else', async () => {
    const { seen, fetch } = recording(() => Response.json({ providers: [], catalogRevision: 2 }));
    await connectProvider('openai', KEY, { fetch, mutation });
    expect(seen).toEqual([
      {
        path: `${HOST_PROVIDERS_ROUTE}/openai`,
        method: 'PUT',
        body: JSON.stringify({ apiKey: KEY, ...mutation }),
      },
    ]);
  });

  test('names the field the host refused, in the host’s words', async () => {
    const { fetch } = recording(() =>
      Response.json(
        { error: 'invalid', field: 'apiKey', message: 'Invalid apiKey: expected a key.' },
        { status: 400 },
      ),
    );
    const failure = await failureOf(connectProvider('openai', KEY, { fetch, mutation }));
    expect(failure).toBeInstanceOf(HostProviderError);
    expect(failure).toMatchObject({
      kind: 'invalid',
      field: 'apiKey',
      message: 'Invalid apiKey: expected a key.',
    });
  });

  test('reports a locked host, a partial change and any other failure by kind', async () => {
    const answers = [
      [{ error: 'locked', reason: 'deployment', message: 'Change it there.' }, 403, 'locked'],
      [{ error: 'partial', message: 'Stored but not in use.' }, 500, 'partial'],
      [{ error: 'failed', message: 'Could not be changed.' }, 500, 'failed'],
    ] as const;
    for (const [body, status, kind] of answers) {
      const { fetch } = recording(() => Response.json(body, { status }));
      expect(
        await failureOf(connectProvider('openai', KEY, { fetch, mutation })),
        kind,
      ).toMatchObject({
        kind,
      });
    }
    const html = recording(() => new Response('<html>', { status: 502 }));
    expect(
      await failureOf(connectProvider('openai', KEY, { fetch: html.fetch, mutation })),
    ).toMatchObject({
      kind: 'failed',
      message: '',
    });
  });

  test('drops a message that holds the key, whatever the host meant by it', async () => {
    const { fetch } = recording(() =>
      Response.json(
        { error: 'invalid', field: 'apiKey', message: `Invalid apiKey ${KEY}.` },
        { status: 400 },
      ),
    );
    const failure = await failureOf(connectProvider('openai', KEY, { fetch, mutation }));
    expect(failure).toBeInstanceOf(HostProviderError);
    expect((failure as HostProviderError).message).not.toContain(KEY);
    expect((failure as HostProviderError).toString()).not.toContain(KEY);
  });

  test('escapes a provider name in the path', async () => {
    const { seen, fetch } = recording(() => Response.json({}));
    await connectProvider('a/b', KEY, { fetch, mutation });
    expect(seen[0]?.path).toBe(`${HOST_PROVIDERS_ROUTE}/a%2Fb`);
  });
});

describe('replaceCatalogEdits and reloadProviders', () => {
  test('put the whole list of edits, and post the reload', async () => {
    const { seen, fetch } = recording(() => Response.json({}));
    const edits: CatalogEdit[] = [
      {
        provider: 'anthropic',
        model: 'haiku',
        off: true,
        decisions: { kinds: ['boolean', 'structured'], only: true },
      },
    ];
    await replaceCatalogEdits(edits, { fetch, mutation });
    await reloadProviders({ fetch });
    expect(seen).toEqual([
      { path: HOST_CATALOG_ROUTE, method: 'PUT', body: JSON.stringify({ edits, ...mutation }) },
      { path: HOST_PROVIDERS_RELOAD_ROUTE, method: 'POST', body: undefined },
    ]);
  });

  test('name the edits they started from when given them, and only then', async () => {
    const { seen, fetch } = recording(() => Response.json({}));
    const edits = [{ provider: 'anthropic', model: 'haiku', off: true }];
    const base = [{ provider: 'anthropic', model: 'sonnet', off: true }];
    await replaceCatalogEdits(edits, { fetch, mutation, base });
    await replaceCatalogEdits(edits, { fetch, mutation, base: [] });
    expect(seen.map((entry) => entry.body)).toEqual([
      JSON.stringify({ edits, base, ...mutation }),
      JSON.stringify({ edits, base: [], ...mutation }),
    ]);
  });

  test('fail as a conflict when the host says the catalog changed', async () => {
    const { fetch } = recording(() =>
      Response.json({ error: 'conflict', message: 'Changed.', catalog: [] }, { status: 409 }),
    );
    expect(await failureOf(replaceCatalogEdits([], { fetch, mutation, base: [] }))).toMatchObject({
      kind: 'conflict',
      message: 'Changed.',
    });
  });

  test('fail with the host’s refusal', async () => {
    const { fetch } = recording(() =>
      Response.json(
        { error: 'invalid', field: 'catalog[0].model', message: 'Bad.' },
        { status: 400 },
      ),
    );
    expect(await failureOf(replaceCatalogEdits([], { fetch, mutation }))).toMatchObject({
      kind: 'invalid',
      field: 'catalog[0].model',
    });
    expect(await failureOf(reloadProviders({ fetch }))).toMatchObject({ kind: 'invalid' });
  });
});

describe('disconnectProvider', () => {
  test('deletes the provider’s route, with the name escaped and no body', async () => {
    const { seen, fetch } = recording(() => Response.json({}));
    await disconnectProvider('a/b', { fetch, mutation });
    expect(seen).toEqual([
      { path: `${HOST_PROVIDERS_ROUTE}/a%2Fb`, method: 'DELETE', body: JSON.stringify(mutation) },
    ]);
  });

  test('fails with the host’s refusal', async () => {
    const { fetch } = recording(() =>
      Response.json({ error: 'locked', message: 'Remote.' }, { status: 403 }),
    );
    expect(await failureOf(disconnectProvider('anthropic', { fetch, mutation }))).toMatchObject({
      kind: 'locked',
    });
  });
});

describe('testProviderKey', () => {
  test('posts the key to the provider’s test route and reads the answer', async () => {
    const { seen, fetch } = recording(() => Response.json({ ok: true, models: 3 }));

    const result = await testProviderKey('anthropic', KEY, { fetch });

    expect(result).toEqual({ ok: true, models: 3 });
    expect(seen).toEqual([
      {
        path: `${HOST_PROVIDERS_ROUTE}/anthropic/test`,
        method: 'POST',
        body: JSON.stringify({ apiKey: KEY }),
      },
    ]);
  });

  test('reads a refused key as an answer with its status, not as a failure', async () => {
    const { fetch } = recording(() => Response.json({ ok: false, status: 401 }));

    expect(await testProviderKey('anthropic', KEY, { fetch })).toEqual({ ok: false, status: 401 });
  });

  test('reads a test that could not finish, with no status', async () => {
    const { fetch } = recording(() => Response.json({ ok: false }));

    expect(await testProviderKey('anthropic', KEY, { fetch })).toEqual({ ok: false });
  });

  test('fails with the host’s refusal of the request, never repeating the key', async () => {
    const { fetch } = recording(() =>
      Response.json(
        { error: 'invalid', field: 'apiKey', message: `Invalid apiKey ${KEY}.` },
        { status: 400 },
      ),
    );

    const failure = await failureOf(testProviderKey('anthropic', KEY, { fetch }));

    expect(failure).toBeInstanceOf(HostProviderError);
    expect(failure).toMatchObject({ kind: 'invalid', field: 'apiKey', message: '' });
  });

  test('fails for an answer it cannot read, and escapes the provider name', async () => {
    const { seen, fetch } = recording(() => Response.json({ unexpected: true }));

    const failure = await failureOf(testProviderKey('odd/name', KEY, { fetch }));

    expect(failure).toBeDefined();
    expect(seen[0]?.path).toBe(`${HOST_PROVIDERS_ROUTE}/odd%2Fname/test`);
  });

  test('stops when the signal does', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init?.signal?.aborted === true) throw new DOMException('Stopped', 'AbortError');
      return Response.json({ ok: true, models: 1 });
    };

    const failure = await failureOf(
      testProviderKey('anthropic', KEY, { fetch, signal: controller.signal }),
    );

    expect(failure).toBeInstanceOf(DOMException);
  });
});

test('a new provider mutation reads the committed revision and sends one explicit operation identity', async () => {
  const { seen, fetch } = recording((request) =>
    request.method === 'PUT' ? Response.json({}) : Response.json(SNAPSHOT),
  );
  await connectProvider('anthropic', KEY, { fetch });
  expect(seen).toHaveLength(2);
  expect(seen[0]?.path).toBe(HOST_PROVIDERS_ROUTE);
  const request = JSON.parse(seen[1]?.body ?? '{}') as Record<string, unknown>;
  expect(request['expectedRevision']).toBe(SNAPSHOT.configurationRevision);
  expect(request['operationId']).toBeString();
  expect(request['apiKey']).toBe(KEY);
});

test('catalog edits accept proxied state and snapshot it before awaiting', async () => {
  const edit = { provider: 'anthropic', model: 'sonnet', off: true };
  const edits = new Proxy([new Proxy(edit, {})], {});
  const base = new Proxy([{ provider: 'anthropic', model: 'haiku' }], {});
  const { seen, fetch } = recording(() => Response.json({}));
  const pending = replaceCatalogEdits(edits, { fetch, mutation, base });
  edit.off = false;
  await pending;
  expect(JSON.parse(seen[0]?.body ?? '{}')).toMatchObject({
    edits: [{ off: true }],
    base: [{ model: 'haiku' }],
  });
});
