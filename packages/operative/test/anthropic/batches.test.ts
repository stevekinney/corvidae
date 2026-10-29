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
 * time, by `src/providers/anthropic-batch-client-assignability.test-d.ts`.)
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

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import type {
  AnthropicBatchClient,
  AnthropicMessageBatch,
  AnthropicMessageBatchIndividualResponse,
} from '../../src/providers/anthropic-types.ts';
import { createAnthropicBatchClient } from '../../src/providers/batches/anthropic.ts';
import { ProviderError } from '../../src/providers/errors.ts';

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

// ── Anthropic ───────────────────────────────────────────────────────

const ANTHROPIC_BATCH: AnthropicMessageBatch = {
  id: 'msgbatch_01',
  processing_status: 'ended',
  request_counts: { canceled: 0, errored: 0, expired: 0, processing: 0, succeeded: 2 },
  results_url: 'https://api.anthropic.com/v1/messages/batches/msgbatch_01/results',
  created_at: '2026-08-30T00:00:00Z',
  ended_at: '2026-08-30T01:00:00Z',
  expires_at: '2026-08-31T00:00:00Z',
};

const ANTHROPIC_RESULTS: AnthropicMessageBatchIndividualResponse[] = [
  { custom_id: 'first', result: { type: 'succeeded', message: { id: 'msg_01' } } },
  { custom_id: 'second', result: { type: 'errored', error: { type: 'invalid_request_error' } } },
];

function createFakeAnthropicClient(failure?: unknown): {
  client: AnthropicBatchClient;
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
      messages: {
        batches: {
          async create(params) {
            record('create', params);
            return ANTHROPIC_BATCH;
          },
          async retrieve(messageBatchId) {
            record('retrieve', messageBatchId);
            return ANTHROPIC_BATCH;
          },
          list(query) {
            record('list', query);
            return (async function* () {
              yield ANTHROPIC_BATCH;
              yield { ...ANTHROPIC_BATCH, id: 'msgbatch_02' };
            })();
          },
          async cancel(messageBatchId) {
            record('cancel', messageBatchId);
            return { ...ANTHROPIC_BATCH, processing_status: 'canceling' };
          },
          async results(messageBatchId) {
            record('results', messageBatchId);
            return (async function* () {
              yield* ANTHROPIC_RESULTS;
            })();
          },
        },
      },
    },
  };
}

describe('createAnthropicBatchClient — injected client', () => {
  it('submits a batch and returns the created MessageBatch', async () => {
    const { client, calls } = createFakeAnthropicClient();
    const batches = createAnthropicBatchClient({ client });
    const request = {
      requests: [{ custom_id: 'first', params: { model: 'claude-opus-5', max_tokens: 16 } }],
    };

    expect(await batches.create(request)).toEqual(ANTHROPIC_BATCH);
    expect(calls).toEqual([{ method: 'create', argument: request }]);
  });

  it('retrieves one batch by id', async () => {
    const { client, calls } = createFakeAnthropicClient();
    const batches = createAnthropicBatchClient({ client });

    expect(await batches.retrieve('msgbatch_01')).toEqual(ANTHROPIC_BATCH);
    expect(calls).toEqual([{ method: 'retrieve', argument: 'msgbatch_01' }]);
  });

  it('iterates every listed batch and forwards the page query', async () => {
    const { client, calls } = createFakeAnthropicClient();
    const batches = createAnthropicBatchClient({ client });

    const listed = await collect(batches.list({ limit: 2 }));

    expect(listed.map((batch) => batch.id)).toEqual(['msgbatch_01', 'msgbatch_02']);
    expect(calls).toEqual([{ method: 'list', argument: { limit: 2 } }]);
  });

  it('cancels one batch by id', async () => {
    const { client, calls } = createFakeAnthropicClient();
    const batches = createAnthropicBatchClient({ client });

    const cancelled = await batches.cancel('msgbatch_01');

    expect(cancelled.processing_status).toBe('canceling');
    expect(calls).toEqual([{ method: 'cancel', argument: 'msgbatch_01' }]);
  });

  it('streams every result line, keeping the succeeded/errored discriminant', async () => {
    const { client, calls } = createFakeAnthropicClient();
    const batches = createAnthropicBatchClient({ client });

    const results = await collect(batches.results('msgbatch_01'));

    expect(results.map((entry) => entry.result.type)).toEqual(['succeeded', 'errored']);
    expect(calls).toEqual([{ method: 'results', argument: 'msgbatch_01' }]);
  });

  it('wraps an SDK failure from every operation in a ProviderError', async () => {
    const { client } = createFakeAnthropicClient(
      Object.assign(new Error('rate limited'), {
        status: 429,
      }),
    );
    const batches = createAnthropicBatchClient({ client });

    const failures = [
      batches.create({ requests: [] }),
      batches.retrieve('msgbatch_01'),
      collect(batches.list()),
      batches.cancel('msgbatch_01'),
      collect(batches.results('msgbatch_01')),
    ];

    for (const failure of failures) {
      const error = await failure.then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).provider).toBe('anthropic');
      expect((error as ProviderError).retryable).toBe(true);
    }
  });

  it('passes an existing ProviderError through rather than nesting it', async () => {
    const original = new ProviderError({ provider: 'anthropic', cause: new Error('boom') });
    const { client } = createFakeAnthropicClient(original);
    const batches = createAnthropicBatchClient({ client });

    expect(await rejectionOf(batches.retrieve('msgbatch_01'))).toBe(original);
  });
});

describe('createAnthropicBatchClient — SDK construction', () => {
  it('constructs a real @anthropic-ai/sdk client from apiKey and baseURL, lazily', async () => {
    const server = createRecordingServer(ANTHROPIC_BATCH);
    try {
      const batches = createAnthropicBatchClient({
        apiKey: PLACEHOLDER_TOKEN,
        baseURL: server.baseURL,
      });

      // Nothing has been imported or requested yet — construction is deferred
      // to the first call.
      expect(server.requests).toEqual([]);

      const batch = await batches.retrieve('msgbatch_01');

      expect(batch.id).toBe('msgbatch_01');
      expect(server.requests).toEqual([
        { method: 'GET', path: '/v1/messages/batches/msgbatch_01' },
      ]);

      // The constructed client is memoized, not rebuilt per call.
      await batches.retrieve('msgbatch_01');
      expect(server.requests).toHaveLength(2);
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
  it('rejects an @anthropic-ai/sdk client with no stable messages.batches', () => {
    const { client } = createFakeAnthropicClient();
    Reflect.deleteProperty(client.messages, 'batches');

    expect(() => createAnthropicBatchClient({ client })).toThrow(
      /require @anthropic-ai\/sdk >= 0\.33\.0, but client\.messages\.batches is not available/,
    );
  });

  it('rejects an @anthropic-ai/sdk client missing only `results`', () => {
    const { client } = createFakeAnthropicClient();
    Reflect.deleteProperty(client.messages.batches, 'results');

    expect(() => createAnthropicBatchClient({ client })).toThrow(
      /client\.messages\.batches is missing results\(\)/,
    );
  });

  it('accepts a complete Anthropic fake, so the guard costs the valid path nothing', () => {
    expect(() =>
      createAnthropicBatchClient({ client: createFakeAnthropicClient().client }),
    ).not.toThrow();
  });
});
