import type { OpenAIClient, OpenAIProviderOptions, OpenAIStreamingClient } from './openai-types.ts';
import { createOpenAIProvider, createOpenAIProviderStream } from './openai.ts';
import type { ProviderConfigurationBase, ProviderDefinition } from './provider-definition.ts';

/**
 * The configuration {@link openaiProvider} accepts: the shared base plus every option
 * `createOpenAIProvider` takes.
 *
 * An injected `client` has to serve both calls, because one configuration feeds both
 * {@link ProviderDefinition.generate} and {@link ProviderDefinition.stream}; a real `OpenAI`
 * client does. To inject a client that serves only one, call the factory directly.
 */
export type OpenAIProviderConfiguration = ProviderConfigurationBase &
  Omit<OpenAIProviderOptions, 'client'> & {
    client?: (OpenAIClient & OpenAIStreamingClient) | undefined;
  };

/**
 * The OpenAI model provider, ready to register with a host.
 *
 * Each method hands the configuration object, whole, to `createOpenAIProvider` or
 * `createOpenAIProviderStream`.
 */
export const openaiProvider: ProviderDefinition<'openai', OpenAIProviderConfiguration> = {
  name: 'openai',
  generate: (configuration) => createOpenAIProvider(configuration),
  stream: (configuration) => createOpenAIProviderStream(configuration),
};
