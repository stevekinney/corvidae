/**
 * Backend-descriptor attachment on the provider factories (AB-64 AC2,
 * AB-245). Each `create*Provider`/`create*ProviderStream` attaches the
 * single `BackendDescriptor` matching its resolved, post-alias model at
 * construction time. No network call and no credential — the local mocked
 * clients `packages/operative/test/<provider>/*.test.ts` already use.
 */
import { describe, expect, it } from 'bun:test';
import { readBackendDescriptors } from '../../src/providers/backend-descriptor-attachment.ts';
import type { BackendDescriptor } from '../../src/providers/model-catalog.ts';
import { createModelCatalog } from '../../src/providers/model-catalog.ts';
import { createOpenAIProvider, createOpenAIProviderStream } from '../../src/providers/openai.ts';
import {
  openAIStreamTextChunks,
  openAITextResponse,
} from '../../src/providers/test/openai-fixtures.ts';
import {
  createMockOpenAIClient,
  createMockOpenAIStreamingClient,
} from '../../src/providers/test/openai-mock-clients.ts';

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

function expectMatchesSeed(
  attached: readonly BackendDescriptor[],
  expected: BackendDescriptor | undefined,
): void {
  if (!expected) {
    expect(attached).toEqual([]);
    return;
  }
  expect(attached).toHaveLength(1);
  const [descriptor] = attached;
  if (!descriptor) throw new Error('expected exactly one attached descriptor');
  expect(withoutFreshness(descriptor)).toEqual(withoutFreshness(expected));
  expect(descriptor.freshness).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
}

describe('createOpenAIProvider / createOpenAIProviderStream — backend descriptor', () => {
  it('attaches the same descriptor on the streaming variant', () => {
    const client = createMockOpenAIStreamingClient([openAIStreamTextChunks]);
    const generate = createOpenAIProviderStream({ model: 'gpt-4o', client });
    const expected = seedDescriptor('openai', 'gpt-4o');

    expectMatchesSeed(readBackendDescriptors(generate), expected);
  });

  it('reports endpointAmbiguous rows (no descriptor content leaked from a normal endpoint) for a custom baseURL', () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({
      model: 'gpt-4o',
      client,
      baseURL: 'https://proxy.internal.example/v1',
    });

    const descriptors = readBackendDescriptors(generate);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.endpointAmbiguous).toBe(true);
    expect(descriptors[0]?.availability).toBe('unknown');
  });
});
