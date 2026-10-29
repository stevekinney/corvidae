/**
 * Regression tests for provider-neutral cache token accounting.
 *
 * Spec: TokenUsage carries `cacheReadTokens`/`cacheCreationTokens` populated
 * from Anthropic's `cache_read_input_tokens`/`cache_creation_input_tokens`
 * and OpenAI's `prompt_tokens_details.cached_tokens`. A response that didn't
 * report cache activity leaves both fields `undefined` — never fabricated as
 * `0`. Anthropic's `input_tokens` already excludes cache tokens; OpenAI's
 * `prompt_tokens` includes them, so `prompt` is normalized to exclude the
 * cached count for provider-neutral parity.
 */
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import {
  createAnthropicProvider,
  createAnthropicProviderStream,
} from '../../src/providers/anthropic.ts';
import {
  createMockAnthropicClient,
  createMockAnthropicStreamingClient,
} from '../../src/providers/test/anthropic-mock-clients.ts';
import type { GenerateContext, StreamingHandle } from '../../src/types.ts';

function makeContext(): GenerateContext {
  return { conversation: new Conversation(), step: 0, toolbox: createToolbox([]) };
}

function makeStreamingHandle(): StreamingHandle {
  return { update: () => {}, messageId: 'test-message-id' };
}

describe('Anthropic provider cache token accounting', () => {
  it('reports cacheCreationTokens and cacheReadTokens when the API returns them', async () => {
    const client = createMockAnthropicClient([
      {
        content: [{ type: 'text', text: 'hi' }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 200,
        },
      },
    ]);
    const generate = createAnthropicProvider({ model: 'claude-3-5-sonnet-20241022', client });

    const response = await generate(makeContext());

    // `input_tokens` already excludes cache activity — `prompt` is NOT inflated by it.
    expect(response.usage).toEqual({
      prompt: 10,
      completion: 5,
      total: 15,
      cacheCreationTokens: 100,
      cacheReadTokens: 200,
    });
  });

  it('leaves cache fields absent (not zero) when the API omits them', async () => {
    const client = createMockAnthropicClient([
      { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const generate = createAnthropicProvider({ model: 'claude-3-5-sonnet-20241022', client });

    const response = await generate(makeContext());

    expect(response.usage).toEqual({ prompt: 10, completion: 5, total: 15 });
    expect(response.usage).not.toHaveProperty('cacheCreationTokens');
    expect(response.usage).not.toHaveProperty('cacheReadTokens');
  });

  it('streams cacheCreationTokens/cacheReadTokens from the message_start usage', async () => {
    const client = createMockAnthropicStreamingClient([
      [
        {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 50,
              cache_read_input_tokens: 75,
            },
          },
        },
        { type: 'message_delta', usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ],
    ]);
    const generate = createAnthropicProviderStream({ model: 'claude-3-5-sonnet-20241022', client });

    const response = await generate({ ...makeContext(), streaming: makeStreamingHandle() });

    expect(response.usage).toEqual({
      prompt: 10,
      completion: 5,
      total: 15,
      cacheCreationTokens: 50,
      cacheReadTokens: 75,
    });
  });
});
