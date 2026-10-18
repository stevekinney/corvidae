import { describe, expect, it } from 'bun:test';

import { fromAnthropicMessages } from '../src/adapters/anthropic/inbound';
import { toAnthropicMessages } from '../src/adapters/anthropic/outbound';
import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import { toOpenAIMessages } from '../src/adapters/openai/outbound';
import { appendMessages, createConversationHistory } from '../src/conversation';
import { UnsupportedContentError } from '../src/errors';
import type { Message } from '../src/types';

const getOrderedMessages = (messages: {
  ids: ReadonlyArray<string>;
  messages: Readonly<Record<string, Message>>;
}): Message[] =>
  messages.ids
    .map((id) => messages.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('provider document conversion', () => {
  it('exports document content to Anthropic document blocks with lineage', () => {
    let conversation = createConversationHistory();
    conversation = appendMessages(conversation, {
      role: 'user',
      content: [
        {
          type: 'document',
          name: 'requirements.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'inline', data: 'cGRm', encoding: 'base64' },
        },
        {
          type: 'document',
          name: 'hosted.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'remote-url', url: 'https://example.com/hosted.pdf' },
        },
        {
          type: 'document',
          name: 'uploaded.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'provider-file', provider: 'anthropic', providerFileId: 'file_123' },
        },
      ],
    });

    const exported = toAnthropicMessages(conversation);
    expect(exported.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            title: 'requirements.pdf',
            source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' },
          },
          {
            type: 'document',
            title: 'hosted.pdf',
            source: { type: 'url', url: 'https://example.com/hosted.pdf' },
          },
          {
            type: 'document',
            title: 'uploaded.pdf',
            source: { type: 'file', file_id: 'file_123' },
          },
        ],
      },
    ]);
    expect(exported.lineage.map((entry) => [entry.partIndex, entry.from, entry.transform])).toEqual(
      [
        [0, 'inline', 'inline-base64'],
        [1, 'remote-url', 'remote-url-delegated'],
        [2, 'provider-file', 'provider-file-reference'],
      ],
    );
  });

  it('rejects a document source Anthropic cannot carry instead of writing marker prose', () => {
    let conversation = createConversationHistory();
    conversation = appendMessages(conversation, {
      role: 'user',
      content: [
        {
          type: 'document',
          name: 'workspace-notes.md',
          mimeType: 'text/markdown',
          source: { kind: 'local-file', path: '/workspace/notes.md' },
        },
      ],
    });

    expect(() => toAnthropicMessages(conversation)).toThrow(UnsupportedContentError);
    expect(() => toAnthropicMessages(conversation)).toThrow(/source-form-not-accepted/);
  });

  it('reconstructs Anthropic document blocks into document content', () => {
    const conversation = fromAnthropicMessages({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              title: 'requirements.pdf',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: 'cGRm',
              },
            },
            {
              type: 'document',
              title: 'hosted.pdf',
              source: {
                type: 'url',
                url: 'https://example.com/hosted.pdf',
              },
            },
          ],
        },
      ],
    });
    const messages = getOrderedMessages(conversation);

    expect(messages[0]?.content).toEqual([
      {
        type: 'document',
        name: 'requirements.pdf',
        mimeType: 'application/pdf',
        source: { kind: 'inline', data: 'cGRm', encoding: 'base64' },
      },
      {
        type: 'document',
        name: 'hosted.pdf',
        source: { kind: 'remote-url', url: 'https://example.com/hosted.pdf' },
      },
    ]);
  });

  it('downgrades Anthropic text document sources to text content', () => {
    const conversation = fromAnthropicMessages({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              title: 'notes.md',
              source: {
                type: 'text',
                media_type: 'text/markdown',
                data: '# Notes\n\nPlain document text.',
              },
            },
          ],
        },
      ],
    });
    const messages = getOrderedMessages(conversation);

    expect(messages[0]?.content).toBe('# Notes\n\nPlain document text.');
  });

  it('delivers or rejects a document for providers without document blocks, never marker prose', () => {
    let conversation = createConversationHistory();
    conversation = appendMessages(conversation, {
      role: 'user',
      content: [
        {
          type: 'document',
          name: 'workspace-notes.md',
          mimeType: 'text/markdown',
          source: { kind: 'local-file', path: '/workspace/notes.md' },
        },
      ],
    });

    expect(() => toOpenAIMessages(conversation)).toThrow(UnsupportedContentError);
    expect(() => toGeminiMessages(conversation)).toThrow(UnsupportedContentError);
  });

  it('delivers a hosted document to Gemini and an inline one to OpenAI', () => {
    let hosted = createConversationHistory();
    hosted = appendMessages(hosted, {
      role: 'user',
      content: [
        {
          type: 'document',
          name: 'hosted.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'remote-url', url: 'https://example.com/hosted.pdf' },
        },
      ],
    });
    expect(toGeminiMessages(hosted).contents).toEqual([
      {
        role: 'user',
        parts: [
          { fileData: { mimeType: 'application/pdf', fileUri: 'https://example.com/hosted.pdf' } },
        ],
      },
    ]);

    let inline = createConversationHistory();
    inline = appendMessages(inline, {
      role: 'user',
      content: [
        {
          type: 'document',
          name: 'requirements.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'inline', data: 'cGRm', encoding: 'base64' },
        },
      ],
    });
    expect(toOpenAIMessages(inline).messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'file',
            file: { file_data: 'data:application/pdf;base64,cGRm', filename: 'requirements.pdf' },
          },
        ],
      },
    ]);
  });
});
