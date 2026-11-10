// Type-level contract for COR-2147. This file is checked by `tsc --noEmit`; it is not a runtime
// Bun test. The third type parameter of `ProviderDefinition` is the plugin's validated
// configuration, and it is the second argument of every factory.

import type { DecisionModel } from '../decisions/types.ts';
import type { ProviderConfigurationBase, ProviderDefinition } from './provider-definition.ts';
import type { GenerateFunction, StreamingGenerateFunction } from './types.ts';

type PluginConfiguration = { readonly baseURL: string };

declare const generateFunction: GenerateFunction;
declare const streamFunction: StreamingGenerateFunction;
declare const decisionModel: DecisionModel;

// Every factory receives the host's configuration, then the plugin's, typed by the third parameter.
const typed: ProviderDefinition<'typed', ProviderConfigurationBase, PluginConfiguration> = {
  name: 'typed',
  generate: (_configuration, pluginConfiguration) => {
    const baseURL: string = pluginConfiguration.baseURL;
    void baseURL;
    return generateFunction;
  },
  stream: (_configuration, pluginConfiguration) => {
    const baseURL: string = pluginConfiguration.baseURL;
    void baseURL;
    return streamFunction;
  },
  decide: (_configuration, pluginConfiguration) => {
    const baseURL: string = pluginConfiguration.baseURL;
    void baseURL;
    return decisionModel;
  },
};
void typed;

// A factory cannot read a field the plugin configuration does not carry.
const unknownField: ProviderDefinition<
  'unknown-field',
  ProviderConfigurationBase,
  PluginConfiguration
> = {
  name: 'unknown-field',
  generate: (_configuration, pluginConfiguration) => {
    // @ts-expect-error — `region` is not part of the plugin configuration.
    void pluginConfiguration.region;
    return generateFunction;
  },
};
void unknownField;

// A definition for one plugin configuration is not assignable to another.
declare const typedDefinition: ProviderDefinition<
  'typed',
  ProviderConfigurationBase,
  PluginConfiguration
>;
// @ts-expect-error — a `{ baseURL: string }` factory does not accept a `{ region: string }` configuration.
const mismatched: ProviderDefinition<'typed', ProviderConfigurationBase, { region: string }> =
  typedDefinition;
void mismatched;
