import { describe, expect, test } from 'bun:test';

import { compactConversation as compactWithSummarizer } from '../src/compaction/compact';
import { partitionMessages } from '../src/compaction/preservation';
import type { Summarizer } from '../src/compaction/types';
import {
  appendAssistantMessage,
  appendUserMessage,
  createConversationHistory as createConversation,
  getMessages,
} from '../src/conversation/index';
import { appendStreamingMessage, isStreamingMessage } from '../src/streaming';

const summarizingMock: Summarizer = async (messages) => {
  return `Summary of ${messages.length} messages`;
};

// Manual runtime standing in for the real clock (AB-321/AB-329) — this file never asserts
// anything about a specific instant, only about compaction behavior over literal messages.

describe('summarizer-based compaction', () => {
  describe('streaming message protection', () => {
    test('partitionMessages preserves streaming messages', () => {
      let conversation = createConversation();
      for (let i = 0; i < 8; i++) {
        conversation = appendUserMessage(conversation, `user ${i}`);
      }
      const { conversation: withStreaming } = appendStreamingMessage(conversation, 'assistant');

      const { compactable, preserved } = partitionMessages(withStreaming, {
        preserveRecentCount: 2,
      });

      // The streaming message should be preserved, not compactable
      expect(preserved.some((m) => isStreamingMessage(m))).toBe(true);
      expect(compactable.every((m) => !isStreamingMessage(m))).toBe(true);
    });

    test('compactConversation preserves streaming messages in full flow', async () => {
      let conversation = createConversation();
      for (let i = 0; i < 10; i++) {
        conversation = appendUserMessage(conversation, `Message ${i}`);
        conversation = appendAssistantMessage(conversation, `Reply ${i}`);
      }
      const { conversation: withStreaming } = appendStreamingMessage(conversation, 'assistant');

      const { conversation: result, result: compactionResult } = await compactWithSummarizer(
        withStreaming,
        summarizingMock,
        {
          preserveRecentCount: 2,
        },
      );

      expect(compactionResult.compacted).toBe(true);

      // The streaming message should survive compaction
      const allMessages = getMessages(result);
      expect(allMessages.some((m) => isStreamingMessage(m))).toBe(true);
    });
  });
});
