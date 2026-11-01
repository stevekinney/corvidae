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
} from './host-providers.ts';

const KEY = 'sk-test-key-that-must-never-be-repeated';

const SNAPSHOT = {
  providers: [
    { name: 'anthropic', configured: true, hasKey: true, models: ['sonnet'] },
    { name: 'openai', configured: false, hasKey: false },
  ],
  catalog: [{ provider: 'anthropic', model: 'haiku', off: true }],
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
    expect(snapshot.catalog).toEqual([{ provider: 'anthropic', model: 'haiku', off: true }]);
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

describe('connectProvider', () => {
  test('puts the key to the provider’s route and nothing else', async () => {
    const { seen, fetch } = recording(() => Response.json({ providers: [], catalogRevision: 2 }));
    await connectProvider('openai', KEY, { fetch });
    expect(seen).toEqual([
      {
        path: `${HOST_PROVIDERS_ROUTE}/openai`,
        method: 'PUT',
        body: JSON.stringify({ apiKey: KEY }),
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
    const failure = await failureOf(connectProvider('openai', KEY, { fetch }));
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
      expect(await failureOf(connectProvider('openai', KEY, { fetch })), kind).toMatchObject({
        kind,
      });
    }
    const html = recording(() => new Response('<html>', { status: 502 }));
    expect(await failureOf(connectProvider('openai', KEY, { fetch: html.fetch }))).toMatchObject({
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
    const failure = await failureOf(connectProvider('openai', KEY, { fetch }));
    expect(failure).toBeInstanceOf(HostProviderError);
    expect((failure as HostProviderError).message).not.toContain(KEY);
    expect((failure as HostProviderError).toString()).not.toContain(KEY);
  });

  test('escapes a provider name in the path', async () => {
    const { seen, fetch } = recording(() => Response.json({}));
    await connectProvider('a/b', KEY, { fetch });
    expect(seen[0]?.path).toBe(`${HOST_PROVIDERS_ROUTE}/a%2Fb`);
  });
});

describe('replaceCatalogEdits and reloadProviders', () => {
  test('put the whole list of edits, and post the reload', async () => {
    const { seen, fetch } = recording(() => Response.json({}));
    const edits = [{ provider: 'anthropic', model: 'haiku', off: true }];
    await replaceCatalogEdits(edits, { fetch });
    await reloadProviders({ fetch });
    expect(seen).toEqual([
      { path: HOST_CATALOG_ROUTE, method: 'PUT', body: JSON.stringify({ edits }) },
      { path: HOST_PROVIDERS_RELOAD_ROUTE, method: 'POST', body: undefined },
    ]);
  });

  test('name the edits they started from when given them, and only then', async () => {
    const { seen, fetch } = recording(() => Response.json({}));
    const edits = [{ provider: 'anthropic', model: 'haiku', off: true }];
    const base = [{ provider: 'anthropic', model: 'sonnet', off: true }];
    await replaceCatalogEdits(edits, { fetch, base });
    await replaceCatalogEdits(edits, { fetch, base: [] });
    expect(seen.map((entry) => entry.body)).toEqual([
      JSON.stringify({ edits, base }),
      JSON.stringify({ edits, base: [] }),
    ]);
  });

  test('fail as a conflict when the host says the catalog changed', async () => {
    const { fetch } = recording(() =>
      Response.json({ error: 'conflict', message: 'Changed.', catalog: [] }, { status: 409 }),
    );
    expect(await failureOf(replaceCatalogEdits([], { fetch, base: [] }))).toMatchObject({
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
    expect(await failureOf(replaceCatalogEdits([], { fetch }))).toMatchObject({
      kind: 'invalid',
      field: 'catalog[0].model',
    });
    expect(await failureOf(reloadProviders({ fetch }))).toMatchObject({ kind: 'invalid' });
  });
});

describe('disconnectProvider', () => {
  test('deletes the provider’s route, with the name escaped and no body', async () => {
    const { seen, fetch } = recording(() => Response.json({}));
    await disconnectProvider('a/b', { fetch });
    expect(seen).toEqual([
      { path: `${HOST_PROVIDERS_ROUTE}/a%2Fb`, method: 'DELETE', body: undefined },
    ]);
  });

  test('fails with the host’s refusal', async () => {
    const { fetch } = recording(() =>
      Response.json({ error: 'locked', message: 'Remote.' }, { status: 403 }),
    );
    expect(await failureOf(disconnectProvider('anthropic', { fetch }))).toMatchObject({
      kind: 'locked',
    });
  });
});
