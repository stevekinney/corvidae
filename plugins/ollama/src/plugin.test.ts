import { createPluginTestHost } from '@lostgradient/bureau/testing';
import { pluginContract } from '@lostgradient/interborough-plugin/testing';
import { afterEach, describe, expect, it } from 'bun:test';

import ollama from './plugin.ts';

pluginContract(ollama, { createHost: createPluginTestHost });

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

interface RecordedRequest {
  readonly path: string;
  readonly body: { model: string; input: string[] };
}

/** An Ollama server on a loopback port that answers `/api/embed` with 3-number vectors. */
function startFakeOllama(status = 200): { baseURL: string; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as RecordedRequest['body'];
      requests.push({ path: new URL(request.url).pathname, body });
      if (status !== 200) return new Response('model not found', { status });
      return Response.json({ embeddings: body.input.map(() => [0.25, 0.5, 0.75]) });
    },
  });
  servers.push(server);
  return { baseURL: `http://127.0.0.1:${server.port}/`, requests };
}

/** The `ollama:embed` contribution, set up with `configuration` and no secrets. */
async function embedder(configuration: unknown) {
  const parsed = ollama.configuration!.parse(configuration);
  const result = await ollama.setup!({
    configuration: parsed,
    secrets: { get: async () => undefined },
  } as never);
  const [contributed] = result.embedders ?? [];
  if (contributed === undefined) throw new Error('The Ollama plugin contributed no embedder.');
  return contributed;
}

describe('ollama plugin', () => {
  it('contributes one embedder named embed, so memory.embedder names it ollama:embed, and needs no secret', async () => {
    expect(ollama.name).toBe('ollama');
    expect(ollama.secrets ?? []).toEqual([]);
    const contributed = await embedder({});
    expect(contributed.name).toBe('embed');
    expect(contributed.dimensions).toBe(768);
  });

  it('posts the texts to the configured server and returns one vector per text', async () => {
    const fake = startFakeOllama();
    const contributed = await embedder({ baseURL: fake.baseURL, dimensions: 3 });

    const vectors = await contributed.embed(['alpha', 'beta']);

    expect(vectors).toEqual([
      [0.25, 0.5, 0.75],
      [0.25, 0.5, 0.75],
    ]);
    expect(fake.requests).toEqual([
      { path: '/api/embed', body: { model: 'nomic-embed-text', input: ['alpha', 'beta'] } },
    ]);
  });

  it('hands the caller’s signal to the request, so aborting it ends a request that never answers (COR-2185)', async () => {
    let started!: (signal: AbortSignal | null | undefined) => void;
    const requestSignal = new Promise<AbortSignal | null | undefined>((resolve) => {
      started = resolve;
    });
    const realFetch = globalThis.fetch;
    // A server that never answers: the request ends only when its own signal aborts.
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      started(init?.signal);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;
    try {
      const contributed = await embedder({ dimensions: 3 });
      const controller = new AbortController();
      const settled = Promise.resolve(
        contributed.embed(['alpha'], { signal: controller.signal }),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      const signal = await requestSignal;
      expect(signal?.aborted).toBe(false);

      controller.abort(new Error('the caller gave up'));
      // The request's signal follows the caller's at once.
      expect(signal?.aborted).toBe(true);

      const failure = await settled;
      expect(String((failure as { cause?: unknown }).cause)).toContain('the caller gave up');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('sends no signal when the caller gave none (COR-2185)', async () => {
    const seen: { init?: RequestInit | undefined } = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen.init = init;
      return Response.json({ embeddings: [[0.25, 0.5, 0.75]] });
    }) as typeof fetch;
    try {
      const contributed = await embedder({ dimensions: 3 });
      await contributed.embed(['alpha']);
      expect(seen.init).toBeDefined();
      expect(Object.hasOwn(seen.init!, 'signal')).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('names the status the server answered when it refuses', async () => {
    const fake = startFakeOllama(404);
    const contributed = await embedder({ baseURL: fake.baseURL, dimensions: 3, model: 'absent' });

    const failure = await Promise.resolve(contributed.embed(['alpha'])).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(String((failure as { cause?: unknown }).cause)).toContain('404');
  });

  it('refuses vectors that do not hold the declared dimension', async () => {
    const fake = startFakeOllama();
    const contributed = await embedder({ baseURL: fake.baseURL, dimensions: 5 });

    const failure = await Promise.resolve(contributed.embed(['alpha'])).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(String((failure as { cause?: unknown }).cause)).toContain('3 numbers');
  });
});
