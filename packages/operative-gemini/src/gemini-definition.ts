import type {
  ProviderConfigurationBase,
  ProviderDefinition,
} from '@lostgradient/operative/provider-kit';
import type {
  GeminiGenerativeModel,
  GeminiProviderOptions,
  GeminiStreamingModel,
} from './gemini-types.ts';
import { createGeminiProvider, createGeminiProviderStream } from './gemini.ts';

/**
 * The configuration {@link geminiProvider} accepts: the shared base plus every option
 * `createGeminiProvider` takes.
 *
 * An injected `client` has to serve both calls, because one configuration feeds both
 * {@link ProviderDefinition.generate} and {@link ProviderDefinition.stream}; a real Gemini model
 * does. To inject a client that serves only one, call the factory directly.
 */
export type GeminiProviderConfiguration = ProviderConfigurationBase &
  Omit<GeminiProviderOptions, 'client'> & {
    client?: (GeminiGenerativeModel & GeminiStreamingModel) | undefined;
  };

/**
 * The Gemini model provider, ready to register with a host.
 *
 * Each method hands the configuration object, whole, to `createGeminiProvider` or
 * `createGeminiProviderStream`.
 */
export const geminiProvider: ProviderDefinition<'gemini', GeminiProviderConfiguration> = {
  name: 'gemini',
  generate: (configuration) => createGeminiProvider(configuration),
  stream: (configuration) => createGeminiProviderStream(configuration),
};
