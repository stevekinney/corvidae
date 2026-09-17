import { describe, expect, it } from 'bun:test';
import { fromAnthropicMessages } from '../src/adapters/anthropic/inbound';
import { toAnthropicMessages } from '../src/adapters/anthropic/outbound';
import type { AnthropicConversation } from '../src/adapters/anthropic/types';
import { requireRecord, requireRecordArray } from './adapter-test-fixtures';

describe('C5 — Server-tool content blocks (Anthropic adapter)', () => {
  it('round-trips server_tool_use and web_search_tool_result interleaved with text', () => {
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Search for recent news about AI' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me search for that.' },
            {
              type: 'server_tool_use',
              id: 'stu_123',
              name: 'web_search',
              input: { query: 'recent AI news' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'web_search_tool_result',
              tool_use_id: 'stu_123',
              content: [
                { type: 'web_search_result', url: 'https://example.com', title: 'AI News' },
              ],
            },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Here is a summary of recent AI news.' }],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    // Should have user → assistant (server_tool_use) → user (web_search_result) → assistant
    expect(roundTripped.messages).toHaveLength(4);

    // Find assistant message with server_tool_use
    const assistantWithServerTool = roundTripped.messages.find(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        requireRecordArray(m.content).some((b) => b.type === 'server_tool_use'),
    );
    expect(assistantWithServerTool).toBeDefined();

    const serverToolBlock = requireRecordArray(assistantWithServerTool?.content).find(
      (b) => b.type === 'server_tool_use',
    );
    expect(serverToolBlock).toBeDefined();
    expect(serverToolBlock?.id).toBe('stu_123');
    expect(serverToolBlock?.name).toBe('web_search');
    expect(serverToolBlock?.input).toEqual({ query: 'recent AI news' });

    // Find user message with web_search_tool_result
    const userWithSearchResult = roundTripped.messages.find(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        requireRecordArray(m.content).some((b) => b.type === 'web_search_tool_result'),
    );
    expect(userWithSearchResult).toBeDefined();

    const searchResultBlock = requireRecordArray(userWithSearchResult?.content).find(
      (b) => b.type === 'web_search_tool_result',
    );
    expect(searchResultBlock).toBeDefined();
    expect(searchResultBlock?.tool_use_id).toBe('stu_123');
  });

  it('round-trips [text, server_tool_use, text] as ONE assistant message with blocks in their original order', () => {
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Do a search' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Searching now.' },
            { type: 'server_tool_use', id: 'stu_a', name: 'web_search', input: { q: 'test' } },
            { type: 'text', text: 'Done searching.' },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    // Groupable blocks of one Anthropic turn must round-trip as a single
    // assistant message, not be fragmented across multiple messages.
    const assistantMessages = roundTripped.messages.filter((m) => m.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);

    const blocks = assistantMessages[0]?.content;
    expect(Array.isArray(blocks)).toBe(true);

    // Block TYPES must appear in exactly the original order.
    const typedBlocks = requireRecordArray(blocks);
    expect(typedBlocks.map((b) => b.type)).toEqual(['text', 'server_tool_use', 'text']);

    // And the actual values must be preserved, not just the shape.
    const first = requireRecord(typedBlocks[0]);
    const middle = requireRecord(typedBlocks[1]);
    const last = requireRecord(typedBlocks[2]);
    expect(first.text).toBe('Searching now.');
    expect(middle.id).toBe('stu_a');
    expect(middle.name).toBe('web_search');
    expect(last.text).toBe('Done searching.');
  });

  it('round-trips [thinking, server_tool_use, text] as one ordered assistant message (extended thinking + web search)', () => {
    // A realistic Anthropic pattern: the model thinks, invokes a server tool,
    // then answers. All three blocks are groupable, so they must stay together
    // in one ordered message with the thinking signature intact.
    const SIG = 'EqoBthinkSig==';
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Find todays news' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I should search the web.', signature: SIG },
            { type: 'server_tool_use', id: 'stu_z', name: 'web_search', input: { q: 'news' } },
            { type: 'text', text: 'Let me look.' },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    const assistantMessages = roundTripped.messages.filter((m) => m.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);

    const blocks = requireRecordArray(assistantMessages[0]?.content);
    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'server_tool_use', 'text']);

    const thinking = requireRecord(blocks[0]);
    expect(thinking.thinking).toBe('I should search the web.');
    // Signature survives the round-trip byte-for-byte even when not followed
    // immediately by a text block.
    expect(thinking.signature).toBe(SIG);
  });

  it('keeps a client tool_use interleaved between text blocks in true order across the round-trip', () => {
    // tool_use is role-bearing on import (a tool-call message), but every piece
    // of this turn is assistant-role on export, so toAnthropicMessages merges
    // the consecutive assistant messages back into one ordered block array.
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Look it up' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Before.' },
            { type: 'tool_use', id: 'call-mid', name: 'lookup', input: { k: 'v' } },
            { type: 'text', text: 'After.' },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    const assistantMessages = roundTripped.messages.filter((m) => m.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);

    const blocks = requireRecordArray(assistantMessages[0]?.content);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'tool_use', 'text']);

    const first = requireRecord(blocks[0]);
    const mid = requireRecord(blocks[1]);
    const last = requireRecord(blocks[2]);
    expect(first.text).toBe('Before.');
    expect(mid.id).toBe('call-mid');
    expect(mid.name).toBe('lookup');
    expect(mid.input).toEqual({ k: 'v' });
    expect(last.text).toBe('After.');
  });

  it('round-trips a code-execution server-tool result block instead of dropping it', () => {
    // bash_code_execution_tool_result is an Anthropic code-execution result; it
    // must survive import → export with its stdout/exit details intact.
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Run ls' },
        {
          role: 'assistant',
          content: [
            { type: 'server_tool_use', id: 'stu-x', name: 'bash', input: { command: 'ls' } },
            {
              type: 'bash_code_execution_tool_result',
              tool_use_id: 'stu-x',
              content: { stdout: 'file.txt\n', exit_code: 0 },
            },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    const assistant = roundTripped.messages.find((m) => m.role === 'assistant');
    // `AnthropicContentBlock`'s discriminated members have no index signature, so a
    // direct cast to this loose introspection shape is rejected as a probable
    // mistake; bridging through `unknown` is the deliberate, documented escape for
    // reading arbitrary block properties generically across many block types.
    const blocks = requireRecordArray(assistant?.content);
    expect(blocks.map((b) => b.type)).toEqual([
      'server_tool_use',
      'bash_code_execution_tool_result',
    ]);
    const resultBlock = blocks.find((b) => b.type === 'bash_code_execution_tool_result');
    expect(resultBlock?.['tool_use_id']).toBe('stu-x');
    expect(resultBlock?.['content']).toEqual({ stdout: 'file.txt\n', exit_code: 0 });
  });

  it('round-trips a container_upload block (uploaded-file reference) instead of dropping it', () => {
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Use this file' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Got it.' },
            { type: 'container_upload', file_id: 'file_abc123' },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    const assistant = roundTripped.messages.find((m) => m.role === 'assistant');
    // `AnthropicContentBlock`'s discriminated members have no index signature, so a
    // direct cast to this loose introspection shape is rejected as a probable
    // mistake; bridging through `unknown` is the deliberate, documented escape for
    // reading arbitrary block properties generically across many block types.
    const blocks = requireRecordArray(assistant?.content);
    const upload = blocks.find((b) => b.type === 'container_upload');
    expect(upload).toBeDefined();
    expect(upload?.['file_id']).toBe('file_abc123');
  });

  it('round-trips a web_fetch_tool_result block instead of dropping it', () => {
    const payload: AnthropicConversation = {
      messages: [
        { role: 'user', content: 'Fetch it' },
        {
          role: 'assistant',
          content: [
            {
              type: 'server_tool_use',
              id: 'wf',
              name: 'web_fetch',
              input: { url: 'https://x.com' },
            },
            {
              type: 'web_fetch_tool_result',
              tool_use_id: 'wf',
              content: { url: 'https://x.com', text: 'fetched body' },
            },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);
    const roundTripped = toAnthropicMessages(conversation);

    const assistant = roundTripped.messages.find((m) => m.role === 'assistant');
    // `AnthropicContentBlock`'s discriminated members have no index signature, so a
    // direct cast to this loose introspection shape is rejected as a probable
    // mistake; bridging through `unknown` is the deliberate, documented escape for
    // reading arbitrary block properties generically across many block types.
    const blocks = requireRecordArray(assistant?.content);
    const fetchBlock = blocks.find((b) => b.type === 'web_fetch_tool_result');
    expect(fetchBlock).toBeDefined();
    expect(fetchBlock?.['content']).toEqual({ url: 'https://x.com', text: 'fetched body' });
  });
});
