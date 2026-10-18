import { describe, expect, it } from 'bun:test';

import { fromAnthropicMessages } from '../src/adapters/anthropic/inbound';
import { toAnthropicMessagesForSdk } from '../src/adapters/anthropic/sdk';
import type { AnthropicConversation } from '../src/adapters/anthropic/types';

describe('Anthropic SDK conversion', () => {
  it('converts plain system and message strings without casts', () => {
    const conversation = fromAnthropicMessages({
      system: 'Follow the system instructions.',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(toAnthropicMessagesForSdk(conversation)).toEqual({
      system: 'Follow the system instructions.',
      messages: [{ role: 'user', content: 'Hello' }],
      lineage: [],
    });
  });

  it('normalizes public Anthropic text document sources to SDK text blocks', () => {
    const conversation = fromAnthropicMessages({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              title: 'inline.txt',
              source: { type: 'text', media_type: 'text/plain', data: 'Plain text document' },
            },
          ],
        },
      ],
    });

    expect(toAnthropicMessagesForSdk(conversation).messages).toEqual([
      { role: 'user', content: 'Plain text document' },
    ]);
  });

  it('converts every request-safe block and cache-marked system segment', () => {
    const conversation = fromAnthropicMessages({
      system: [
        { type: 'text', text: 'Stable system segment', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Dynamic system segment' },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect these inputs.', citations: null },
            { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' },
            },
            {
              type: 'document',
              title: 'remote.pdf',
              source: { type: 'url', url: 'https://example.com/remote.pdf' },
            },
            {
              type: 'document',
              title: 'inline.pdf',
              source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' },
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Reasoning', signature: 'signature' },
            { type: 'redacted_thinking', data: 'encrypted' },
            {
              type: 'server_tool_use',
              id: 'server-tool-1',
              name: 'web_search',
              input: { query: 'news' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'web_search_tool_result',
              tool_use_id: 'server-tool-1',
              content: [
                {
                  type: 'web_search_result',
                  encrypted_content: 'encrypted-result',
                  title: 'Result',
                  url: 'https://example.com/result',
                  page_age: null,
                },
              ],
            },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'lookup', input: { id: 1 } }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'done', is_error: false },
          ],
        },
      ],
    });

    const sdk = toAnthropicMessagesForSdk(conversation, { extendedCacheTtl: true });

    expect(sdk.system).toEqual([
      {
        type: 'text',
        text: 'Stable system segment',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
      { type: 'text', text: 'Dynamic system segment' },
    ]);
    expect(JSON.stringify(sdk.messages)).toContain('web_search_tool_result');
    expect(JSON.stringify(sdk.messages)).toContain('tool_result');
    expect(JSON.stringify(sdk.messages)).toContain('inline.pdf');
  });

  it('restores Anthropic file document references during neutral conversion', () => {
    const payload: AnthropicConversation = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', title: 'upload.pdf', source: { type: 'file', file_id: 'file-1' } },
          ],
        },
      ],
    };

    const conversation = fromAnthropicMessages(payload);

    expect(conversation.messages[conversation.ids[0]!]?.content).toEqual([
      {
        type: 'document',
        name: 'upload.pdf',
        source: { kind: 'provider-file', provider: 'anthropic', providerFileId: 'file-1' },
      },
    ]);
  });
});
