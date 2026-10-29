import type { Embedder, EmbeddingVector } from 'armorer';

import { ProviderError } from '@lostgradient/operative/provider-kit';

/**
 * Structural interface for the OpenAI SDK surface used by the embedder.
 */
export interface OpenAIEmbeddingClient {
  /** The Embeddings resource; `embeddings.create` returns one vector per input. */
  embeddings: {
    create(params: Record<string, unknown>): Promise<{
      data: Array<{ embedding: number[] }>;
    }>;
  };
}

/**
 * Options for createOpenAIEmbedder.
 */
export interface OpenAIEmbedderOptions {
  /** An injected client; when absent the embedder loads the OpenAI SDK on first call and builds one. */
  client?: OpenAIEmbeddingClient | undefined;
  /** The API key handed to the SDK; the SDK falls back to `OPENAI_API_KEY` when absent. */
  apiKey?: string | undefined;
  /** The embedding model; defaults to `text-embedding-3-small`. */
  model?: string | undefined;
}

/**
 * Creates an Embedder backed by the OpenAI Embeddings API.
 *
 * When no `client` is provided, dynamically imports `openai`
 * and constructs one using `apiKey` or the `OPENAI_API_KEY` env var.
 */
export function createOpenAIEmbedder(options: OpenAIEmbedderOptions = {}): Embedder {
  const { model = 'text-embedding-3-small' } = options;
  let clientPromise: Promise<OpenAIEmbeddingClient> | undefined;

  function getClient(): Promise<OpenAIEmbeddingClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      clientPromise = import('openai').then((module) => {
        const OpenAI = module.default ?? module.OpenAI;
        return new OpenAI({ apiKey: options.apiKey }) as unknown as OpenAIEmbeddingClient;
      });
    }
    return clientPromise;
  }

  return async (texts: string[]): Promise<EmbeddingVector[]> => {
    const client = await getClient();

    try {
      const response = await client.embeddings.create({
        model,
        input: texts,
      });

      return response.data.map((entry) => entry.embedding);
    } catch (error) {
      throw new ProviderError({ provider: 'openai', cause: error });
    }
  };
}
