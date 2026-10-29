/**
 * Cross-provider batch inference (AB-156).
 *
 * Two kinds of test live here.
 *
 * The bulk are hermetic and inject a fake client typed as the structural
 * interface from `gemini-types.ts` — that typing is the point, because a
 * fake that compiles against the same interface a real SDK client satisfies is
 * what makes the interface useful rather than decorative. (`Anthropic`,
 * `OpenAI`, and `GoogleGenAI` satisfying it is proved separately, at compile
 * time, by `src/gemini-batch-client-assignability.test-d.ts`.)
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
import { ProviderError } from '@lostgradient/operative/provider-kit';
import { describe, expect, it } from 'bun:test';
import { createGeminiBatchClient } from '../src/batches/gemini.ts';
import type {
  GeminiBatchClient,
  GeminiBatchJob,
  GeminiDeleteResourceJob,
} from '../src/gemini-types.ts';

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

// ── Gemini ──────────────────────────────────────────────────────────

const GEMINI_JOB: GeminiBatchJob = {
  name: 'batches/abc123',
  displayName: 'nightly-scoring',
  state: 'JOB_STATE_SUCCEEDED',
  model: 'gemini-2.0-flash',
  createTime: '2026-08-30T00:00:00Z',
  endTime: '2026-08-30T01:00:00Z',
};

const GEMINI_DELETED: GeminiDeleteResourceJob = { name: 'batches/abc123', done: true };

function createFakeGeminiClient(failure?: unknown): {
  client: GeminiBatchClient;
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
        async create(params) {
          record('create', params);
          return GEMINI_JOB;
        },
        async get(params) {
          record('get', params);
          return GEMINI_JOB;
        },
        async list(params) {
          record('list', params);
          return (async function* () {
            yield GEMINI_JOB;
            yield { ...GEMINI_JOB, name: 'batches/def456' };
          })();
        },
        async cancel(params) {
          record('cancel', params);
        },
        async delete(params) {
          record('delete', params);
          return GEMINI_DELETED;
        },
      },
    },
  };
}

describe('createGeminiBatchClient — injected client', () => {
  it('creates a batch job from a source and model, keeping Gemini’s own request shape', async () => {
    const { client, calls } = createFakeGeminiClient();
    const batches = createGeminiBatchClient({ client });
    const request = {
      model: 'gemini-2.0-flash',
      src: { gcsUri: 'gs://bucket/input.jsonl', format: 'jsonl' },
    };

    expect(await batches.create(request)).toEqual(GEMINI_JOB);
    expect(calls).toEqual([{ method: 'create', argument: request }]);
  });

  it('gets one job by resource name rather than a bare id', async () => {
    const { client, calls } = createFakeGeminiClient();
    const batches = createGeminiBatchClient({ client });

    const job = await batches.get({ name: 'batches/abc123' });

    expect(job.state).toBe('JOB_STATE_SUCCEEDED');
    expect(calls).toEqual([{ method: 'get', argument: { name: 'batches/abc123' } }]);
  });

  it('flattens the pager into an async iterable of jobs', async () => {
    const { client, calls } = createFakeGeminiClient();
    const batches = createGeminiBatchClient({ client });

    const listed = await collect(batches.list({ config: { pageSize: 2 } }));

    expect(listed.map((job) => job.name)).toEqual(['batches/abc123', 'batches/def456']);
    expect(calls).toEqual([{ method: 'list', argument: { config: { pageSize: 2 } } }]);
  });

  it('cancels a job and resolves to nothing, as Gemini returns no body', async () => {
    const { client, calls } = createFakeGeminiClient();
    const batches = createGeminiBatchClient({ client });

    expect(await batches.cancel({ name: 'batches/abc123' })).toBeUndefined();
    expect(calls).toEqual([{ method: 'cancel', argument: { name: 'batches/abc123' } }]);
  });

  it('deletes a job — the one operation only Gemini offers', async () => {
    const { client, calls } = createFakeGeminiClient();
    const batches = createGeminiBatchClient({ client });

    expect(await batches.delete({ name: 'batches/abc123' })).toEqual(GEMINI_DELETED);
    expect(calls).toEqual([{ method: 'delete', argument: { name: 'batches/abc123' } }]);
  });

  it('wraps an SDK failure from every operation in a ProviderError', async () => {
    const { client } = createFakeGeminiClient(new Error('permission denied'));
    const batches = createGeminiBatchClient({ client });

    const failures = [
      batches.create({ src: 'files/input' }),
      batches.get({ name: 'batches/abc123' }),
      collect(batches.list()),
      batches.cancel({ name: 'batches/abc123' }),
      batches.delete({ name: 'batches/abc123' }),
    ];

    for (const failure of failures) {
      const error = await failure.then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).provider).toBe('gemini');
    }
  });
});

describe('createGeminiBatchClient — SDK construction', () => {
  it('constructs a real @google/genai client from apiKey and baseURL, lazily', async () => {
    const server = createRecordingServer({ name: 'batches/abc123' });
    try {
      const batches = createGeminiBatchClient({
        apiKey: PLACEHOLDER_TOKEN,
        baseURL: server.baseURL,
      });

      expect(server.requests).toEqual([]);

      await batches.get({ name: 'batches/abc123' });

      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.method).toBe('GET');
      expect(server.requests[0]?.path).toContain('batches/abc123');
    } finally {
      server.stop();
    }
  });

  it('fails with a ProviderError when no apiKey and no GOOGLE_API_KEY are available', async () => {
    const previousKey = process.env['GOOGLE_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];
    try {
      const batches = createGeminiBatchClient();
      const error = await batches.get({ name: 'batches/abc123' }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).message).toContain('Missing API key');
    } finally {
      if (previousKey !== undefined) process.env['GOOGLE_API_KEY'] = previousKey;
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
  it('rejects a @google/genai client that predates client.batches', () => {
    const { client } = createFakeGeminiClient();
    Reflect.deleteProperty(client, 'batches');

    expect(() => createGeminiBatchClient({ client })).toThrow(
      /require @google\/genai >= 1\.7\.0, but client\.batches is not available/,
    );
  });

  it('rejects a @google/genai client missing only `delete`', () => {
    const { client } = createFakeGeminiClient();
    Reflect.deleteProperty(client.batches, 'delete');

    expect(() => createGeminiBatchClient({ client })).toThrow(
      /client\.batches is missing delete\(\)/,
    );
  });

  it('accepts a complete Gemini fake, so the guard costs the valid path nothing', () => {
    expect(() =>
      createGeminiBatchClient({ client: createFakeGeminiClient().client }),
    ).not.toThrow();
  });
});
