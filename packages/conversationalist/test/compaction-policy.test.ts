import { describe, expect, test } from 'bun:test';

import { compactConversation as compactWithSummarizer } from '../src/compaction/compact';
import { partitionMessages } from '../src/compaction/preservation';
import type { Summarizer } from '../src/compaction/types';
import {
  appendAssistantMessage,
  appendMessages,
  appendUserMessage,
  createConversationHistory as createConversation,
  getMessages,
} from '../src/conversation/index';

const summarizingMock: Summarizer = async (messages) => {
  return `Summary of ${messages.length} messages`;
};
const deterministicSummarizer: Summarizer = async (messages) =>
  `[summary of ${messages.length} messages]`;

// Manual runtime standing in for the real clock (AB-321/AB-329) — this file never asserts
// anything about a specific instant, only about compaction behavior over literal messages.

describe('summarizer-based compaction', () => {
  describe('preserve policy (pinned / decision / error annotations)', () => {
    test('preserves a pinned message regardless of recency', () => {
      let c = createConversation();
      c = appendUserMessage(c, 'pinned fact: the api key rotates every 90 days', {
        pinned: true,
      });
      for (let i = 0; i < 8; i++) {
        c = appendUserMessage(c, `filler ${i}`);
      }

      const { compactable, preserved } = partitionMessages(c, { preserveRecentCount: 4 });

      expect(
        preserved.some((m) => m.content === 'pinned fact: the api key rotates every 90 days'),
      ).toBe(true);
      expect(compactable.some((m) => m.metadata['pinned'] === true)).toBe(false);
    });

    test('preserves a decision-annotated message regardless of recency', () => {
      let c = createConversation();
      c = appendAssistantMessage(c, 'Decision: we will use Postgres, not SQLite.', {
        decision: true,
      });
      for (let i = 0; i < 8; i++) {
        c = appendUserMessage(c, `filler ${i}`);
      }

      const { compactable, preserved } = partitionMessages(c, { preserveRecentCount: 4 });

      expect(preserved.some((m) => m.metadata['decision'] === true)).toBe(true);
      expect(compactable.some((m) => m.metadata['decision'] === true)).toBe(false);
    });

    test('preserves a tool-result error message regardless of recency', () => {
      let c = createConversation();
      c = appendMessages(c, {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'tc-err', name: 'tool', arguments: {} },
      });
      c = appendMessages(c, {
        role: 'tool-result',
        content: 'boom',
        toolResult: { callId: 'tc-err', outcome: 'error', content: 'boom' },
      });
      for (let i = 0; i < 8; i++) {
        c = appendUserMessage(c, `filler ${i}`);
      }

      const { compactable, preserved } = partitionMessages(c, { preserveRecentCount: 4 });

      // Both the error result and its paired tool-call must survive (tool-pair integrity).
      const preservedRoles = preserved.map((m) => m.role);
      expect(preservedRoles).toContain('tool-result');
      expect(preservedRoles).toContain('tool-call');
      expect(compactable.some((m) => m.toolResult?.outcome === 'error')).toBe(false);
    });

    test('preserves a message with metadata.error === true regardless of recency', () => {
      let c = createConversation();
      c = appendUserMessage(c, 'something went wrong upstream', { error: true });
      for (let i = 0; i < 8; i++) {
        c = appendUserMessage(c, `filler ${i}`);
      }

      const { compactable, preserved } = partitionMessages(c, { preserveRecentCount: 4 });

      expect(preserved.some((m) => m.metadata['error'] === true)).toBe(true);
      expect(compactable.some((m) => m.metadata['error'] === true)).toBe(false);
    });

    test('opts a category back into compaction when its policy flag is false', () => {
      let c = createConversation();
      c = appendUserMessage(c, 'pinned but opted out', { pinned: true });
      for (let i = 0; i < 8; i++) {
        c = appendUserMessage(c, `filler ${i}`);
      }

      const { compactable } = partitionMessages(c, {
        preserveRecentCount: 4,
        preservePolicy: { pinned: false },
      });

      expect(compactable.some((m) => m.metadata['pinned'] === true)).toBe(true);
    });

    test('a pinned fact survives N compaction cycles with a deterministic mock summarizer', async () => {
      let c = createConversation();
      c = appendUserMessage(c, 'pinned fact: retry limit is 3', { pinned: true });

      // Run several compaction cycles, adding fresh messages between each one
      // so there is always something new to compact away.
      for (let cycle = 0; cycle < 5; cycle++) {
        for (let i = 0; i < 8; i++) {
          c = appendUserMessage(c, `cycle ${cycle} message ${i}`);
        }

        const { conversation: next, result } = await compactWithSummarizer(
          c,
          deterministicSummarizer,
          { preserveRecentCount: 2 },
        );
        expect(result.compacted).toBe(true);
        c = next;

        const messages = getMessages(c);
        expect(messages.some((m) => m.content === 'pinned fact: retry limit is 3')).toBe(true);
      }

      // After 5 cycles, the pinned fact is still present verbatim, unsummarized.
      const finalMessages = getMessages(c);
      const pinnedMessage = finalMessages.find(
        (m) => m.content === 'pinned fact: retry limit is 3',
      );
      expect(pinnedMessage).toBeDefined();
      expect(pinnedMessage?.metadata['pinned']).toBe(true);
    });

    test('keeps a policy-preserved error tool-result paired with its tool-call even when preserveToolPairs is false', () => {
      // Regression: alwaysPreserved (streaming + policy-preserved messages) must expand
      // to include the matching tool-call/tool-result partner unconditionally. Gating that
      // expansion on `preserveToolPairs` (which is meant only for the recency window) let
      // an error tool-result get policy-preserved while its tool-call stayed compactable,
      // orphaning the pair once compaction removed the call.
      let c = createConversation();
      c = appendMessages(c, {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'tc-err', name: 'tool', arguments: {} },
      });
      c = appendMessages(c, {
        role: 'tool-result',
        content: 'boom',
        toolResult: { callId: 'tc-err', outcome: 'error', content: 'boom' },
      });
      for (let i = 0; i < 8; i++) {
        c = appendUserMessage(c, `filler ${i}`);
      }

      const { compactable, preserved } = partitionMessages(c, {
        preserveRecentCount: 4,
        preserveToolPairs: false,
      });

      const preservedRoles = preserved.map((m) => m.role);
      expect(preservedRoles).toContain('tool-result');
      expect(preservedRoles).toContain('tool-call');
      expect(compactable.some((m) => m.role === 'tool-call' || m.role === 'tool-result')).toBe(
        false,
      );
    });

    test('compactConversation does not throw on an error tool-result outside the recent window when preserveToolPairs is false', async () => {
      let c = createConversation();
      c = appendMessages(c, {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'tc-err-2', name: 'tool', arguments: {} },
      });
      c = appendMessages(c, {
        role: 'tool-result',
        content: 'boom',
        toolResult: { callId: 'tc-err-2', outcome: 'error', content: 'boom' },
      });
      for (let i = 0; i < 8; i++) {
        c = appendUserMessage(c, `filler ${i}`);
      }

      const { conversation: next, result } = await compactWithSummarizer(c, summarizingMock, {
        preserveRecentCount: 4,
        preserveToolPairs: false,
      });

      expect(result.compacted).toBe(true);
      const messages = getMessages(next);
      expect(messages.some((m) => m.toolResult?.callId === 'tc-err-2')).toBe(true);
      expect(messages.some((m) => m.toolCall?.id === 'tc-err-2')).toBe(true);
    });
  });
});
