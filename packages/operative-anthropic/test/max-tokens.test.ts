/**
 * Regression tests for per-request maximumTokens override in providers.
 *
 * Spec: context.maximumTokens takes precedence over the construction-time
 * maximumTokens option when building the provider request params.
 */
import { type AnyToolbox, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createAnthropicProvider } from '../src/anthropic.ts';
import { anthropicTextResponse } from '../src/test/anthropic-fixtures.ts';
import { createMockAnthropicClient } from '../src/test/anthropic-mock-clients.ts';

function makeContext(maximumTokens?: number, toolbox: AnyToolbox = createToolbox([])) {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox,
    maximumTokens,
  };
}

describe('Anthropic provider — per-request maximumTokens override', () => {
  it('uses the construction-time maximumTokens when context does not specify one', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      maximumTokens: 1024,
      client,
    });

    await generate(makeContext());

    const call = client._calls[0];
    expect(call).toBeDefined();
    expect(call?.['max_tokens']).toBe(1024);
  });

  it('overrides construction-time maximumTokens when context.maximumTokens is set', async () => {
    const client = createMockAnthropicClient([anthropicTextResponse]);
    const generate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      maximumTokens: 1024,
      client,
    });

    await generate(makeContext(512));

    const call = client._calls[0];
    expect(call).toBeDefined();
    expect(call?.['max_tokens']).toBe(512);
  });
});
