/**
 * Tests for createGeminiEmbedder against `@google/genai`'s client shape.
 *
 * The maintained SDK embeds through `client.models.embedContent({ model,
 * contents })` and answers with a batch whose entries — and whose `values`
 * arrays — are both optional, so the embedder has to narrow before it can
 * hand back an EmbeddingVector.
 *
 * The lazy-construction test calls the embedder with an empty array on
 * purpose: that runs the real dynamic `import('@google/genai')` and the
 * `new GoogleGenAI(...)` construction (both local, no network) without ever
 * reaching `embedContent`, so the SDK-backed branch is covered hermetically.
 */
import { describe, expect, it } from 'bun:test';

import { ProviderError } from '@lostgradient/operative/provider-kit';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import type { GeminiEmbeddingClient } from '../src/embeddings/gemini.ts';
import { createGeminiEmbedder } from '../src/embeddings/gemini.ts';

type EmbedRequest = { model: string; contents: Array<{ parts: Array<{ text: string }> }> };
type EmbedResponse = { embeddings?: Array<{ values?: number[] }> };

interface FakeEmbeddingClient extends GeminiEmbeddingClient {
  calls: EmbedRequest[];
}

function createFakeEmbeddingClient(responses: EmbedResponse[]): FakeEmbeddingClient {
  const calls: EmbedRequest[] = [];
  let index = 0;

  return {
    calls,
    models: {
      async embedContent(params: EmbedRequest): Promise<EmbedResponse> {
        calls.push(params);
        return responses[index++] ?? {};
      },
    },
  };
}

describe('createGeminiEmbedder — client injection', () => {
  it('embeds each text in its own request and returns the vectors in order', async () => {
    const client = createFakeEmbeddingClient([
      { embeddings: [{ values: [1, 2] }] },
      { embeddings: [{ values: [3, 4] }] },
    ]);
    const embed = createGeminiEmbedder({ client });

    expect(await embed(['alpha', 'beta'])).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(client.calls).toEqual([
      { model: 'gemini-embedding-001', contents: [{ parts: [{ text: 'alpha' }] }] },
      { model: 'gemini-embedding-001', contents: [{ parts: [{ text: 'beta' }] }] },
    ]);
  });

  it('sends the model named in options', async () => {
    const client = createFakeEmbeddingClient([{ embeddings: [{ values: [0] }] }]);
    const embed = createGeminiEmbedder({ client, model: 'text-embedding-004' });

    await embed(['alpha']);

    expect(client.calls[0]?.model).toBe('text-embedding-004');
  });

  it('returns an empty result without calling the API when given no texts', async () => {
    const client = createFakeEmbeddingClient([]);
    const embed = createGeminiEmbedder({ client });

    expect(await embed([])).toEqual([]);
    expect(client.calls).toHaveLength(0);
  });

  it('throws a ProviderError when the response carries no embeddings at all', async () => {
    const client = createFakeEmbeddingClient([{}]);
    const embed = createGeminiEmbedder({ client });

    expect(await rejectionOf(embed(['alpha']))).toBeInstanceOf(ProviderError);
  });

  it('throws a ProviderError when the returned embedding has no values', async () => {
    const client = createFakeEmbeddingClient([{ embeddings: [{}] }]);
    const embed = createGeminiEmbedder({ client });

    const error = await Promise.resolve(embed(['alpha'])).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).provider).toBe('gemini');
    expect((error as ProviderError).message).toContain('gemini');
  });

  it('surfaces an API failure as a ProviderError', async () => {
    const embed = createGeminiEmbedder({
      client: {
        models: {
          embedContent: () => Promise.reject(new Error('embed failed')),
        },
      },
    });

    expect(await rejectionOf(embed(['alpha']))).toBeInstanceOf(ProviderError);
  });
});

describe('createGeminiEmbedder — the caller’s signal (COR-2185)', () => {
  it('hands the signal to every request as its abortSignal config', async () => {
    const client = createFakeEmbeddingClient([
      { embeddings: [{ values: [1, 2] }] },
      { embeddings: [{ values: [3, 4] }] },
    ]);
    const controller = new AbortController();

    await createGeminiEmbedder({ client })(['alpha', 'beta'], { signal: controller.signal });

    expect(client.calls.map((call) => (call as { config?: unknown }).config)).toEqual([
      { abortSignal: controller.signal },
      { abortSignal: controller.signal },
    ]);
  });

  it('sends no config when the caller gave no signal', async () => {
    const client = createFakeEmbeddingClient([{ embeddings: [{ values: [1] }] }]);

    await createGeminiEmbedder({ client })(['alpha']);

    expect(Object.hasOwn(client.calls[0]!, 'config')).toBe(false);
  });

  it('stops before the next text once the signal aborted', async () => {
    const controller = new AbortController();
    const client = createFakeEmbeddingClient([{ embeddings: [{ values: [1] }] }]);
    const calls = client.calls;
    const embedContent = client.models.embedContent.bind(client.models);
    client.models.embedContent = async (params) => {
      const result = await embedContent(params);
      controller.abort(new Error('the caller gave up'));
      return result;
    };

    const failure = await rejectionOf(
      createGeminiEmbedder({ client })(['alpha', 'beta'], { signal: controller.signal }),
    );

    expect(failure).toBeInstanceOf(ProviderError);
    expect(String((failure as ProviderError).cause)).toContain('the caller gave up');
    expect(calls).toHaveLength(1);
  });
});

describe('createGeminiEmbedder — SDK construction', () => {
  it('throws a ProviderError when neither a client nor an apiKey is given', async () => {
    const embed = createGeminiEmbedder();

    const error = await Promise.resolve(embed(['alpha'])).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).provider).toBe('gemini');
  });

  it('does not read GOOGLE_API_KEY from the environment', async () => {
    const saved = Bun.env['GOOGLE_API_KEY'];
    Bun.env['GOOGLE_API_KEY'] = 'set-but-ignored-by-this-embedder';
    try {
      expect(await rejectionOf(createGeminiEmbedder()(['alpha']))).toBeInstanceOf(ProviderError);
    } finally {
      if (saved === undefined) delete Bun.env['GOOGLE_API_KEY'];
      else Bun.env['GOOGLE_API_KEY'] = saved;
    }
  });

  it('constructs a real @google/genai client from an apiKey, lazily', async () => {
    // An empty text list exercises the dynamic import and client construction
    // and stops before any request would be issued.
    const embed = createGeminiEmbedder({ apiKey: 'placeholder-not-a-real-key-0000' });

    expect(await embed([])).toEqual([]);
    // The second call reuses the memoized client rather than re-importing.
    expect(await embed([])).toEqual([]);
  });
});
