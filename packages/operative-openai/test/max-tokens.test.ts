/**
 * Regression tests for per-request maximumTokens override in providers.
 *
 * Spec: context.maximumTokens takes precedence over the construction-time
 * maximumTokens option when building the provider request params.
 */
import { type AnyToolbox, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { createOpenAIProvider } from '../src/openai.ts';
import { openAITextResponse } from '../src/test/openai-fixtures.ts';
import { createMockOpenAIClient } from '../src/test/openai-mock-clients.ts';

function makeContext(maximumTokens?: number, toolbox: AnyToolbox = createToolbox([])) {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox,
    maximumTokens,
  };
}

describe('OpenAI provider — per-request maximumTokens override', () => {
  it('uses the construction-time maximumTokens when context does not specify one', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({
      model: 'gpt-4o',
      maximumTokens: 2048,
      client,
    });

    await generate(makeContext());

    const call = client._calls[0];
    expect(call).toBeDefined();
    expect(call?.['max_tokens']).toBe(2048);
  });

  it('overrides construction-time maximumTokens when context.maximumTokens is set', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({
      model: 'gpt-4o',
      maximumTokens: 2048,
      client,
    });

    await generate(makeContext(256));

    const call = client._calls[0];
    expect(call).toBeDefined();
    expect(call?.['max_tokens']).toBe(256);
  });

  it('omits max_tokens entirely when neither construction-time nor context value is set', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({
      model: 'gpt-4o',
      client,
    });

    await generate(makeContext());

    const call = client._calls[0];
    expect(call).toBeDefined();
    expect(call?.['max_tokens']).toBeUndefined();
  });
});
