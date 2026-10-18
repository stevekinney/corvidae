import { describe, expect, it } from 'bun:test';
import { toAnthropicMessages } from '../src/adapters/anthropic/outbound';
import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import { toOpenAIMessages, toOpenAIMessagesGrouped } from '../src/adapters/openai/outbound';
import { ConversationalistError } from '../src/errors';
import { createBrokenToolConversation } from './adapter-test-fixtures';

function assertIntegrityError(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof ConversationalistError))
      throw new Error('expected integrity error', { cause: error });
    expect(error).toBeInstanceOf(ConversationalistError);
    expect(error.code).toBe('error:integrity');
    return;
  }
  throw new Error('expected integrity error');
}

describe('Adapter integrity enforcement', () => {
  it('rejects broken tool linkage across adapters', () => {
    const conv = createBrokenToolConversation();
    assertIntegrityError(() => toOpenAIMessages(conv).messages);
    assertIntegrityError(() => toOpenAIMessagesGrouped(conv).messages);
    assertIntegrityError(() => toAnthropicMessages(conv));
    assertIntegrityError(() => toGeminiMessages(conv));
  });
});
