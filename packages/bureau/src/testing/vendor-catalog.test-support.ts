import {
  createModelCatalog,
  type BackendDescriptor,
  type CreateModelCatalogOptions,
  type ModelCatalog,
} from '@lostgradient/operative';

import rows from './vendor-rows.fixture.json';

/**
 * A run's cost estimation for `gpt-4o`. Operative prices a model only when the estimation names its
 * price (COR-2151), so a bare `{ model: 'gpt-4o' }` estimates nothing.
 */
export const gpt4oCostEstimation = {
  model: 'gpt-4o',
  pricing: {
    customPricing: {
      'gpt-4o': {
        promptCostPerMillionTokens: 2.5,
        completionCostPerMillionTokens: 10,
        cacheReadCostPerMillionTokens: 1.25,
      },
    },
  },
};

/**
 * The rows of the fixture, optionally of one provider. The fixture is a frozen copy of the rows
 * three provider packages shipped, written into `vendor-rows.fixture.json`: Bureau's tests take no
 * dependency on a provider package, so an edit to one never reaches their cache key
 * (`scripts/operative-provider-boundaries.slow.test.ts`). The names and capabilities are the
 * fixture's own; changing a provider package changes nothing here.
 */
export function vendorRows(provider?: string): readonly BackendDescriptor[] {
  const all = rows as unknown as readonly BackendDescriptor[];
  return provider === undefined ? all : all.filter((row) => row.provider === provider);
}

/**
 * A catalog of the fixture's Anthropic, OpenAI and Gemini rows, for a test that needs models to run
 * against. Operative holds no row of its own (COR-2151); `options.descriptors` adds rows after
 * the fixture's.
 */
export function createVendorCatalog(options?: CreateModelCatalogOptions): ModelCatalog {
  return createModelCatalog({
    ...options,
    descriptors: [...vendorRows(), ...(options?.descriptors ?? [])],
  });
}
