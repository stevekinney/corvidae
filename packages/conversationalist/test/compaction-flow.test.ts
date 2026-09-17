import { describe, expect, test } from 'bun:test';

import { compactConversation as compactWithSummarizer } from '../src/compaction/compact';
import type { Summarizer } from '../src/compaction/types';
import {
  appendAssistantMessage,
  appendSystemMessage,
  appendUserMessage,
  createConversationHistory as createConversation,
  getMessages,
  getSystemMessages,
} from '../src/conversation/index';

const summarizingMock: Summarizer = async (messages) => {
  return `Summary of ${messages.length} messages`;
};

// Manual runtime standing in for the real clock (AB-321/AB-329) — this file never asserts
// anything about a specific instant, only about compaction behavior over literal messages.

describe('summarizer-based compaction', () => {
  describe('compactConversation (with summarizer)', () => {
    test('full flow: summarizer called, summary message created, recent preserved', async () => {
      let c = createConversation();
      for (let i = 0; i < 10; i++) {
        c = appendUserMessage(c, `Message ${i}`);
        c = appendAssistantMessage(c, `Reply ${i}`);
      }

      const { conversation: result, result: compactionResult } = await compactWithSummarizer(
        c,
        summarizingMock,
        { preserveRecentCount: 4 },
      );

      expect(compactionResult.compacted).toBe(true);
      expect(compactionResult.messagesRemoved).toBeGreaterThan(0);
      expect(compactionResult.chunksProcessed).toBeGreaterThan(0);
      expect(compactionResult.summaryContent).toContain('Summary');

      // Summary system message should be present
      const systemMsgs = getSystemMessages(result);
      expect(systemMsgs.some((m) => m.metadata['compactionSummary'] === true)).toBe(true);

      // Recent messages preserved
      const allMsgs = getMessages(result);
      expect(allMsgs.length).toBeGreaterThanOrEqual(4);
    });

    test('returns compacted false when nothing to compact', async () => {
      let c = createConversation();
      c = appendUserMessage(c, 'one');
      c = appendAssistantMessage(c, 'two');

      const { conversation: result, result: compactionResult } = await compactWithSummarizer(
        c,
        summarizingMock,
        { preserveRecentCount: 4 },
      );

      expect(compactionResult.compacted).toBe(false);
      expect(compactionResult.messagesRemoved).toBe(0);
      expect(compactionResult.chunksProcessed).toBe(0);
      expect(compactionResult.summaryContent).toBe('');
      expect(result).toBe(c);
    });

    test('handles single chunk', async () => {
      let c = createConversation();
      // 6 messages with preserveRecentCount=2 leaves 4 compactable
      // Use large baseChunkRatio to ensure single chunk
      for (let i = 0; i < 6; i++) {
        c = appendUserMessage(c, `msg ${i}`);
      }

      const { result: compactionResult } = await compactWithSummarizer(c, summarizingMock, {
        preserveRecentCount: 2,
        baseChunkRatio: 1.0,
        safetyMargin: 1.0,
      });

      expect(compactionResult.compacted).toBe(true);
      expect(compactionResult.chunksProcessed).toBe(1);
      expect(compactionResult.summaryContent).not.toContain('---');
    });

    test('handles multiple chunks', async () => {
      let c = createConversation();
      for (let i = 0; i < 20; i++) {
        c = appendUserMessage(c, `msg ${i}`);
        c = appendAssistantMessage(c, `reply ${i}`);
      }

      const { result: compactionResult } = await compactWithSummarizer(c, summarizingMock, {
        preserveRecentCount: 2,
      });

      expect(compactionResult.compacted).toBe(true);
      if (compactionResult.chunksProcessed > 1) {
        expect(compactionResult.summaryContent).toContain('---');
      }
    });

    test('preserves conversation identity and metadata', async () => {
      let c = createConversation({ title: 'Test Chat', metadata: { key: 'value' } });
      for (let i = 0; i < 8; i++) {
        c = appendUserMessage(c, `msg ${i}`);
      }

      const { conversation: result } = await compactWithSummarizer(c, summarizingMock, {
        preserveRecentCount: 2,
      });

      expect(result.id).toBe(c.id);
      expect(result.title).toBe('Test Chat');
      expect(result.status).toBe(c.status);
      expect(result.metadata).toEqual({ key: 'value' });
    });

    test('handles empty conversation', async () => {
      const c = createConversation();

      const { result: compactionResult } = await compactWithSummarizer(c, summarizingMock);

      expect(compactionResult.compacted).toBe(false);
    });

    test('preserves system messages in output', async () => {
      let c = createConversation();
      c = appendSystemMessage(c, 'You are helpful');
      for (let i = 0; i < 8; i++) {
        c = appendUserMessage(c, `msg ${i}`);
      }

      const { conversation: result } = await compactWithSummarizer(c, summarizingMock, {
        preserveRecentCount: 2,
        preserveSystemMessages: true,
      });

      const systemMsgs = getSystemMessages(result);
      // At least the original system message + summary
      expect(systemMsgs.length).toBeGreaterThanOrEqual(2);
      expect(systemMsgs.some((m) => m.content === 'You are helpful')).toBe(true);
      expect(systemMsgs.some((m) => m.metadata['compactionSummary'] === true)).toBe(true);
    });
  });
});
