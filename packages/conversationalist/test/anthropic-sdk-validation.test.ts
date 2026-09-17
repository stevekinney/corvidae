import type { TextCitationParam } from '@anthropic-ai/sdk/resources';
import { describe, expect, it } from 'bun:test';

import { fromAnthropicMessages } from '../src/adapters/anthropic/inbound';
import { toAnthropicMessagesForSdk } from '../src/adapters/anthropic/sdk';
import type { AnthropicContentBlock } from '../src/adapters/anthropic/types';
import { appendMessages, createConversationHistory } from '../src/conversation';

function conversationFromBlock(block: AnthropicContentBlock) {
  return fromAnthropicMessages({
    messages: [{ role: 'user', content: [block] }],
  });
}

describe('Anthropic SDK validation', () => {
  it('converts every supported citation location', () => {
    const citations: TextCitationParam[] = [
      {
        type: 'char_location',
        cited_text: 'Characters',
        document_index: 0,
        document_title: 'Reference',
        end_char_index: 10,
        start_char_index: 0,
      },
      {
        type: 'page_location',
        cited_text: 'Pages',
        document_index: 1,
        document_title: null,
        end_page_number: 2,
        start_page_number: 1,
      },
      {
        type: 'content_block_location',
        cited_text: 'Blocks',
        document_index: 2,
        document_title: 'Blocks reference',
        end_block_index: 2,
        start_block_index: 1,
      },
      {
        type: 'web_search_result_location',
        cited_text: 'Web result',
        encrypted_index: 'encrypted-index',
        title: null,
        url: 'https://example.com/web-result',
      },
      {
        type: 'search_result_location',
        cited_text: 'Search result',
        end_block_index: 4,
        search_result_index: 3,
        source: 'source-id',
        start_block_index: 2,
        title: 'Search title',
      },
    ];
    const conversation = conversationFromBlock({ type: 'text', text: 'Cited', citations });

    const sdk = toAnthropicMessagesForSdk(conversation);

    expect(sdk.messages[0]?.content).toEqual([{ type: 'text', text: 'Cited', citations }]);
  });

  it('rejects malformed citation payloads at the SDK boundary', () => {
    const invalidCitations: unknown[] = [
      'not-an-array',
      [null],
      [{ type: 'unsupported' }],
      [
        {
          type: 'char_location',
          cited_text: 1,
          document_index: 0,
          document_title: null,
          end_char_index: 1,
          start_char_index: 0,
        },
      ],
      [
        {
          type: 'page_location',
          cited_text: 'Page',
          document_index: 'zero',
          document_title: null,
          end_page_number: 1,
          start_page_number: 1,
        },
      ],
      [
        {
          type: 'web_search_result_location',
          cited_text: 'Web',
          encrypted_index: 'index',
          title: 42,
          url: 'https://example.com',
        },
      ],
    ];

    for (const citations of invalidCitations) {
      const conversation = conversationFromBlock({
        type: 'text',
        text: 'Cited',
        citations,
      });
      expect(() => toAnthropicMessagesForSdk(conversation)).toThrow(TypeError);
    }
  });

  it('accepts every documented web-search error and page-age shape', () => {
    const errorCodes = [
      'invalid_tool_input',
      'unavailable',
      'max_uses_exceeded',
      'too_many_requests',
      'query_too_long',
    ] as const;

    for (const error_code of errorCodes) {
      const conversation = conversationFromBlock({
        type: 'web_search_tool_result',
        tool_use_id: 'search-1',
        content: { type: 'web_search_tool_result_error', error_code },
      });
      expect(toAnthropicMessagesForSdk(conversation).messages).toHaveLength(1);
    }

    for (const page_age of [undefined, null, 'yesterday'] as const) {
      const result = {
        type: 'web_search_result',
        encrypted_content: 'encrypted',
        title: 'Result',
        url: 'https://example.com/result',
        ...(page_age === undefined ? {} : { page_age }),
      };
      const conversation = conversationFromBlock({
        type: 'web_search_tool_result',
        tool_use_id: 'search-1',
        content: [result],
      });
      expect(toAnthropicMessagesForSdk(conversation).messages).toHaveLength(1);
    }
  });

  it('rejects malformed web-search result content', () => {
    const invalidContent = [
      null,
      { type: 'web_search_tool_result_error', error_code: 'unknown' },
      [{ type: 'web_search_result', encrypted_content: 'encrypted', title: 'Missing URL' }],
    ];

    for (const content of invalidContent) {
      const conversation = conversationFromBlock({
        type: 'web_search_tool_result',
        tool_use_id: 'search-1',
        content,
      });
      expect(() => toAnthropicMessagesForSdk(conversation)).toThrow(TypeError);
    }
  });

  it('rejects provider blocks the stable SDK cannot submit', () => {
    const unsupportedBlocks: AnthropicContentBlock[] = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/svg+xml', data: 'c3Zn' },
      },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'text/plain', data: 'dGV4dA==' },
      },
      { type: 'document', source: { type: 'file', file_id: 'file-1' } },
      { type: 'server_tool_use', id: 'server-1', name: 'code_execution', input: {} },
      { type: 'code_execution_tool_result', tool_use_id: 'server-1', content: {} },
      { type: 'bash_code_execution_tool_result', tool_use_id: 'server-1', content: {} },
      { type: 'text_editor_code_execution_tool_result', tool_use_id: 'server-1', content: {} },
      { type: 'web_fetch_tool_result', tool_use_id: 'server-1', content: {} },
      { type: 'container_upload', file_id: 'file-1' },
    ];

    for (const block of unsupportedBlocks) {
      expect(() => toAnthropicMessagesForSdk(conversationFromBlock(block))).toThrow(TypeError);
    }
  });

  it('keeps only the final four message cache breakpoints', () => {
    let conversation = createConversationHistory();
    for (let index = 0; index < 5; index += 1) {
      conversation = appendMessages(conversation, {
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${index}`,
        cacheBoundary: true,
      });
    }

    const sdk = toAnthropicMessagesForSdk(conversation);
    const cacheBreakpoints = sdk.messages.map((message) => {
      const firstBlock = Array.isArray(message.content) ? message.content[0] : undefined;
      // Not every `ContentBlockParam` member (e.g. `ThinkingBlockParam`) carries
      // `cache_control`; every block built from these plain-text messages does.
      return firstBlock && 'cache_control' in firstBlock ? firstBlock.cache_control : undefined;
    });

    expect(cacheBreakpoints).toEqual([
      undefined,
      { type: 'ephemeral' },
      { type: 'ephemeral' },
      { type: 'ephemeral' },
      { type: 'ephemeral' },
    ]);
  });
});
