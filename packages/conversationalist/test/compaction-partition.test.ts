import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { describe, expect, test } from 'bun:test';

import { chunkMessages } from '../src/compaction/chunking';
import { partitionMessages } from '../src/compaction/preservation';
import {
  appendAssistantMessage,
  appendMessages,
  appendSystemMessage,
  appendUserMessage,
  createConversationHistory as createConversation,
} from '../src/conversation/index';
import type { Message } from '../src/types';

const fixedEstimator = () => 10;

// Manual runtime standing in for the real clock (AB-321/AB-329) — this file never asserts
// anything about a specific instant, only about compaction behavior over literal messages.
const runtime = createManualRuntimeServices();

describe('summarizer-based compaction', () => {
  describe('partitionMessages', () => {
    test('separates system, recent, and compactable messages', () => {
      let c = createConversation();
      c = appendSystemMessage(c, 'system prompt');
      for (let i = 0; i < 8; i++) {
        c = appendUserMessage(c, `user ${i}`);
      }

      const { compactable, preserved } = partitionMessages(c, { preserveRecentCount: 4 });

      // System message + 4 recent = 5 preserved
      expect(preserved.length).toBe(5);
      expect(compactable.length).toBe(4);
      expect(preserved.some((m) => m.role === 'system')).toBe(true);
    });

    test('preserves tool pairs as atomic units', () => {
      let c = createConversation();
      for (let i = 0; i < 6; i++) {
        c = appendUserMessage(c, `msg ${i}`);
      }
      c = appendMessages(c, {
        role: 'tool-call',
        content: '',
        toolCall: { id: 'tc-1', name: 'tool', arguments: {} },
      });
      c = appendMessages(c, {
        role: 'tool-result',
        content: 'result',
        toolResult: { callId: 'tc-1', outcome: 'success', content: 'data' },
      });
      c = appendUserMessage(c, 'after tool');
      c = appendAssistantMessage(c, 'reply');

      // preserveRecentCount=3 would capture [tool-result, user, assistant]
      // but tool-result should pull in its tool-call
      const { preserved } = partitionMessages(c, {
        preserveRecentCount: 3,
        preserveToolPairs: true,
      });

      const preservedRoles = preserved.map((m) => m.role);
      // If tool-result is in preserved, tool-call must also be
      if (preservedRoles.includes('tool-result')) {
        expect(preservedRoles).toContain('tool-call');
      }
    });

    test('preserves a tool result paired with a policy-selected tool call', () => {
      let c = createConversation();
      c = appendMessages(
        c,
        {
          role: 'tool-call',
          content: '',
          metadata: { pinned: true },
          toolCall: { id: 'tc-policy-selected', name: 'tool', arguments: {} },
        },
        {
          role: 'tool-result',
          content: 'result',
          toolResult: { callId: 'tc-policy-selected', outcome: 'success', content: 'data' },
        },
      );

      const { preserved } = partitionMessages(c, {
        preserveRecentCount: 0,
        preserveToolPairs: true,
      });

      expect(preserved.map((message) => message.role)).toEqual(['tool-call', 'tool-result']);
    });

    test('compacts unprotected messages when the recent window is zero', () => {
      let c = createConversation();
      c = appendMessages(
        c,
        {
          role: 'tool-call',
          content: '',
          metadata: { pinned: true },
          toolCall: { id: 'tc-zero-window', name: 'tool', arguments: {} },
        },
        {
          role: 'tool-result',
          content: 'protected result',
          toolResult: { callId: 'tc-zero-window', outcome: 'success', content: 'data' },
        },
      );
      c = appendUserMessage(c, 'unprotected message');

      const { compactable, preserved } = partitionMessages(c, { preserveRecentCount: 0 });

      expect(compactable.map((message) => message.content)).toEqual(['unprotected message']);
      expect(preserved.map((message) => message.role)).toEqual(['tool-call', 'tool-result']);
    });

    test('returns all messages as preserved when fewer than preserveRecentCount', () => {
      let c = createConversation();
      c = appendUserMessage(c, 'only one');

      const { compactable, preserved } = partitionMessages(c, { preserveRecentCount: 4 });

      expect(compactable).toHaveLength(0);
      expect(preserved).toHaveLength(1);
    });

    test('handles all system messages conversation', () => {
      let c = createConversation();
      c = appendSystemMessage(c, 'sys 1');
      c = appendSystemMessage(c, 'sys 2');
      c = appendSystemMessage(c, 'sys 3');

      const { compactable, preserved } = partitionMessages(c, {
        preserveSystemMessages: true,
        preserveRecentCount: 4,
      });

      // No non-system messages, so nothing to compact
      expect(compactable).toHaveLength(0);
      expect(preserved).toHaveLength(3);
    });

    test('handles empty conversation', () => {
      const c = createConversation();
      const { compactable, preserved } = partitionMessages(c);
      expect(compactable).toHaveLength(0);
      expect(preserved).toHaveLength(0);
    });
  });

  describe('chunkMessages', () => {
    test('groups messages within budget', () => {
      const messages: Message[] = Array.from({ length: 6 }, (_, i) => ({
        id: `m-${i}`,
        role: 'user' as const,
        content: `msg ${i}`,
        position: i,
        createdAt: runtime.clock.nowISO(),
        metadata: {},
        hidden: false,
      }));

      // Each message is 10 tokens, budget is 25 -> chunks of 2-3
      const chunks = chunkMessages(messages, 25, fixedEstimator);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeGreaterThan(0);
      }
    });

    test('does not split tool pairs', () => {
      const messages: Message[] = [
        {
          id: 'm-0',
          role: 'user',
          content: 'hi',
          position: 0,
          createdAt: runtime.clock.nowISO(),
          metadata: {},
          hidden: false,
        },
        {
          id: 'm-1',
          role: 'tool-call',
          content: '',
          position: 1,
          createdAt: runtime.clock.nowISO(),
          metadata: {},
          hidden: false,
          toolCall: { id: 'tc-1', name: 'tool', arguments: {} },
        },
        {
          id: 'm-2',
          role: 'tool-result',
          content: 'result',
          position: 2,
          createdAt: runtime.clock.nowISO(),
          metadata: {},
          hidden: false,
          toolResult: { callId: 'tc-1', outcome: 'success', content: 'data' },
        },
        {
          id: 'm-3',
          role: 'user',
          content: 'follow up',
          position: 3,
          createdAt: runtime.clock.nowISO(),
          metadata: {},
          hidden: false,
        },
      ];

      // Budget allows 15 tokens (1.5 messages), so tool pair (20 tokens) must stay together
      const chunks = chunkMessages(messages, 15, fixedEstimator);

      // Find the chunk containing the tool-call
      for (const chunk of chunks) {
        const hasCall = chunk.some((m) => m.role === 'tool-call');
        const hasResult = chunk.some((m) => m.role === 'tool-result');
        if (hasCall) {
          expect(hasResult).toBe(true);
        }
      }
    });

    test('handles oversized single messages', () => {
      const messages: Message[] = [
        {
          id: 'm-0',
          role: 'user',
          content: 'big message',
          position: 0,
          createdAt: runtime.clock.nowISO(),
          metadata: {},
          hidden: false,
        },
      ];

      // Budget is 1, but message is 10 tokens
      const chunks = chunkMessages(messages, 1, fixedEstimator);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toHaveLength(1);
    });

    test('returns empty array for empty messages', () => {
      const chunks = chunkMessages([], 100, fixedEstimator);
      expect(chunks).toHaveLength(0);
    });
  });
});
