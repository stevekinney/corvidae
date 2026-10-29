/**
 * Backend-descriptor attachment on the provider factories (AB-64 AC2,
 * AB-245). Each `create*Provider`/`create*ProviderStream` attaches the
 * single `BackendDescriptor` matching its resolved, post-alias model at
 * construction time. No network call and no credential — the local mocked
 * clients `packages/operative/test/<provider>/*.test.ts` already use.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import {
  createAnthropicProvider,
  createAnthropicProviderStream,
} from '../../src/providers/anthropic.ts';
import { readBackendDescriptors } from '../../src/providers/backend-descriptor-attachment.ts';
import type { BackendDescriptor } from '../../src/providers/model-catalog.ts';
import { createModelCatalog } from '../../src/providers/model-catalog.ts';
import {
  anthropicStreamTextEvents,
  anthropicTextResponse,
} from '../../src/providers/test/anthropic-fixtures.ts';
import {
  createMockAnthropicClient,
  createMockAnthropicStreamingClient,
} from '../../src/providers/test/anthropic-mock-clients.ts';
import type { GenerateContext } from '../../src/types.ts';

function makeContext(): GenerateContext {
  return { conversation: new Conversation(), step: 0, toolbox: createToolbox([]) };
}

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

describe('createAnthropicProvider / createAnthropicProviderStream — backend descriptor', () => {
  it('attaches the same descriptor on the streaming variant', () => {
    const client = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);
    const generate = createAnthropicProviderStream({ model: 'claude-sonnet-5', client });
    const expected = seedDescriptor('anthropic', 'claude-sonnet-5');

    expectMatchesSeed(readBackendDescriptors(generate), expected);
  });

  it('the attached descriptor is still usable to run a request through the mock client', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({ model: 'claude-sonnet-5', client });

    const response = await generate(makeContext());
    expect(response.content).toBe('Hello from Anthropic!');
  });
});
