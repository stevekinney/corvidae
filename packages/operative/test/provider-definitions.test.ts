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
      'EFFORT_ORDER',
      'FULL_PARAMETER_COMPATIBILITY',
      'ProviderContractError',
      'ProviderError',
      'REPLAY_DATA_DROPPED_METADATA_KEY',
      'ToolCallParseError',
      'aliasesFor',
      'anthropicSamplingSupport',
      'assertBatchSurface',
      'backendPricing',
      'buildState',
      'classifyProviderError',
      'concatenateTextParts',
      'createCacheAwareAssembly',
      'createModelCatalog',
      'deepFreeze',
      'defineOwn',
      'degradationOf',
      'extractSamplingParameterFields',
      'findBlock',
      'isProviderContractError',
      'isStrictCompatible',
      'isToolCallParseError',
      'portableTiers',
      'readBackendDescriptors',
      'readEnvironmentConfiguration',
      'resolveCommonParameters',
      'shouldRetryProviderError',
      'withBackendDescriptors',
      'withInputLineage',
    ]);
  });
});
