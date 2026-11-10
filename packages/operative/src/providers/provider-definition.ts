import type { DecisionModel } from '../decisions/types.ts';
import type { GenerateFunction, StreamingGenerateFunction } from './types.ts';

/**
 * The configuration every model provider accepts, whichever package supplies it.
 *
 * A host that selects a provider by name (a configuration file, a request, an environment) holds
 * this much and nothing vendor-specific. A provider's own configuration type extends it with the
 * options only that provider understands, and its {@link ProviderDefinition} hands the whole
 * object to its factory, so those extra fields reach the vendor client unchanged.
 */
export interface ProviderConfigurationBase {
  /** The name of the provider that should serve this configuration, matching a definition's `name`. */
  provider: string;
  /** The provider-native model identifier, or a shorthand alias the provider resolves. */
  model: string;
  /** The cap on tokens in one response. Each provider has its own default when this is absent. */
  maximumTokens?: number;
  /** The sampling temperature. Each provider has its own default when this is absent. */
  temperature?: number;
  /** The API key. Each provider falls back to its own environment variable when this is absent. */
  apiKey?: string;
}

/**
 * What a model provider package offers a host: a name and one or more capability factories.
 *
 * Methods, not function-typed properties, so a definition for a narrower configuration (one that
 * adds an injected `client`, say) is assignable to `ProviderDefinition<string>` and can sit in a
 * list of definitions with no cast. Each method passes its configuration object through to the
 * provider's existing factory whole, so a field the base type does not name still arrives.
 *
 * @typeParam Name - The literal name the definition registers under.
 * @typeParam Configuration - The configuration the provider accepts; a refinement of
 * {@link ProviderConfigurationBase}.
 */
interface ProviderDefinitionCapabilities<
  Configuration extends ProviderConfigurationBase,
  PluginConfiguration,
> {
  /** Builds a generate function that returns each response whole. */
  generate?(
    configuration: Configuration,
    pluginConfiguration: PluginConfiguration,
  ): GenerateFunction;
  /** Builds a generate function that reports the response while it arrives. */
  stream?(
    configuration: Configuration,
    pluginConfiguration: PluginConfiguration,
  ): StreamingGenerateFunction;
  /** Builds a model that answers structured decisions natively. */
  decide?(configuration: Configuration, pluginConfiguration: PluginConfiguration): DecisionModel;
}

/** A provider definition with at least one callable capability. */
export type ProviderDefinition<
  Name extends string = string,
  Configuration extends ProviderConfigurationBase = ProviderConfigurationBase,
  PluginConfiguration = unknown,
> = { readonly name: Name } & (
  | (Omit<ProviderDefinitionCapabilities<Configuration, PluginConfiguration>, 'generate'> & {
      generate(
        configuration: Configuration,
        pluginConfiguration: PluginConfiguration,
      ): GenerateFunction;
    })
  | (Omit<ProviderDefinitionCapabilities<Configuration, PluginConfiguration>, 'stream'> & {
      stream(
        configuration: Configuration,
        pluginConfiguration: PluginConfiguration,
      ): StreamingGenerateFunction;
    })
  | (Omit<ProviderDefinitionCapabilities<Configuration, PluginConfiguration>, 'decide'> & {
      decide(configuration: Configuration, pluginConfiguration: PluginConfiguration): DecisionModel;
    })
);
