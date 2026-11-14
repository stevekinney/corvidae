/**
 * The Gemini rows (`geminiRows`): every assertion is computed against the tables the rows are
 * built from. They moved here from Operative's model catalog tests when the rows moved out of
 * Operative (COR-2151).
 */
import { describe, expect, it } from 'bun:test';

import { getProviderCapabilities } from '@lostgradient/operative';
import { backendPricing, type Effort } from '@lostgradient/operative/provider-kit';

import {
  GEMINI_LIMITS,
  GEMINI_MODEL_ALIASES,
  GEMINI_THINKING_MODELS,
  geminiPricingTable,
  geminiRows,
  resolveGeminiEffort,
} from '../src/gemini-catalog.ts';

const FIXED_NOW = '2026-09-02T12:00:00.000Z';
const rows = geminiRows({ freshness: FIXED_NOW });
const TIERS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

describe('geminiRows: model set (computed, not hand-copied)', () => {
  it('has one row per model of GEMINI_LIMITS, covering every model the alias, thinking and price tables name', () => {
    const models = new Set(rows.map((row) => row.model));
    expect([...models].toSorted()).toEqual(Object.keys(GEMINI_LIMITS).toSorted());
    for (const model of [
      ...Object.values(GEMINI_MODEL_ALIASES),
      ...GEMINI_THINKING_MODELS,
      ...Object.keys(geminiPricingTable),
    ]) {
      expect(models.has(model)).toBe(true);
    }
    expect(rows).toHaveLength(3);
  });

  it('names its provider gemini, its endpoint generateContent, and stamps the freshness it is given', () => {
    for (const row of rows) {
      expect([row.provider, row.endpoint, row.freshness]).toEqual([
        'gemini',
        'generateContent',
        FIXED_NOW,
      ]);
    }
  });

  it('is deeply frozen, one level into a row’s own nested values', () => {
    expect(Object.isFrozen(rows)).toBe(true);
    for (const row of rows) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.aliases)).toBe(true);
      expect(Object.isFrozen(row.mediaLimits)).toBe(true);
      expect(Object.isFrozen(row.parameterCompatibility)).toBe(true);
      expect(Object.isFrozen(row.effort.degradesTo)).toBe(true);
      if (row.pricing) expect(Object.isFrozen(row.pricing)).toBe(true);
    }
  });
});

describe('geminiRows: effort, parameters, pricing and media', () => {
  it('degradesTo matches resolveGeminiEffort for every tier; only the thinking models are native', () => {
    for (const row of rows) {
      expect(row.effort.nativeMapping).toBe(
        GEMINI_THINKING_MODELS.has(row.model) ? 'native' : 'unsupported',
      );
      for (const tier of TIERS) {
        expect(row.effort.degradesTo[tier]).toBe(resolveGeminiEffort(tier, row.model)?.effort);
      }
    }
  });

  it('omits requestMetadata, which Gemini has no field for, and advertises sampling', () => {
    for (const row of rows) {
      expect(row.parameterCompatibility).not.toContain('requestMetadata');
      expect(row.parameterCompatibility).toContain('temperature');
      expect(row.parameterCompatibility).toContain('topP');
    }
  });

  it('matches geminiPricingTable exactly, in USD, for every model, and prices every row', () => {
    for (const row of rows) {
      expect(row.pricing).toEqual(backendPricing(geminiPricingTable[row.model]));
      expect(row.pricing?.currency).toBe('USD');
    }
  });

  it('allows 3600 images per request and bounds every input modality per part, so a remote URL of unknown size can be costed', () => {
    // https://ai.google.dev/gemini-api/docs/file-input-methods: inline data is capped by the
    // 20 MB request total, so no single inline part can exceed it.
    const TWENTY_MEGABYTES = 20 * 1024 * 1024;
    for (const row of rows) {
      expect(row.mediaCounts).toEqual([{ modality: 'image', maxPerRequest: 3600 }]);
      for (const modality of ['image', 'document', 'audio', 'video'] as const) {
        if (!row.modalities[modality].input) continue;
        expect(row.mediaLimits).toContainEqual({
          scope: 'per-part',
          modality,
          maxBytes: TWENTY_MEGABYTES,
        });
      }
      expect(row.contextWindowTokens).toBeGreaterThan(0);
      expect(row.maxOutputTokens).toBeGreaterThan(0);
    }
  });

  it('has Gemini fetch remote URLs itself only on models that support external URLs', () => {
    // https://ai.google.dev/gemini-api/docs/file-input-methods: public HTTPS URLs
    // are accepted for external URLs, but "Gemini 2.0 models don't support this method".
    expect(rows.map((row) => [row.model, row.providerFetchesRemoteUrls])).toEqual([
      ['gemini-2.5-pro', true],
      ['gemini-2.5-flash', true],
      ['gemini-2.0-flash', false],
    ]);
  });
});

describe('getProviderCapabilities over the Gemini rows', () => {
  it('reports batches, caching and token counting, the same on every endpoint setting', () => {
    expect(getProviderCapabilities('gemini', { descriptors: rows })).toEqual({
      batchInference: true,
      explicitThinkingRequest: false,
      requestControlledContextCaching: true,
      serverSideTokenCounting: true,
    });
  });
});
