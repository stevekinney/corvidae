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
import type { GenerateContext, StreamingHandle } from '@lostgradient/operative/provider-kit';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { createOpenAIProvider, createOpenAIProviderStream } from '../src/openai.ts';
import {
  createMockOpenAIClient,
  createMockOpenAIStreamingClient,
} from '../src/test/openai-mock-clients.ts';

function makeContext(): GenerateContext {
  return { conversation: new Conversation(), step: 0, toolbox: createToolbox([]) };
}

function makeStreamingHandle(): StreamingHandle {
  return { update: () => {}, messageId: 'test-message-id' };
}

describe('OpenAI provider cache token accounting', () => {
  it('reports cacheReadTokens and nets cached tokens out of prompt', async () => {
    const client = createMockOpenAIClient([
      {
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: { cached_tokens: 60 },
        },
      },
    ]);
    const generate = createOpenAIProvider({ model: 'gpt-4o', client });

    const response = await generate(makeContext());

    // prompt_tokens (100) includes the 60 cached tokens — prompt nets them out.
    expect(response.usage).toEqual({
      prompt: 40,
      completion: 5,
      total: 105,
      cacheReadTokens: 60,
    });
    expect(response.usage).not.toHaveProperty('cacheCreationTokens');
  });

  it('leaves cacheReadTokens absent (not zero) when the API omits cache details', async () => {
    const client = createMockOpenAIClient([
      {
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ]);
    const generate = createOpenAIProvider({ model: 'gpt-4o', client });

    const response = await generate(makeContext());

    expect(response.usage).toEqual({ prompt: 10, completion: 5, total: 15 });
    expect(response.usage).not.toHaveProperty('cacheReadTokens');
  });

  it('clamps prompt at 0 rather than going negative when cached_tokens exceeds prompt_tokens', async () => {
    const client = createMockOpenAIClient([
      {
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 999 },
        },
      },
    ]);
    const generate = createOpenAIProvider({ model: 'gpt-4o', client });

    const response = await generate(makeContext());

    expect(response.usage!.prompt).toBe(0);
    expect(response.usage!.cacheReadTokens).toBe(999);
  });

  it('streams cacheReadTokens from the final chunk and nets cached tokens out of prompt', async () => {
    const client = createMockOpenAIStreamingClient([
      [
        { choices: [{ delta: { content: 'hi' }, finish_reason: null }], usage: null },
        {
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 5,
            total_tokens: 105,
            prompt_tokens_details: { cached_tokens: 60 },
          },
        },
      ],
    ]);
    const generate = createOpenAIProviderStream({ model: 'gpt-4o', client });

    const response = await generate({ ...makeContext(), streaming: makeStreamingHandle() });

    expect(response.usage).toEqual({
      prompt: 40,
      completion: 5,
      total: 105,
      cacheReadTokens: 60,
    });
  });
});
