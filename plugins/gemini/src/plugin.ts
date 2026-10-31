import { definePlugin } from '@lostgradient/interborough-plugin';
import { createGeminiEmbedder, geminiProvider } from '@lostgradient/operative-gemini';
import type { Embedder } from 'armorer';
import { z } from 'zod';

/** The Bungalow secret that holds the Gemini API key. It is the key the host has always used. */
export const GEMINI_API_KEY_SECRET = 'gemini-api-key';

/** The embedding model the plugin's embedder calls, and the length of the vectors it returns. */
export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';

/** The length of a `gemini-embedding-001` vector, as Gemini documents the model's default. */
export const GEMINI_EMBEDDING_DIMENSIONS = 3072;

/**
 * The plugin's configuration, `plugins.gemini.configuration` in Bungalow's `configuration.json`:
 * an optional allowlist of models, each a model name or an alias of one. The host reads it on every
 * catalog load, so a change to the allowlist applies without a restart.
 */
export const geminiConfiguration = z
  .object({ models: z.array(z.string().min(1)).min(1).optional() })
  .strict();

/**
 * The Gemini plugin. It contributes the Gemini provider with its catalog rows, and an embedder that
 * `memory.embedder` can name as `gemini:gemini-embedding-001`; enabling the plugin never selects
 * it. It needs `gemini-api-key`; without it the plugin is `needs-setup`.
 */
export default definePlugin({
  name: 'gemini',
  version: '0.1.0',
  description: 'Gemini models for agents, and an embedder for memory.',
  configuration: geminiConfiguration,
  secrets: [GEMINI_API_KEY_SECRET],
  setup: ({ secrets }) => {
    // The key is read when text is embedded, so a key saved after startup is used with no restart.
    let built: { readonly key: string; readonly embed: Embedder } | undefined;
    const embed: Embedder = async (texts) => {
      const apiKey = await secrets.get(GEMINI_API_KEY_SECRET);
      if (apiKey === undefined || apiKey === '') {
        throw new Error(`The secret "${GEMINI_API_KEY_SECRET}" is not set.`);
      }
      if (built?.key !== apiKey) {
        built = {
          key: apiKey,
          embed: createGeminiEmbedder({ apiKey, model: GEMINI_EMBEDDING_MODEL }),
        };
      }
      return built.embed(texts);
    };
    return {
      providers: [geminiProvider],
      embedders: [{ name: GEMINI_EMBEDDING_MODEL, dimensions: GEMINI_EMBEDDING_DIMENSIONS, embed }],
    };
  },
});
