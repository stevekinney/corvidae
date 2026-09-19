import { createToolbox } from '@corvidae/armorer';
import { Conversation } from '@corvidae/conversationalist';
import { createAnthropicProvider } from '../../src/providers/anthropic.ts';
import type { AnthropicClient } from '../../src/providers/types.ts';

export async function runInjectedClient(): Promise<string> {
  const client: AnthropicClient = {
    messages: {
      async create() {
        return { content: [{ type: 'text', text: 'browser-ok' }] };
      },
    },
  };
  const response = await createAnthropicProvider({ model: 'claude-sonnet-5', client })({
    conversation: new Conversation(),
    step: 0,
    maximumTokens: 32,
    signal: new AbortController().signal,
    toolbox: createToolbox([]),
  });
  return response.content;
}

export async function runMissingClient(): Promise<string> {
  try {
    await createAnthropicProvider({ model: 'claude-sonnet-5' })({
      conversation: new Conversation(),
      step: 0,
      maximumTokens: 32,
      signal: new AbortController().signal,
      toolbox: createToolbox([]),
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'missing-error';
}
