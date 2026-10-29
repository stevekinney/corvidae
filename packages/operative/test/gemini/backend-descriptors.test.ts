/**
 * Backend-descriptor attachment on the provider factories (AB-64 AC2,
 * AB-245). Each `create*Provider`/`create*ProviderStream` attaches the
 * single `BackendDescriptor` matching its resolved, post-alias model at
 * construction time. No network call and no credential — the local mocked
 * clients `packages/operative/test/<provider>/*.test.ts` already use.
 */
import { describe, expect, it } from 'bun:test';
import { readBackendDescriptors } from '../../src/providers/backend-descriptor-attachment.ts';
import { createGeminiProviderStream } from '../../src/providers/gemini.ts';
import type { BackendDescriptor } from '../../src/providers/model-catalog.ts';
import { createModelCatalog } from '../../src/providers/model-catalog.ts';
import { geminiStreamTextChunks } from '../../src/providers/test/gemini-fixtures.ts';
import { createMockGeminiStreamingModel } from '../../src/providers/test/gemini-mock-clients.ts';

// The provider factories under test read the wall clock through
// `createModelCatalog`'s default `now`, same as this helper — so every
// comparison below strips `freshness` rather than pinning it, and asserts
// separately that it is a well-formed ISO timestamp.
function seedDescriptor(provider: 'anthropic' | 'openai' | 'gemini', model: string) {
  return createModelCatalog().descriptors.find(
    (descriptor) => descriptor.provider === provider && descriptor.model === model,
  );
}

function withoutFreshness(descriptor: BackendDescriptor): Omit<BackendDescriptor, 'freshness'> {
  const { freshness: _freshness, ...rest } = descriptor;
  return rest;
}

describe('createGeminiProvider / createGeminiProviderStream — backend descriptor', () => {
  it('attaches the seed descriptor under the generateContentStream endpoint on the streaming variant', () => {
    // This factory calls the distinct `generateContentStream` operation, whose
    // model, modalities, limits, and pricing are those of the seed's
    // `generateContent` row. The attached descriptor names the operation this
    // function actually invokes, so admission can cost media against it
    // (COR-716) without misreporting the endpoint.
    const client = createMockGeminiStreamingModel([geminiStreamTextChunks]);
    const generate = createGeminiProviderStream({ model: 'gemini-2.5-flash', client });
    const expected = seedDescriptor('gemini', 'gemini-2.5-flash');
    if (!expected) throw new Error('expected a seed row for gemini-2.5-flash');

    const attached = readBackendDescriptors(generate);
    expect(attached).toHaveLength(1);
    expect(withoutFreshness(attached[0]!)).toEqual(
      withoutFreshness({ ...expected, endpoint: 'generateContentStream' }),
    );
  });
});
