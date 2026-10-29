/**
 * Type-level regression test for the provider definitions.
 *
 * Each built-in definition has to sit in a list of `ProviderDefinition<string>` (and in its own
 * literal-named `ProviderDefinition`) with no cast, and the real vendor client has to be assignable
 * to the `client` its configuration accepts, because that one field serves both `generate` and
 * `stream`.
 *
 * Why the `.test-d.ts` suffix: `tsconfig.json` includes `src`, so the type-check covers this file,
 * while `tsconfig.source.json` excludes the suffix, so the vendor SDK types it names never reach the
 * published declarations. It declares only types, so it is erased entirely.
 */
import type { Anthropic } from '@anthropic-ai/sdk';
import type { GoogleGenAI } from '@google/genai';
import type { OpenAI } from 'openai';

import type { anthropicProvider, AnthropicProviderConfiguration } from './anthropic-definition.ts';
import type { geminiProvider, GeminiProviderConfiguration } from './gemini-definition.ts';
import type { openaiProvider, OpenAIProviderConfiguration } from './openai-definition.ts';
import type { ProviderDefinition } from './provider-definition.ts';

type Assert<T extends true> = T;

export type AnthropicIsAProviderDefinition = Assert<
  typeof anthropicProvider extends ProviderDefinition<string> ? true : false
>;
export type AnthropicIsANamedProviderDefinition = Assert<
  typeof anthropicProvider extends ProviderDefinition<'anthropic'> ? true : false
>;
export type OpenAIIsAProviderDefinition = Assert<
  typeof openaiProvider extends ProviderDefinition<string> ? true : false
>;
export type OpenAIIsANamedProviderDefinition = Assert<
  typeof openaiProvider extends ProviderDefinition<'openai'> ? true : false
>;
export type GeminiIsAProviderDefinition = Assert<
  typeof geminiProvider extends ProviderDefinition<string> ? true : false
>;
export type GeminiIsANamedProviderDefinition = Assert<
  typeof geminiProvider extends ProviderDefinition<'gemini'> ? true : false
>;

export type AnthropicSdkIsAConfigurationClient = Assert<
  Anthropic extends NonNullable<AnthropicProviderConfiguration['client']> ? true : false
>;
export type OpenAISdkIsAConfigurationClient = Assert<
  OpenAI extends NonNullable<OpenAIProviderConfiguration['client']> ? true : false
>;
export type GoogleGenAiIsAConfigurationClient = Assert<
  GoogleGenAI extends NonNullable<GeminiProviderConfiguration['client']> ? true : false
>;
