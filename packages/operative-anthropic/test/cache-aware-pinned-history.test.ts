import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createContextAssembler, createTokenBudget } from '@lostgradient/operative';
import { createAnthropicProvider } from '../src/anthropic.ts';
import { createMockAnthropicClient } from '../src/test/anthropic-mock-clients.ts';

function textResponse(text = 'ok') {
  return {
    content: [{ type: 'text' as const, text }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/**
 * COR-716 — the cache-aware assembly keeps message ids, so a pinned message that
 * also sits in the history must be counted as included once, not assembled twice.
 */
describe('cache-aware assembly with a pinned message from the conversation', () => {
  it('still builds a request when a pinned message is also in the history', async () => {
    const conversation = new Conversation();
    conversation.appendSystemMessage('rules');
    conversation.appendUserMessage('pinned reference');
    conversation.appendAssistantMessage('noted');
    conversation.appendUserMessage('question');
    const pinned = conversation.getMessages()[1]!;
    const client = createMockAnthropicClient([textResponse(), textResponse()]);
    const generate = createAnthropicProvider({
      model: 'claude-sonnet-5-5',
      client,
      assembler: createContextAssembler(),
      contextBudget: createTokenBudget({ maxTokens: 100_000 }),
      pinnedMessages: [pinned],
    });
    let thrown: unknown;
    try {
      await generate({ conversation, step: 0, toolbox: createToolbox([]) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeUndefined();
    const sent = JSON.stringify(client._calls[0]?.['messages']);
    expect(sent).toContain('pinned reference');
    expect(sent.split('pinned reference')).toHaveLength(2);
  });
});
