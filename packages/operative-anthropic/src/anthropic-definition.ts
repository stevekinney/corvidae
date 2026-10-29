import type {
  ProviderConfigurationBase,
  ProviderDefinition,
} from '@lostgradient/operative/provider-kit';
import { createAnthropicProviderStream } from './anthropic-stream.ts';
import type {
  AnthropicClient,
  AnthropicProviderOptions,
  AnthropicStreamingClient,
} from './anthropic-types.ts';
import { createAnthropicProvider } from './anthropic.ts';

/**
 * The configuration {@link anthropicProvider} accepts: the shared base plus every option
 * `createAnthropicProvider` takes.
 *
 * An injected `client` has to serve both calls, because one configuration feeds both
 * {@link ProviderDefinition.generate} and {@link ProviderDefinition.stream}; a real `Anthropic`
 * client does. To inject a client that serves only one, call the factory directly.
 */
export type AnthropicProviderConfiguration = ProviderConfigurationBase &
  Omit<AnthropicProviderOptions, 'client'> & {
    client?: (AnthropicClient & AnthropicStreamingClient) | undefined;
  };

/**
 * The Anthropic model provider, ready to register with a host.
 *
 * Each method hands the configuration object, whole, to `createAnthropicProvider` or
 * `createAnthropicProviderStream`.
 */
export const anthropicProvider: ProviderDefinition<'anthropic', AnthropicProviderConfiguration> = {
  name: 'anthropic',
  generate: (configuration) => createAnthropicProvider(configuration),
  stream: (configuration) => createAnthropicProviderStream(configuration),
};
