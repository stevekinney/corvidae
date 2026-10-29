/**
 * The `@lostgradient/operative/provider-kit` entry point: the runtime surface a provider package
 * builds on. The provider definitions themselves are covered by the contract suite in
 * `@lostgradient/operative/provider-testing`, which each `test/<provider>/contract.test.ts` runs.
 */
import * as providerKit from '@lostgradient/operative/provider-kit';
import { describe, expect, it } from 'bun:test';

describe('@lostgradient/operative/provider-kit', () => {
  it('exports exactly the runtime surface a provider package builds on', () => {
    expect(Object.keys(providerKit).toSorted()).toEqual([
      'ProviderContractError',
      'ProviderError',
      'REPLAY_DATA_DROPPED_METADATA_KEY',
      'ToolCallParseError',
      'anthropicSamplingSupport',
      'assertBatchSurface',
      'buildState',
      'classifyProviderError',
      'concatenateTextParts',
      'createCacheAwareAssembly',
      'createModelCatalog',
      'defineOwn',
      'extractSamplingParameterFields',
      'findBlock',
      'isProviderContractError',
      'isStrictCompatible',
      'isToolCallParseError',
      'readBackendDescriptors',
      'resolveAnthropicEffort',
      'resolveAnthropicModel',
      'resolveCommonParameters',
      'resolveGeminiEffort',
      'resolveGeminiModel',
      'resolveOpenAIEffort',
      'resolveOpenAIModel',
      'shouldRetryProviderError',
      'withBackendDescriptors',
      'withInputLineage',
    ]);
  });
});
