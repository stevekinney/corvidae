import { definePlugin } from '@lostgradient/interborough-plugin';
import { ProviderError } from '@lostgradient/operative';
import type { EmbeddingVector } from 'armorer';
import { z } from 'zod';

/** The Bungalow key the plugin reads the Voyage API key from. */
const API_KEY_SECRET = 'voyage-api-key';

/**
 * Embeds with the Voyage AI Embeddings API. `memory.embedder` names the contribution
 * `voyage:embed`; the plugin is `needs-setup`, and the embedder unavailable, until the
 * `voyage-api-key` secret is saved.
 */
export default definePlugin({
  name: 'voyage',
  version: '1.0.0',
  description: 'Embeds memory with the Voyage AI Embeddings API. Needs a Voyage API key.',
  configuration: z.object({
    /** The Voyage embedding model. */
    model: z.string().min(1).default('voyage-3'),
    /** How many numbers the model returns per text; `voyage-3` returns 1024. */
    dimensions: z.number().int().positive().default(1024),
    /** The embeddings endpoint. */
    endpoint: z.url().default('https://api.voyageai.com/v1/embeddings'),
  }),
  secrets: [API_KEY_SECRET],
  setup({ configuration, secrets }) {
    const { model, dimensions, endpoint } = configuration;
    return {
      embedders: [
        {
          name: 'embed',
          dimensions,
          async embed(requested: string[]): Promise<EmbeddingVector[]> {
            // Snapshot: the caller owns the array, and it is read after the first await.
            const texts = [...requested];
            try {
              // Read per call, so a key saved after startup is used without a restart.
              const apiKey = await secrets.get(API_KEY_SECRET);
              if (apiKey === undefined) {
                throw new Error(`The secret "${API_KEY_SECRET}" is not set.`);
              }
              const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({ model, input: texts }),
              });
              if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw Object.assign(new Error(`Voyage API error: ${response.status} ${body}`), {
                  status: response.status,
                });
              }
              const json = (await response.json()) as { data: Array<{ embedding: number[] }> };
              const vectors = json.data.map((entry) => entry.embedding);
              const wrong = vectors.find((vector) => vector.length !== dimensions);
              if (vectors.length !== texts.length || wrong !== undefined) {
                throw new Error(
                  `Voyage returned ${vectors.length} vectors of ${wrong?.length ?? dimensions} numbers for ${texts.length} texts; the plugin is configured for ${dimensions} numbers (set "dimensions" to the model's).`,
                );
              }
              return vectors;
            } catch (error) {
              if (error instanceof ProviderError) throw error;
              throw new ProviderError({ provider: 'voyage', cause: error });
            }
          },
        },
      ],
    };
  },
});
