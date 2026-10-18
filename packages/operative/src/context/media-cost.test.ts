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

  it('refuses a file handle issued by another provider', () => {
    const handle = (provider: string): MediaContent => ({
      type: 'image',
      source: { kind: 'provider-file', provider, providerFileId: 'file-1' },
    });
    expect(createCatalogMediaCostEstimator([anthropic])(handle('openai'), position)).toMatchObject({
      outcome: 'unsupported',
      reason: 'source-form-not-accepted',
    });
    expect(
      createCatalogMediaCostEstimator([anthropic])(handle('anthropic'), position),
    ).toMatchObject({ outcome: 'estimated' });
  });

  it('refuses a MIME family the backend does not list', () => {
    expect(
      createCatalogMediaCostEstimator([anthropic])(inline('image', 'QUJD', 'audio/mpeg'), position),
    ).toMatchObject({ outcome: 'unsupported', reason: 'mime-family-not-accepted' });
  });

  it('costs a part of unknown size at the largest per-part cap among the backends that take it', () => {
    const remote: MediaContent = {
      type: 'image',
      source: { kind: 'remote-url', url: 'https://example.com/a.png' },
    };
    const cap = anthropic.mediaLimits.find((entry) => entry.modality === 'image')!.maxBytes!;
    expect(createCatalogMediaCostEstimator([anthropic])(remote, position)).toEqual({
      ...position,
      modality: 'image',
      outcome: 'estimated',
      tokens: (cap / 1024) * MEDIA_TOKENS_PER_KIBIBYTE.image,
      basis: 'catalog-estimate',
    });
  });

  it('cannot bound a part of unknown size when no backend that takes it declares a cap', () => {
    const remote: MediaContent = {
      type: 'image',
      source: { kind: 'remote-url', url: 'https://example.com/a.png' },
    };
    // OpenAI declares an image count but no per-image byte limit.
    expect(createCatalogMediaCostEstimator([openai])(remote, position)).toMatchObject({
      outcome: 'unbounded',
      reason: 'size-unknown',
    });
    // Beside a backend that bounds it, the part is costed at that backend's cap:
    // dispatch is limited to the backends that admit it, so OpenAI never sees it.
    expect(createCatalogMediaCostEstimator([anthropic, openai])(remote, position)).toMatchObject({
      outcome: 'estimated',
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

  it('costs a resolved part by the resolver’s media type, not a stale one on the stored part', () => {
    const stale: MediaContent = {
      type: 'image',
      mimeType: 'application/octet-stream',
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
    expect(estimate(stale, position)).toMatchObject({ outcome: 'estimated' });
  });

  it('refuses a remote URL on a backend that does not fetch URLs itself, and costs it at the cap on one that does', () => {
    const remote: MediaContent = {
      type: 'image',
      mimeType: 'image/png',
      source: { kind: 'remote-url', url: 'https://example.com/a.png' },
    };
    const gemini20 = catalog.descriptors.find((row) => row.model.startsWith('gemini-2.0'));
    const gemini25 = catalog.descriptors.find(
      (row) => row.provider === 'gemini' && !row.model.startsWith('gemini-2.0'),
    )!;
    expect(gemini20).toBeDefined();

    expect(createCatalogMediaCostEstimator([gemini20!])(remote, position)).toMatchObject({
      outcome: 'unsupported',
      reason: 'source-form-not-accepted',
    });
    // The per-part cap Gemini documents makes an unsized URL costable.
    expect(createCatalogMediaCostEstimator([gemini25])(remote, position)).toMatchObject({
      outcome: 'estimated',
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

  it('considers only the backends that accept the modality, and refuses only when none does', () => {
    const part = inline('audio', base64Of(1024), 'audio/mpeg');
    expect(createCatalogMediaCostEstimator([gemini])(part, position)).toMatchObject({
      outcome: 'estimated',
    });
    // A mixed fleet: Anthropic takes no audio, so it is not consulted for it.
    expect(createCatalogMediaCostEstimator([gemini, anthropic])(part, position)).toMatchObject({
      outcome: 'estimated',
    });
    expect(createCatalogMediaCostEstimator([anthropic, openai])(part, position)).toMatchObject({
      outcome: 'unsupported',
      reason: 'modality-not-accepted',
    });
  });

  it('accepts a part when at least one backend that takes the modality takes its source form', () => {
    // A managed asset is not a wire form at any backend, so it is refused;
    // an OpenAI file handle is taken by OpenAI alone, and that is enough here.
    // Whether one backend takes the whole request is admission's question.
    const managed: MediaContent = {
      type: 'image',
      source: { kind: 'managed-asset', assetId: 'a' },
    };
    expect(createCatalogMediaCostEstimator([anthropic, gemini])(managed, position)).toMatchObject({
      outcome: 'unsupported',
      reason: 'source-form-not-accepted',
    });
    const openAIFile: MediaContent = {
      type: 'document',
      mimeType: 'application/pdf',
      source: { kind: 'provider-file', provider: 'openai', providerFileId: 'file-1' },
    };
    expect(
      createCatalogMediaCostEstimator([anthropic, openai])(openAIFile, position),
    ).not.toMatchObject({ reason: 'source-form-not-accepted' });
  });
});

describe('mimeFamilyOf reads the base media type (COR-716)', () => {
  it('ignores parameters and case', () => {
    expect(mimeFamilyOf('application/pdf;version=1.7')).toBe('document');
    expect(mimeFamilyOf('Application/PDF')).toBe('document');
    expect(mimeFamilyOf('Text/Plain; charset=utf-8')).toBe('text');
  });
});

describe('mimeFamilyOf reads the shared document table (COR-716)', () => {
  it('puts the structured-text and office document types in the document family', () => {
    for (const mimeType of [
      'application/json',
      'application/xml',
      'application/rtf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]) {
      expect(mimeFamilyOf(mimeType)).toBe('document');
    }
    expect(mimeFamilyOf('application/octet-stream')).toBe('application');
    expect(mimeFamilyOf('text/csv')).toBe('text');
  });
});
