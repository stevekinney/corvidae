import { createManualRuntimeServices } from '@repo/lifecycle';
import { describe, expect, test } from 'bun:test';

import { stripToolResultDetails as stripToolResultDetailsBatch } from '../src/compaction/stripping';
import type { Message } from '../src/types';

// Manual runtime standing in for the real clock (AB-321/AB-329) — this file never asserts
// anything about a specific instant, only about compaction behavior over literal messages.
const runtime = createManualRuntimeServices();

describe('summarizer-based compaction', () => {
  describe('stripToolResultDetails (batch)', () => {
    test('replaces content of tool-result messages', () => {
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
          role: 'tool-result',
          content: 'original data',
          position: 1,
          createdAt: runtime.clock.nowISO(),
          metadata: {},
          hidden: false,
          toolResult: { callId: 'tc-1', outcome: 'success', content: { key: 'value' } },
        },
      ];

      const stripped = stripToolResultDetailsBatch(messages);

      expect(stripped[0]!.content).toBe('hi');
      expect(stripped[1]!.content).toBe('[tool result]');
      expect(stripped[1]!.toolResult?.content).toBe('[tool result]');
      expect(stripped[1]!.toolResult?.callId).toBe('tc-1');
    });

    test('leaves non-tool-result messages untouched', () => {
      const messages: Message[] = [
        {
          id: 'm-0',
          role: 'assistant',
          content: 'response',
          position: 0,
          createdAt: runtime.clock.nowISO(),
          metadata: {},
          hidden: false,
        },
      ];

      const stripped = stripToolResultDetailsBatch(messages);
      expect(stripped[0]).toBe(messages[0]);
    });

    test('strips structural tool-result block content inside assistant content', () => {
      const messages: Message[] = [
        {
          id: 'm-0',
          role: 'assistant',
          content: [
            { type: 'text', text: 'See results.' },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'stu-1',
              content: [{ snippet: 'a very long search snippet to be stripped' }],
            },
          ],
          position: 0,
          createdAt: runtime.clock.nowISO(),
          metadata: {},
          hidden: false,
        },
      ];

      const stripped = stripToolResultDetailsBatch(messages);
      const parts = stripped[0]!.content;
      if (!Array.isArray(parts)) throw new Error('expected multimodal content');
      // Text is preserved; the structural result content is replaced.
      expect(parts[0]).toEqual({ type: 'text', text: 'See results.' });
      expect(parts[1]?.type).toBe('web_search_tool_result');
      if (parts[1]?.type === 'web_search_tool_result') {
        expect(parts[1].content).toBe('[tool result]');
      }
    });

    test('strips server tool use input while preserving unrelated structural blocks', () => {
      const messages: Message[] = [
        {
          id: 'm-0',
          role: 'assistant',
          content: [
            {
              type: 'server_tool_use',
              id: 'server-tool-1',
              name: 'web_search',
              input: { query: 'long private query' },
            },
            { type: 'container_upload', file_id: 'file-1' },
          ],
          position: 0,
          createdAt: runtime.clock.nowISO(),
          metadata: {},
          hidden: false,
        },
      ];

      const stripped = stripToolResultDetailsBatch(messages);
      const parts = stripped[0]!.content;
      if (!Array.isArray(parts)) throw new Error('expected multimodal content');

      expect(parts[0]?.type).toBe('server_tool_use');
      if (parts[0]?.type === 'server_tool_use') {
        expect(parts[0].input).toBe('[tool result]');
      }
      expect(parts[1]).toEqual({ type: 'container_upload', file_id: 'file-1' });
    });

    test('strips citation payloads on cited text parts', () => {
      const messages: Message[] = [
        {
          id: 'm-0',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'The answer is 4.',
              citations: [{ cited_text: 'long cited evidence to strip', url: 'https://e.com' }],
            },
          ],
          position: 0,
          createdAt: runtime.clock.nowISO(),
          metadata: {},
          hidden: false,
        },
      ];

      const stripped = stripToolResultDetailsBatch(messages);
      const parts = stripped[0]!.content;
      if (!Array.isArray(parts)) throw new Error('expected multimodal content');
      const part = parts[0];
      // Visible text is preserved; the citation FIELD is removed entirely (it must
      // be structured, so scalarizing it would produce a malformed block).
      expect(part?.type).toBe('text');
      if (part?.type === 'text') {
        expect(part.text).toBe('The answer is 4.');
        expect('citations' in part).toBe(false);
      }
    });

    test('replaces document payloads with text references before summarization', () => {
      const messages: Message[] = [
        {
          id: 'm-0',
          role: 'user',
          content: [
            {
              type: 'document',
              name: 'requirements.pdf',
              mimeType: 'application/pdf',
              source: { kind: 'base64', data: 'A'.repeat(10_000) },
            },
            {
              type: 'document',
              name: 'workspace-notes.md',
              mimeType: 'text/markdown',
              source: { kind: 'reference', uri: 'sandbox:/workspace/notes.md' },
            },
          ],
          position: 0,
          createdAt: runtime.clock.nowISO(),
          metadata: {},
          hidden: false,
        },
      ];

      const stripped = stripToolResultDetailsBatch(messages);
      expect(stripped[0]!.content).toEqual([
        {
          type: 'text',
          text: '[Document: requirements.pdf (application/pdf); base64 data omitted]',
        },
        {
          type: 'text',
          text: '[Document: workspace-notes.md (text/markdown) at sandbox:/workspace/notes.md]',
        },
      ]);
    });

    test('drops thinking and redacted_thinking blocks (mutating them would be invalid for re-serialization)', () => {
      const messages: Message[] = [
        {
          id: 'm-0',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'a long private chain of reasoning', signature: 'sig==' },
            { type: 'redacted_thinking', data: 'encrypted-reasoning-payload' },
            { type: 'text', text: 'Final answer.' },
          ],
          position: 0,
          createdAt: runtime.clock.nowISO(),
          metadata: {},
          hidden: false,
        },
      ];

      const stripped = stripToolResultDetailsBatch(messages);
      const parts = stripped[0]!.content;
      if (!Array.isArray(parts)) throw new Error('expected multimodal content');
      // The thinking blocks are removed entirely; only the answer text remains.
      expect(parts).toHaveLength(1);
      expect(parts[0]).toEqual({ type: 'text', text: 'Final answer.' });
    });
  });
});
