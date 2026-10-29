/**
 * Type-level regression test for the Anthropic provider definition.
 *
 * The definition has to sit in a list of `ProviderDefinition<string>` (and in its own literal-named
 * `ProviderDefinition`) with no cast, and the real vendor client has to be assignable to the
 * `client` its configuration accepts, because that one field serves both `generate` and `stream`.
 *
 * Why the `.test-d.ts` suffix: `tsconfig.json` includes `src`, so the type-check covers this file,
 * while `tsconfig.source.json` excludes the suffix, so the vendor SDK types it names never reach the
 * published declarations. It declares only types, so it is erased entirely.
 */
import type { Anthropic } from '@anthropic-ai/sdk';

import type { ProviderDefinition } from '@lostgradient/operative/provider-kit';
import type { anthropicProvider, AnthropicProviderConfiguration } from './anthropic-definition.ts';

type Assert<T extends true> = T;

export type AnthropicIsAProviderDefinition = Assert<
  typeof anthropicProvider extends ProviderDefinition<string> ? true : false
>;
export type AnthropicIsANamedProviderDefinition = Assert<
  typeof anthropicProvider extends ProviderDefinition<'anthropic'> ? true : false
>;

export type AnthropicSdkIsAConfigurationClient = Assert<
  Anthropic extends NonNullable<AnthropicProviderConfiguration['client']> ? true : false
>;
