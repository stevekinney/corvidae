/**
 * The built-in provider definitions: each hands its configuration to the existing factories whole,
 * so a field the shared base type does not name (an injected `client`) still reaches the factory.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import {
  anthropicProvider,
  geminiProvider,
  openaiProvider,
  type ProviderConfigurationBase,
  type ProviderDefinition,
} from '@lostgradient/operative';
import * as providerKit from '@lostgradient/operative/provider-kit';
import {
  anthropicStreamTextEvents,
  anthropicTextResponse,
} from '../src/providers/test/anthropic-fixtures.ts';
import {
  createMockAnthropicClient,
  createMockAnthropicStreamingClient,
} from '../src/providers/test/anthropic-mock-clients.ts';
import {
  geminiStreamTextChunks,
  geminiTextResponse,
} from '../src/providers/test/gemini-fixtures.ts';
import {
  createMockGeminiModel,
  createMockGeminiStreamingModel,
} from '../src/providers/test/gemini-mock-clients.ts';
import {
  openAIStreamTextChunks,
  openAITextResponse,
} from '../src/providers/test/openai-fixtures.ts';
import {
  createMockOpenAIClient,
  createMockOpenAIStreamingClient,
} from '../src/providers/test/openai-mock-clients.ts';
import type { GenerateContext, StreamingHandle } from '../src/types.ts';

function makeContext(): GenerateContext {
  return { conversation: new Conversation(), step: 0, toolbox: createToolbox([]) };
}

function makeStreamingHandle(): StreamingHandle {
  return { update: () => {}, messageId: 'test-message-id' };
}

/**
 * A mock built for one call shape, presented as a client that serves both. The definition's
 * `generate` only ever calls the non-streaming shape and its `stream` only the streaming one, so
 * each test hands the matching mock to the matching method.
 */
function asClient<Client>(mock: unknown): Client {
  return mock as Client;
}

describe('provider definitions', () => {
  it('names each definition and fits the string-keyed ProviderDefinition', () => {
    const definitions: ProviderDefinition[] = [anthropicProvider, openaiProvider, geminiProvider];

    expect(definitions.map((definition) => definition.name)).toEqual([
      'anthropic',
      'openai',
      'gemini',
    ]);
  });

  describe('anthropicProvider', () => {
    it('passes the whole configuration, including client, to the generate factory', async () => {
      const client = createMockAnthropicClient([anthropicTextResponse]);
      const generate = anthropicProvider.generate({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        maximumTokens: 77,
        client: asClient(client),
      });

      const response = await generate(makeContext());

      expect(client._calls).toHaveLength(1);
      expect(client._calls[0]?.['model']).toBe('claude-3-5-sonnet-20241022');
      expect(client._calls[0]?.['max_tokens']).toBe(77);
      expect(response.content).toBe('Hello from Anthropic!');
    });

    it('passes the whole configuration, including client, to the stream factory', async () => {
      const client = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);
      const stream = anthropicProvider.stream({
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        maximumTokens: 77,
        client: asClient(client),
      });

      await stream({ ...makeContext(), streaming: makeStreamingHandle() });

      expect(client._calls).toHaveLength(1);
      expect(client._calls[0]?.['max_tokens']).toBe(77);
    });
  });

  describe('openaiProvider', () => {
    it('passes the whole configuration, including client, to the generate factory', async () => {
      const client = createMockOpenAIClient([openAITextResponse]);
      const generate = openaiProvider.generate({
        provider: 'openai',
        model: 'gpt-4o',
        maximumTokens: 77,
        client: asClient(client),
      });

      const response = await generate(makeContext());

      expect(client._calls).toHaveLength(1);
      expect(client._calls[0]?.['model']).toBe('gpt-4o');
      expect(client._calls[0]?.['max_tokens']).toBe(77);
      expect(response.content).toBe('Hello from OpenAI!');
    });

    it('passes the whole configuration, including client, to the stream factory', async () => {
      const client = createMockOpenAIStreamingClient([openAIStreamTextChunks]);
      const stream = openaiProvider.stream({
        provider: 'openai',
        model: 'gpt-4o',
        maximumTokens: 77,
        client: asClient(client),
      });

      await stream({ ...makeContext(), streaming: makeStreamingHandle() });

      expect(client._calls).toHaveLength(1);
      expect(client._calls[0]?.['max_tokens']).toBe(77);
    });
  });

  describe('geminiProvider', () => {
    it('passes the whole configuration, including client, to the generate factory', async () => {
      const client = createMockGeminiModel([geminiTextResponse]);
      const generate = geminiProvider.generate({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        maximumTokens: 77,
        client: asClient(client),
      });

      const response = await generate(makeContext());

      expect(client._calls).toHaveLength(1);
      expect(response.content).toBe('Hello from Gemini!');
    });

    it('passes the whole configuration, including client, to the stream factory', async () => {
      const client = createMockGeminiStreamingModel([geminiStreamTextChunks]);
      const stream = geminiProvider.stream({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        maximumTokens: 77,
        client: asClient(client),
      });

      await stream({ ...makeContext(), streaming: makeStreamingHandle() });

      expect(client._calls).toHaveLength(1);
    });
  });

  it('accepts a configuration typed as the shared base', () => {
    const configuration: ProviderConfigurationBase = { provider: 'openai', model: 'gpt-4o' };

    expect(typeof openaiProvider.generate(configuration)).toBe('function');
  });
});

describe('@lostgradient/operative/provider-kit', () => {
  it('exports exactly the runtime surface a provider package builds on', () => {
    expect(Object.keys(providerKit).toSorted()).toEqual([
      'ProviderContractError',
      'ProviderError',
      'REPLAY_DATA_DROPPED_METADATA_KEY',
      'ToolCallParseError',
      'anthropicSamplingSupport',
      'assertBatchSurface',
      'buildState',
      'classifyProviderError',
      'concatenateTextParts',
      'createCacheAwareAssembly',
      'createModelCatalog',
      'defineOwn',
      'extractSamplingParameterFields',
      'findBlock',
      'isProviderContractError',
      'isStrictCompatible',
      'isToolCallParseError',
      'readBackendDescriptors',
      'readEnvironmentConfiguration',
      'resolveAnthropicEffort',
      'resolveAnthropicModel',
      'resolveCommonParameters',
      'resolveGeminiEffort',
      'resolveGeminiModel',
      'resolveOpenAIEffort',
      'resolveOpenAIModel',
      'shouldRetryProviderError',
      'withBackendDescriptors',
      'withInputLineage',
    ]);
  });
});
