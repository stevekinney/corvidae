import { definePlugin } from '@lostgradient/interborough-plugin';
import { createOpenAIEmbedder, openaiProvider } from '@lostgradient/operative-openai';
import type { Embedder } from 'armorer';
import { z } from 'zod';

/** The Bungalow secret that holds the OpenAI API key. It is the key the host has always used. */
export const OPENAI_API_KEY_SECRET = 'openai-api-key';

/** The embedding model the plugin's embedder calls, and the length of the vectors it returns. */
export const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

/** The length of a `text-embedding-3-small` vector, as OpenAI documents the model's default. */
export const OPENAI_EMBEDDING_DIMENSIONS = 1536;

/**
 * The plugin's configuration, `plugins.openai.configuration` in Bungalow's `configuration.json`:
 * an optional allowlist of models, each a model name or an alias of one. The host reads it on every
 * catalog load, so a change to the allowlist applies without a restart.
 */
export const openaiConfiguration = z
  .object({ models: z.array(z.string().min(1)).min(1).optional() })
  .strict();

/**
 * The OpenAI plugin. It contributes the OpenAI provider with its catalog rows, and an embedder that
 * `memory.embedder` can name as `openai:text-embedding-3-small`; enabling the plugin never selects
 * it. It needs `openai-api-key`; without it the plugin is `needs-setup`.
 */
export default definePlugin({
  name: 'openai',
  version: '0.1.0',
  description: 'OpenAI models for agents, and an embedder for memory.',
  configuration: openaiConfiguration,
  secrets: [OPENAI_API_KEY_SECRET],
  setup: ({ secrets }) => {
    // The key is read when text is embedded, so a key saved after startup is used with no restart.
    let built: { readonly key: string; readonly embed: Embedder } | undefined;
    const embed: Embedder = async (texts) => {
      const apiKey = await secrets.get(OPENAI_API_KEY_SECRET);
      if (apiKey === undefined || apiKey === '') {
        throw new Error(`The secret "${OPENAI_API_KEY_SECRET}" is not set.`);
      }
      if (built?.key !== apiKey) {
        built = {
          key: apiKey,
          embed: createOpenAIEmbedder({ apiKey, model: OPENAI_EMBEDDING_MODEL }),
        };
      }
      return built.embed(texts);
    };
    return {
      providers: [openaiProvider],
      embedders: [{ name: OPENAI_EMBEDDING_MODEL, dimensions: OPENAI_EMBEDDING_DIMENSIONS, embed }],
    };
  },
});
