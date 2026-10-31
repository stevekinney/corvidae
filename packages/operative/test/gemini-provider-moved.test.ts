/**
 * The Gemini provider lives in `@lostgradient/operative-gemini`. Operative's root, its
 * provider-authoring and provider-testing entry points, and the barrels under `src/providers/` name
 * none of what moved, so a host that wants Gemini has to name the package. The moved types are
 * checked at compile time, in `gemini-provider-moved.test-d.ts`.
 */
import * as root from '@lostgradient/operative';
import * as providerKit from '@lostgradient/operative/provider-kit';
import * as providerTesting from '@lostgradient/operative/provider-testing';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

/** Every runtime export of `@lostgradient/operative-gemini` and its `./testing` entry point. */
const MOVED_GEMINI_EXPORTS = [
  'createGeminiBatchClient',
  'createGeminiEmbedder',
  'createGeminiPartMapper',
  'createGeminiProvider',
  'createGeminiProviderStream',
  'createGeminiTokenCounter',
  'createMockGeminiModel',
  'createMockGeminiStreamingModel',
  'droppedReplayDataMetadata',
  'geminiFunctionCallResponse',
  'geminiMixedResponse',
  'geminiNoUsageResponse',
  'geminiProvider',
  'geminiStreamEmptyChunks',
  'geminiStreamFunctionCallChunks',
  'geminiStreamMixedChunks',
  'geminiStreamMultiFunctionCallChunks',
  'geminiStreamTextChunks',
  'geminiTextResponse',
  'geminiViolationError',
  'resolveGeminiApiKey',
  'toGeminiResponseFormat',
  'toGeminiToolChoice',
] as const;

const entryPoints = { root, providerKit, providerTesting };

/** The barrels under `src/providers/`, which re-export provider files by path. */
const BARRELS = ['src/providers/index.ts', 'src/providers/structured-output/index.ts'] as const;

describe('the Gemini provider has left Operative', () => {
  for (const [entryPoint, exports] of Object.entries(entryPoints)) {
    it(`${entryPoint} exports none of the symbols that moved to @lostgradient/operative-gemini`, () => {
      const stillExported = MOVED_GEMINI_EXPORTS.filter((name) => Object.hasOwn(exports, name));
      expect(stillExported).toEqual([]);
    });
  }

  for (const barrel of BARRELS) {
    it(`${barrel} names none of the symbols that moved`, () => {
      const source = readFileSync(new URL(`../${barrel}`, import.meta.url), 'utf8');
      const stillNamed = MOVED_GEMINI_EXPORTS.filter((name) =>
        new RegExp(`\\b${name}\\b`).test(source),
      );
      expect(stillNamed).toEqual([]);
    });
  }
});
