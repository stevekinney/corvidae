/**
 * The Anthropic rows (`anthropicRows`): every assertion is computed against the tables the rows
 * are built from, so an addition to one of them without a matching row fails here. They moved here
 * from Operative's model catalog tests when the rows moved out of Operative (COR-2151).
 */
import { describe, expect, it } from 'bun:test';

import { getProviderCapabilities } from '@lostgradient/operative';
import {
  anthropicSamplingSupport,
  backendPricing,
  type BackendDescriptor,
  type Effort,
} from '@lostgradient/operative/provider-kit';

import {
  ANTHROPIC_EFFORT_SUPPORT,
  ANTHROPIC_LIMITS,
  ANTHROPIC_MODEL_ALIASES,
  anthropicPricingTable,
  anthropicRows,
  resolveAnthropicEffort,
} from '../src/anthropic-catalog.ts';

const FIXED_NOW = '2026-09-02T12:00:00.000Z';
const rows: readonly BackendDescriptor[] = anthropicRows({ freshness: FIXED_NOW });
const TIERS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

describe('anthropicRows: model set (computed, not hand-copied)', () => {
  it('has one row per model of ANTHROPIC_LIMITS, covering every model the effort and alias tables name', () => {
    const models = new Set(rows.map((row) => row.model));
    expect([...models].toSorted()).toEqual(Object.keys(ANTHROPIC_LIMITS).toSorted());
    for (const model of [
      ...Object.keys(ANTHROPIC_EFFORT_SUPPORT),
      ...Object.values(ANTHROPIC_MODEL_ALIASES),
      ...Object.keys(anthropicPricingTable),
    ]) {
      expect(models.has(model)).toBe(true);
    }
    expect(rows).toHaveLength(20);
  });

  it('names its provider anthropic, its endpoint messages, and stamps the freshness it is given', () => {
    for (const row of rows) {
      expect([row.provider, row.endpoint, row.freshness]).toEqual([
        'anthropic',
        'messages',
        FIXED_NOW,
      ]);
    }
  });

  it('never repeats a (provider, endpoint, model) triple', () => {
    const keys = rows.map((row) => `${row.provider}::${row.endpoint}::${row.model}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is deeply frozen, one level into a row’s own nested values', () => {
    expect(Object.isFrozen(rows)).toBe(true);
    for (const row of rows) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.aliases)).toBe(true);
      expect(Object.isFrozen(row.mediaLimits)).toBe(true);
      expect(Object.isFrozen(row.mediaCounts)).toBe(true);
      expect(Object.isFrozen(row.parameterCompatibility)).toBe(true);
      expect(Object.isFrozen(row.effort.portable)).toBe(true);
      expect(Object.isFrozen(row.effort.degradesTo)).toBe(true);
      expect(Object.isFrozen(row.modalities)).toBe(true);
      if (row.pricing) expect(Object.isFrozen(row.pricing)).toBe(true);
    }
  });

  it('defaults the freshness to a real timestamp', () => {
    // One call: each call stamps its own time, so two calls can straddle a millisecond.
    const freshness = anthropicRows()[0]!.freshness;
    expect(freshness).toBe(new Date(freshness).toISOString());
  });
});

describe('anthropicRows: effort', () => {
  it('degradesTo matches resolveAnthropicEffort for every tier on every row, and every row is native', () => {
    for (const row of rows) {
      expect(row.effort.nativeMapping).toBe('native');
      for (const tier of TIERS) {
        expect(row.effort.degradesTo[tier]).toBe(resolveAnthropicEffort(tier, row.model));
      }
    }
  });
});

describe('anthropicRows: sampling parameters follow the documented per-model decision', () => {
  // Models the cited pages do not settle (see anthropicSamplingSupport): conservatively not advertised.
  const UNSETTLED = ['claude-haiku-4-20250506', 'claude-3-5-haiku-20241022'];

  it('advertises temperature and topP exactly when the model is recorded as accepting them', () => {
    for (const row of rows) {
      const advertised = (['temperature', 'topP'] as const).map((field) =>
        row.parameterCompatibility.includes(field),
      );
      const accepted = anthropicSamplingSupport(row.model) === 'accepted';
      expect([row.model, advertised]).toEqual([row.model, [accepted, accepted]]);
    }
  });

  it('records a decision for every row except the documented unsettled ones', () => {
    const undecided = rows
      .map((row) => row.model)
      .filter((model) => anthropicSamplingSupport(model) === 'unsettled');
    expect(undecided.toSorted()).toEqual(UNSETTLED.toSorted());
  });

  it('does not advertise sampling for the current Claude models, which reject it', () => {
    for (const model of [
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-5',
    ]) {
      const row = rows.find((candidate) => candidate.model === model);
      expect(row?.parameterCompatibility).not.toContain('temperature');
      expect(row?.parameterCompatibility).not.toContain('topP');
    }
  });

  it('still advertises sampling for models that accept it', () => {
    for (const model of ['claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-4-6']) {
      const row = rows.find((candidate) => candidate.model === model);
      expect(row?.parameterCompatibility).toContain('temperature');
      expect(row?.parameterCompatibility).toContain('topP');
    }
  });

  it('keeps every other parameter, including toolChoice, on every row', () => {
    for (const row of rows) {
      for (const field of [
        'model',
        'effort',
        'maximumTokens',
        'stopSequences',
        'toolChoice',
        'responseFormat',
        'requestMetadata',
      ] as const) {
        expect(row.parameterCompatibility).toContain(field);
      }
    }
  });
});

describe('anthropicRows: pricing is derived from anthropicPricingTable, never fabricated', () => {
  it('matches the table exactly, in USD, for every model, and prices every row', () => {
    for (const row of rows) {
      expect(row.pricing).toEqual(backendPricing(anthropicPricingTable[row.model]));
      expect(row.pricing?.currency).toBe('USD');
    }
  });

  it('carries the Haiku 5.5 long-context tier and no tier on a flat-priced model', () => {
    expect(rows.find((row) => row.model === 'claude-haiku-5-5')?.pricing?.longContext).toEqual({
      inputTokensAbove: 100_000,
      inputPerMillionTokens: 0.5,
      outputPerMillionTokens: 2.5,
      cacheWritePerMillionTokens: 0.625,
      cacheReadPerMillionTokens: 0.05,
    });
    expect(
      rows.find((row) => row.model === 'claude-haiku-4-5')?.pricing?.longContext,
    ).toBeUndefined();
  });
});

describe('anthropicRows: access and media', () => {
  it('reports Mythos availability as unknown and every other row as available', () => {
    for (const row of rows) {
      expect([row.model, row.availability]).toEqual([
        row.model,
        row.model.startsWith('claude-mythos') ? 'unknown' : 'available',
      ]);
    }
  });

  it('carries the documented media limits: per-image bytes, and per-request image counts by context window', () => {
    const TEN_MEGABYTES = 10 * 1024 * 1024;
    const imageCount = (row: BackendDescriptor) =>
      row.mediaCounts.find((count) => count.modality === 'image')?.maxPerRequest;
    for (const row of rows) {
      // https://platform.claude.com/docs/en/build-with-claude/vision, "Request limits"
      expect(imageCount(row)).toBe(row.contextWindowTokens === 200_000 ? 100 : 600);
      expect(row.mediaLimits).toEqual([
        { scope: 'per-part', modality: 'image', maxBytes: TEN_MEGABYTES },
      ]);
      // A cap on a modality the backend takes no input for would never apply.
      for (const count of row.mediaCounts) expect(row.modalities[count.modality].input).toBe(true);
      expect(row.contextWindowTokens).toBeGreaterThan(0);
      expect(row.maxOutputTokens).toBeGreaterThan(0);
    }
    expect([...new Set(rows.map(imageCount))].toSorted((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      100, 600,
    ]);
  });

  it('populates a modalities entry for every Modality key on every row', () => {
    for (const row of rows) {
      for (const modality of ['text', 'image', 'audio', 'video', 'document', 'file'] as const) {
        expect(row.modalities[modality]).toBeDefined();
      }
    }
  });
});

describe('getProviderCapabilities over the Anthropic rows', () => {
  it('reports every capability flag, the same on every endpoint setting', () => {
    expect(getProviderCapabilities('anthropic', { descriptors: rows })).toEqual({
      batchInference: true,
      explicitThinkingRequest: true,
      requestControlledContextCaching: true,
      serverSideTokenCounting: true,
    });
  });

  it('reports no capability for a provider the rows do not name', () => {
    expect(getProviderCapabilities('voyage', { descriptors: rows })).toEqual({
      batchInference: false,
      explicitThinkingRequest: false,
      requestControlledContextCaching: false,
      serverSideTokenCounting: false,
    });
  });
});
