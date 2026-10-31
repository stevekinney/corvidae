import { definePlugin } from '@lostgradient/interborough-plugin';
import { ProviderError } from '@lostgradient/operative';
import type { EmbeddingVector } from 'armorer';
import { z } from 'zod';

/**
 * Embeds with a local Ollama server. `memory.embedder` names the contribution `ollama:embed`. The
 * plugin declares no secret, so its embedder is available whenever the plugin runs.
 */
export default definePlugin({
  name: 'ollama',
  version: '1.0.0',
  description: 'Embeds memory with an Ollama server, by default one on this machine.',
  configuration: z.object({
    /** The Ollama embedding model. */
    model: z.string().min(1).default('nomic-embed-text'),
    /** How many numbers the model returns per text; `nomic-embed-text` returns 768. */
    dimensions: z.number().int().positive().default(768),
    /** The server's base URL. */
    baseURL: z.url().default('http://localhost:11434'),
  }),
  setup({ configuration }) {
    const { model, dimensions, baseURL } = configuration;
    const endpoint = `${baseURL.replace(/\/+$/, '')}/api/embed`;
    return {
      embedders: [
        {
          name: 'embed',
          dimensions,
          async embed(texts: string[]): Promise<EmbeddingVector[]> {
            try {
              const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, input: texts }),
              });
              if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw Object.assign(new Error(`Ollama API error: ${response.status} ${body}`), {
                  status: response.status,
                });
              }
              const json = (await response.json()) as { embeddings: number[][] };
              const wrong = json.embeddings.find((vector) => vector.length !== dimensions);
              if (json.embeddings.length !== texts.length || wrong !== undefined) {
                throw new Error(
                  `Ollama returned ${json.embeddings.length} vectors of ${wrong?.length ?? dimensions} numbers for ${texts.length} texts; the plugin is configured for ${dimensions} numbers (set "dimensions" to the model's).`,
                );
              }
              return json.embeddings;
            } catch (error) {
              if (error instanceof ProviderError) throw error;
              throw new ProviderError({ provider: 'ollama', cause: error });
            }
          },
        },
      ],
    };
  },
});
