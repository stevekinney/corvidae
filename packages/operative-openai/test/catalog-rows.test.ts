/**
 * The OpenAI rows (`openAIRows`): every assertion is computed against the tables the rows are
 * built from. They moved here from Operative's model catalog tests when the rows moved out of
 * Operative (COR-2151); the endpoint rule, which Operative once read from its own options, is
 * `openAIRows`'s `baseURL`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getProviderCapabilities, type ProviderCapabilities } from '@lostgradient/operative';
import {
  backendPricing,
  type BackendDescriptor,
  type Effort,
} from '@lostgradient/operative/provider-kit';

import {
  OPENAI_LIMITS,
  OPENAI_MODEL_ALIASES,
  OPENAI_REASONING_MODELS,
  openAIPricingTable,
  openAIRows,
  resolveOpenAIEffort,
} from '../src/openai-catalog.ts';

const FIXED_NOW = '2026-09-02T12:00:00.000Z';
const TIERS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

let savedBaseUrl: string | undefined;
beforeEach(() => {
  savedBaseUrl = process.env['OPENAI_BASE_URL'];
  delete process.env['OPENAI_BASE_URL'];
});
afterEach(() => {
  if (savedBaseUrl === undefined) delete process.env['OPENAI_BASE_URL'];
  else process.env['OPENAI_BASE_URL'] = savedBaseUrl;
});

describe('openAIRows: model set (computed, not hand-copied)', () => {
  it('has one row per model of OPENAI_LIMITS, covering every model the alias, reasoning and price tables name', () => {
    const rows = openAIRows({ freshness: FIXED_NOW });
    const models = new Set(rows.map((row) => row.model));
    expect([...models].toSorted()).toEqual(Object.keys(OPENAI_LIMITS).toSorted());
    for (const model of [
      ...Object.values(OPENAI_MODEL_ALIASES),
      ...OPENAI_REASONING_MODELS,
      ...Object.keys(openAIPricingTable),
    ]) {
      expect(models.has(model)).toBe(true);
    }
    expect(rows).toHaveLength(8);
  });

  it('names its provider openai, its endpoint chat.completions, and stamps the freshness it is given', () => {
    for (const row of openAIRows({ freshness: FIXED_NOW })) {
      expect([row.provider, row.endpoint, row.freshness]).toEqual([
        'openai',
        'chat.completions',
        FIXED_NOW,
      ]);
    }
  });

  it('is deeply frozen, one level into a row’s own nested values', () => {
    const rows = openAIRows({ freshness: FIXED_NOW });
    expect(Object.isFrozen(rows)).toBe(true);
    for (const row of rows) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.aliases)).toBe(true);
      expect(Object.isFrozen(row.mediaCounts)).toBe(true);
      expect(Object.isFrozen(row.parameterCompatibility)).toBe(true);
      expect(Object.isFrozen(row.effort.degradesTo)).toBe(true);
      if (row.pricing) expect(Object.isFrozen(row.pricing)).toBe(true);
    }
  });
});

describe('openAIRows: effort, sampling, pricing and media', () => {
  const rows = openAIRows({ freshness: FIXED_NOW });

  it('degradesTo matches resolveOpenAIEffort for every tier; only the reasoning models are native', () => {
    for (const row of rows) {
      expect(row.effort.nativeMapping).toBe(
        OPENAI_REASONING_MODELS.has(row.model) ? 'native' : 'unsupported',
      );
      for (const tier of TIERS) {
        expect(row.effort.degradesTo[tier]).toBe(resolveOpenAIEffort(tier, row.model));
      }
    }
  });

  it('advertises sampling and requestMetadata', () => {
    for (const row of rows) {
      for (const field of ['temperature', 'topP', 'requestMetadata'] as const) {
        expect(row.parameterCompatibility).toContain(field);
      }
    }
  });

  it('matches openAIPricingTable exactly, in USD, for every model, and prices every row', () => {
    for (const row of rows) {
      expect(row.pricing).toEqual(backendPricing(openAIPricingTable[row.model]));
      expect(row.pricing?.currency).toBe('USD');
    }
  });

  it('allows 1500 images per request and no per-part byte cap', () => {
    for (const row of rows) {
      expect(row.mediaCounts).toEqual([{ modality: 'image', maxPerRequest: 1500 }]);
      expect(row.mediaLimits).toEqual([]);
      expect(row.contextWindowTokens).toBeGreaterThan(0);
      expect(row.maxOutputTokens).toBeGreaterThan(0);
    }
  });
});

describe('openAIRows: endpointAmbiguous', () => {
  it('is true and reports every capability flag false when baseURL is a non-empty string', () => {
    for (const row of openAIRows({ freshness: FIXED_NOW, baseURL: 'https://proxy.internal/v1' })) {
      expect(row.endpointAmbiguous).toBe(true);
      expect(row.caching).toBe(false);
      expect(row.batchInference).toBe(false);
      expect(row.explicitThinkingRequest).toBe(false);
      expect(row.serverSideTokenCounting).toBe(false);
      expect(row.availability).toBe('unknown');
    }
  });

  it('is true when OPENAI_BASE_URL is set in the environment', () => {
    process.env['OPENAI_BASE_URL'] = 'http://localhost:1234/v1';
    for (const row of openAIRows({ freshness: FIXED_NOW })) {
      expect(row.endpointAmbiguous).toBe(true);
      expect(row.batchInference).toBe(false);
    }
  });

  it('treats an empty-string baseURL and an empty OPENAI_BASE_URL as the default endpoint', () => {
    process.env['OPENAI_BASE_URL'] = '';
    for (const row of openAIRows({ freshness: FIXED_NOW, baseURL: '' })) {
      expect(row.endpointAmbiguous).toBe(false);
      expect(row.availability).toBe('available');
      expect(row.batchInference).toBe(true);
    }
  });
});

describe('getProviderCapabilities over the OpenAI rows', () => {
  const NONE: ProviderCapabilities = {
    batchInference: false,
    explicitThinkingRequest: false,
    requestControlledContextCaching: false,
    serverSideTokenCounting: false,
  };
  const capabilities = (descriptors: readonly BackendDescriptor[]) =>
    getProviderCapabilities('openai', { descriptors });

  it('reports batches, and nothing else, on the default endpoint', () => {
    expect(capabilities(openAIRows())).toEqual({ ...NONE, batchInference: true });
  });

  it('reports nothing on an ambiguous endpoint', () => {
    expect(capabilities(openAIRows({ baseURL: 'https://proxy.internal/v1' }))).toEqual(NONE);
    process.env['OPENAI_BASE_URL'] = 'http://localhost:1234/v1';
    expect(capabilities(openAIRows())).toEqual(NONE);
  });

  it('reports nothing for a provider the rows do not name', () => {
    expect(getProviderCapabilities('voyage', { descriptors: openAIRows() })).toEqual(NONE);
  });
});
