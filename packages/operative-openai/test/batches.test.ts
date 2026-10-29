/**
 * Cross-provider batch inference (AB-156).
 *
 * Two kinds of test live here.
 *
 * The bulk are hermetic and inject a fake client typed as the structural
 * interface from `providers/types.ts` — that typing is the point, because a
 * fake that compiles against the same interface a real SDK client satisfies is
 * what makes the interface useful rather than decorative. (`Anthropic`,
 * `OpenAI`, and `GoogleGenAI` satisfying it is proved separately, at compile
 * time, by `src/openai-batch-client-assignability.test-d.ts`.)
 *
 * The rest exercise the "no client injected" branch: the real SDK, dynamically
 * imported and constructed, issuing a real request against a local `Bun.serve`.
 * That follows `proxy-contract.test.ts` rather than `mock.module()`,
 * which mutates the process-global module registry and races other files in
 * this suite. `createOpenAIBatchClient` deliberately exposes no `baseURL`
 * option, so its local server is reached through the `openai` SDK's own
 * documented `OPENAI_BASE_URL` default instead, set and restored by
 * `withOpenAIBaseUrl`.
 *
 * That variable is why the capability suite at the bottom pins it too:
 * `getProviderCapabilities('openai')` reports on the *effective* endpoint, so
 * an `OPENAI_BASE_URL` inherited from the shell would otherwise decide the
 * answer those assertions are making.
 */
import { describe, expect, it } from 'bun:test';

import { getProviderCapabilities } from '@lostgradient/operative';
import { ProviderError } from '@lostgradient/operative/provider-kit';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createOpenAIBatchClient } from '../src/batches/openai.ts';
import type { OpenAIBatch, OpenAIBatchClient } from '../src/openai-types.ts';

const PLACEHOLDER_TOKEN = 'placeholder-not-a-real-key-0000';

/** One call a fake client recorded: the method name and its argument. */
interface RecordedCall {
  method: string;
  argument: unknown;
}

/** One request a local stand-in server received. */
interface RecordedRequest {
  method: string;
  path: string;
}

interface RecordingServer {
  baseURL: string;
  requests: RecordedRequest[];
  stop: () => void;
}

/**
 * Starts a local `Bun.serve` that records every request and answers each one
 * with `responseBody`. Bound to the literal loopback IP rather than
 * "localhost" for the reason documented in `proxy-contract.test.ts`:
 * some sandboxed CI network namespaces resolve the hostname to an address the
 * server is not listening on and silently drop the connection.
 */
function createRecordingServer(responseBody: unknown): RecordingServer {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      requests.push({ method: request.method, path: new URL(request.url).pathname });
      return new Response(JSON.stringify(responseBody), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  return {
    baseURL: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => {
      server.stop();
    },
  };
}

/** Collects an async iterable into an array. */
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

/**
 * Runs `body` with `OPENAI_BASE_URL` set to `value` — or unset, for
 * `undefined` — and restores whatever the process had before.
 *
 * That variable is ambient input to two things this file exercises: the
 * `openai` SDK's own base-URL default, which is how the SDK-construction test
 * below reaches its local server, and `getProviderCapabilities('openai')`,
 * which reads the same variable so its answer describes the endpoint a request
 * would actually reach. Neither assertion can inherit whatever shell ran the
 * suite, so both pin it here.
 */
async function withOpenAIBaseUrl<T>(
  value: string | undefined,
  body: () => T | Promise<T>,
): Promise<T> {
  const previous = process.env['OPENAI_BASE_URL'];
  if (value === undefined) delete process.env['OPENAI_BASE_URL'];
  else process.env['OPENAI_BASE_URL'] = value;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env['OPENAI_BASE_URL'];
    else process.env['OPENAI_BASE_URL'] = previous;
  }
}

// ── OpenAI ──────────────────────────────────────────────────────────

const OPENAI_BATCH: OpenAIBatch = {
  id: 'batch_01',
  object: 'batch',
  endpoint: '/v1/chat/completions',
  input_file_id: 'file_01',
  completion_window: '24h',
  created_at: 1_756_512_000,
  status: 'completed',
  output_file_id: 'file_02',
  request_counts: { completed: 2, failed: 0, total: 2 },
};

function createFakeOpenAIClient(failure?: unknown): {
  client: OpenAIBatchClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  function record(method: string, argument: unknown): void {
    calls.push({ method, argument });
    if (failure !== undefined) throw failure;
  }

  return {
    calls,
    client: {
      batches: {
        async create(body) {
          record('create', body);
          return OPENAI_BATCH;
        },
        async retrieve(batchId) {
          record('retrieve', batchId);
          return OPENAI_BATCH;
        },
        list(query) {
          record('list', query);
          return (async function* () {
            yield OPENAI_BATCH;
            yield { ...OPENAI_BATCH, id: 'batch_02' };
          })();
        },
        async cancel(batchId) {
          record('cancel', batchId);
          return { ...OPENAI_BATCH, status: 'cancelling' };
        },
      },
    },
  };
}

describe('createOpenAIBatchClient — injected client', () => {
  it('creates a batch from an uploaded input file', async () => {
    const { client, calls } = createFakeOpenAIClient();
    const batches = createOpenAIBatchClient({ client });
    const request = {
      completion_window: '24h',
      endpoint: '/v1/chat/completions',
      input_file_id: 'file_01',
    } as const;

    expect(await batches.create(request)).toEqual(OPENAI_BATCH);
    expect(calls).toEqual([{ method: 'create', argument: request }]);
  });

  it('retrieves one batch by id', async () => {
    const { client, calls } = createFakeOpenAIClient();
    const batches = createOpenAIBatchClient({ client });

    const batch = await batches.retrieve('batch_01');

    expect(batch.output_file_id).toBe('file_02');
    expect(calls).toEqual([{ method: 'retrieve', argument: 'batch_01' }]);
  });

  it('iterates every listed batch and forwards the cursor query', async () => {
    const { client, calls } = createFakeOpenAIClient();
    const batches = createOpenAIBatchClient({ client });

    const listed = await collect(batches.list({ after: 'batch_00', limit: 2 }));

    expect(listed.map((batch) => batch.id)).toEqual(['batch_01', 'batch_02']);
    expect(calls).toEqual([{ method: 'list', argument: { after: 'batch_00', limit: 2 } }]);
  });

  it('cancels one batch by id', async () => {
    const { client, calls } = createFakeOpenAIClient();
    const batches = createOpenAIBatchClient({ client });

    const cancelled = await batches.cancel('batch_01');

    expect(cancelled.status).toBe('cancelling');
    expect(calls).toEqual([{ method: 'cancel', argument: 'batch_01' }]);
  });

  it('wraps an SDK failure from every operation in a ProviderError', async () => {
    const { client } = createFakeOpenAIClient(new Error('bad request'));
    const batches = createOpenAIBatchClient({ client });

    const failures = [
      batches.create({ completion_window: '24h', endpoint: '/v1/responses', input_file_id: 'f' }),
      batches.retrieve('batch_01'),
      collect(batches.list()),
      batches.cancel('batch_01'),
    ];

    for (const failure of failures) {
      const error = await failure.then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).provider).toBe('openai');
    }
  });

  it('passes an existing ProviderError through rather than nesting it', async () => {
    const original = new ProviderError({ provider: 'openai', cause: new Error('boom') });
    const { client } = createFakeOpenAIClient(original);
    const batches = createOpenAIBatchClient({ client });

    expect(await rejectionOf(batches.retrieve('batch_01'))).toBe(original);
  });
});

describe('createOpenAIBatchClient — SDK construction', () => {
  it('constructs a real openai client from an apiKey, lazily', async () => {
    const server = createRecordingServer(OPENAI_BATCH);
    // The factory exposes no `baseURL` on purpose (a custom OpenAI base URL is
    // the local-server case that has no batches endpoint), so the local stand-in
    // is reached through the SDK's own documented `OPENAI_BASE_URL` default.
    try {
      await withOpenAIBaseUrl(`${server.baseURL}/v1`, async () => {
        const batches = createOpenAIBatchClient({ apiKey: PLACEHOLDER_TOKEN });

        expect(server.requests).toEqual([]);

        const batch = await batches.retrieve('batch_01');

        expect(batch.id).toBe('batch_01');
        expect(server.requests).toEqual([{ method: 'GET', path: '/v1/batches/batch_01' }]);

        // The same override that routes this request is what makes an
        // options-only capability report wrong: in this configuration a batch
        // request reaches a server with no `/v1/batches` at all.
        expect(getProviderCapabilities('openai').batchInference).toBe(false);
      });
    } finally {
      server.stop();
    }
  });
});

// ── Peer-SDK batch-surface guard ─────────────────────────────────────

/**
 * Each factory rejects a client whose SDK predates the batch resource, instead
 * of accepting it and then failing with `TypeError: Cannot read properties of
 * undefined (reading 'create')` on every operation.
 *
 * This matters most for `openai`, whose declared peer range (`>=4.0.0`)
 * genuinely admits such an install: `client.batches` first shipped in 4.34.0,
 * and `list` — which `OpenAIBatchOperations` advertises — only in 4.38.0. Both
 * numbers were established by downloading the releases from the npm registry
 * and reading their published declarations. The range stays wide on purpose, so
 * chat-only consumers are not held to a batch-API floor; the guard closes the
 * gap instead. Anthropic's floor (`>=0.50.0` against 0.33.0) and Gemini's
 * (`>=2.19.0` against 1.7.0) already exclude it, and are guarded anyway for
 * symmetry — a peer range is a declaration, not an enforcement.
 *
 * The old shapes are modelled by deleting a property off an otherwise-valid
 * fake, which keeps every client here typed as the real structural interface
 * instead of cast into position.
 */
describe('batch factories — peer-SDK surface guard', () => {
  it('rejects an openai client whose SDK predates the batches resource', () => {
    const { client } = createFakeOpenAIClient();
    Reflect.deleteProperty(client, 'batches');

    expect(() => createOpenAIBatchClient({ client })).toThrow(ProviderError);
    expect(() => createOpenAIBatchClient({ client })).toThrow(
      /batch operations require openai >= 4\.38\.0, but client\.batches is not available/,
    );
  });

  it('rejects an openai client from 4.34.0–4.37.x, which has `batches` but no `list`', () => {
    const { client } = createFakeOpenAIClient();
    Reflect.deleteProperty(client.batches, 'list');

    expect(() => createOpenAIBatchClient({ client })).toThrow(
      /require openai >= 4\.38\.0, but client\.batches is missing list\(\)/,
    );
  });

  it('names every missing method rather than only the first', () => {
    const { client } = createFakeOpenAIClient();
    Reflect.deleteProperty(client.batches, 'list');
    Reflect.deleteProperty(client.batches, 'cancel');

    expect(() => createOpenAIBatchClient({ client })).toThrow(
      /client\.batches is missing list\(\), cancel\(\)/,
    );
  });

  it('classifies the guard failure as a non-retryable provider error', () => {
    const { client } = createFakeOpenAIClient();
    Reflect.deleteProperty(client, 'batches');

    let thrown: unknown;
    try {
      createOpenAIBatchClient({ client });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).provider).toBe('openai');
    expect((thrown as ProviderError).retryable).toBe(false);
    expect((thrown as ProviderError).statusCode).toBeUndefined();
  });

  it('accepts a complete OpenAI fake, so the guard costs the valid path nothing', () => {
    expect(() =>
      createOpenAIBatchClient({ client: createFakeOpenAIClient().client }),
    ).not.toThrow();
  });
});
