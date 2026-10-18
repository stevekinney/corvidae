import { describe, expect, it } from 'bun:test';
import type { MediaContent } from 'conversationalist';

import { createModelCatalog } from '../providers/model-catalog';
import {
  createCatalogMediaCostEstimator,
  MEDIA_TOKENS_PER_KIBIBYTE,
  mimeFamilyOf,
  sourceByteLength,
} from './media-cost';

const catalog = createModelCatalog({ now: () => '2026-10-17T00:00:00.000Z' });
const anthropic = catalog.descriptors.find((row) => row.provider === 'anthropic')!;
const openai = catalog.descriptors.find((row) => row.provider === 'openai')!;
const gemini = catalog.descriptors.find((row) => row.provider === 'gemini')!;
const position = { messageId: 'm-1', partIndex: 0 } as const;

/** `bytes` bytes of base64, so `sourceByteLength` reads them back exactly. */
function base64Of(bytes: number): string {
  return 'A'.repeat(Math.ceil((bytes * 4) / 3)).slice(0, Math.floor((bytes * 4) / 3 / 4) * 4);
}

function inline(type: MediaContent['type'], data: string, mimeType?: string): MediaContent {
  return {
    type,
    source: { kind: 'inline', data, encoding: 'base64' },
    ...(mimeType === undefined ? {} : { mimeType }),
  };
}

describe('sourceByteLength and mimeFamilyOf', () => {
  it('reads bytes from inline base64, inline text, and base64 data URLs only', () => {
    expect(sourceByteLength({ kind: 'inline', data: 'QUJDREVGRw==', encoding: 'base64' })).toBe(7);
    expect(sourceByteLength({ kind: 'inline', data: 'héllo', encoding: 'utf8' })).toBe(6);
    expect(sourceByteLength({ kind: 'data-url', url: 'data:image/png;base64,QUJD' })).toBe(3);
    expect(
      sourceByteLength({ kind: 'remote-url', url: 'https://example.com/a.png' }),
    ).toBeUndefined();
    expect(sourceByteLength({ kind: 'managed-asset', assetId: 'a' })).toBeUndefined();
  });

  it('puts PDFs in the document family and unknown binary types in application', () => {
    expect(mimeFamilyOf('image/png')).toBe('image');
    expect(mimeFamilyOf('application/pdf')).toBe('document');
    expect(mimeFamilyOf('application/zip')).toBe('application');
    expect(mimeFamilyOf(undefined)).toBeUndefined();
  });
});

describe('createCatalogMediaCostEstimator', () => {
  it('estimates an inline part from its bytes and the modality rate, never as zero', () => {
    const estimate = createCatalogMediaCostEstimator([anthropic]);
    const outcome = estimate(inline('image', base64Of(2048), 'image/png'), position);
    expect(outcome).toEqual({
      ...position,
      modality: 'image',
      outcome: 'estimated',
      tokens: 2 * MEDIA_TOKENS_PER_KIBIBYTE.image,
      basis: 'catalog-estimate',
    });
    expect(estimate(inline('image', 'QQ==', 'image/png'), position)).toMatchObject({
      outcome: 'estimated',
      tokens: 1,
    });
  });

  it('refuses a modality the backend takes no input for', () => {
    expect(
      createCatalogMediaCostEstimator([openai])(inline('audio', 'QUJD'), position),
    ).toMatchObject({ outcome: 'unsupported', reason: 'modality-not-accepted' });
  });

  it('refuses a source form the backend does not list', () => {
    const managed: MediaContent = {
      type: 'image',
      source: { kind: 'managed-asset', assetId: 'a' },
    };
    expect(createCatalogMediaCostEstimator([anthropic])(managed, position)).toMatchObject({
      outcome: 'unsupported',
      reason: 'source-form-not-accepted',
    });
  });

  it('refuses a MIME family the backend does not list', () => {
    expect(
      createCatalogMediaCostEstimator([anthropic])(inline('image', 'QUJD', 'audio/mpeg'), position),
    ).toMatchObject({ outcome: 'unsupported', reason: 'mime-family-not-accepted' });
  });

  it('cannot bound a part whose bytes are not carried', () => {
    const remote: MediaContent = {
      type: 'image',
      source: { kind: 'remote-url', url: 'https://example.com/a.png' },
    };
    expect(createCatalogMediaCostEstimator([anthropic])(remote, position)).toMatchObject({
      outcome: 'unbounded',
      reason: 'size-unknown',
    });
  });

  it('takes a resolved source, size, and media type into account', () => {
    const managed: MediaContent = {
      type: 'image',
      source: { kind: 'managed-asset', assetId: 'a' },
    };
    const estimate = createCatalogMediaCostEstimator([anthropic], {
      resolvedSources: new Map([
        [
          'm-1:0',
          {
            outcome: 'resolved',
            source: { kind: 'remote-url', url: 'https://cdn.example/a.png' },
            mimeType: 'image/png',
            byteLength: 4096,
            safety: 'clean',
          },
        ],
      ]),
    });
    expect(estimate(managed, position)).toMatchObject({
      outcome: 'estimated',
      tokens: 4 * MEDIA_TOKENS_PER_KIBIBYTE.image,
    });
  });

  it('refuses a part over a per-part byte limit', () => {
    const limit = anthropic.mediaLimits.find((entry) => entry.modality === 'image')!.maxBytes!;
    expect(
      createCatalogMediaCostEstimator([anthropic])(
        inline('image', base64Of(limit + 4), 'image/png'),
        position,
      ),
    ).toMatchObject({ outcome: 'unbounded', reason: 'media-limit-exceeded' });
  });

  it('reports no-estimator when it has no descriptors to cost against', () => {
    expect(createCatalogMediaCostEstimator([])(inline('image', 'QUJD'), position)).toMatchObject({
      outcome: 'unbounded',
      reason: 'no-estimator',
    });
  });

  it('must satisfy every backend the run may be served by', () => {
    const part = inline('audio', base64Of(1024), 'audio/mpeg');
    expect(createCatalogMediaCostEstimator([gemini])(part, position)).toMatchObject({
      outcome: 'estimated',
    });
    expect(createCatalogMediaCostEstimator([gemini, anthropic])(part, position)).toMatchObject({
      outcome: 'unsupported',
      reason: 'modality-not-accepted',
    });
  });
});
