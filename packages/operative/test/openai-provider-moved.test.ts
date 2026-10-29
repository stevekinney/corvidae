/**
 * The OpenAI provider lives in `@lostgradient/operative-openai`. Operative's root, its
 * provider-authoring and provider-testing entry points, and the barrels under `src/providers/` name
 * none of what moved, so a host that wants OpenAI has to name the package. The moved types are
 * checked at compile time, in `openai-provider-moved.test-d.ts`.
 */
import * as root from '@lostgradient/operative';
import * as providerKit from '@lostgradient/operative/provider-kit';
import * as providerTesting from '@lostgradient/operative/provider-testing';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

/** Every runtime export of `@lostgradient/operative-openai` and its `./testing` entry point. */
const MOVED_OPENAI_EXPORTS = [
  'createMockOpenAIClient',
  'createMockOpenAIStreamingClient',
  'createOpenAIBatchClient',
  'createOpenAIEmbedder',
  'createOpenAIProvider',
  'createOpenAIProviderStream',
  'mapOpenAIMessage',
  'mergeAssembledField',
  'normalizeOpenAIStream',
  'openAIMixedResponse',
  'openAINoUsageResponse',
  'openAIStreamEmptyChunks',
  'openAIStreamMixedChunks',
  'openAIStreamMultiToolChunks',
  'openAIStreamTextChunks',
  'openAIStreamToolCallChunks',
  'openAITextResponse',
  'openAIToolCallResponse',
  'openaiProvider',
  'toOpenAIResponseFormat',
  'toOpenAIToolChoice',
] as const;

const entryPoints = { root, providerKit, providerTesting };

/** The barrels under `src/providers/`, which re-export provider files by path. */
const BARRELS = [
  'src/providers/index.ts',
  'src/providers/embeddings/index.ts',
  'src/providers/structured-output/index.ts',
] as const;

describe('the OpenAI provider has left Operative', () => {
  for (const [entryPoint, exports] of Object.entries(entryPoints)) {
    it(`${entryPoint} exports none of the symbols that moved to @lostgradient/operative-openai`, () => {
      const stillExported = MOVED_OPENAI_EXPORTS.filter((name) => Object.hasOwn(exports, name));
      expect(stillExported).toEqual([]);
    });
  }

  for (const barrel of BARRELS) {
    it(`${barrel} names none of the symbols that moved`, () => {
      const source = readFileSync(new URL(`../${barrel}`, import.meta.url), 'utf8');
      const stillNamed = MOVED_OPENAI_EXPORTS.filter((name) =>
        new RegExp(`\\b${name}\\b`).test(source),
      );
      expect(stillNamed).toEqual([]);
    });
  }
});
