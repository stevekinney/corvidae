import { describe, expect, it } from 'bun:test';

import { fromAnthropicMessages } from '../src/adapters/anthropic/inbound';
import { toAnthropicMessages } from '../src/adapters/anthropic/outbound';
import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import { toOpenAIMessages } from '../src/adapters/openai/outbound';
import { appendMessages, createConversationHistory } from '../src/conversation';
import type { Message } from '../src/types';

const getOrderedMessages = (messages: {
  ids: ReadonlyArray<string>;
  messages: Readonly<Record<string, Message>>;
}): Message[] =>
  messages.ids
    .map((id) => messages.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('provider document conversion', () => {
  it('exports document content to Anthropic document blocks and text fallbacks', () => {
    let conversation = createConversationHistory();
    conversation = appendMessages(conversation, {
      role: 'user',
      content: [
        {
          type: 'document',
          name: 'requirements.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'base64', data: 'cGRm' },
        },
        {
          type: 'document',
          name: 'workspace-notes.md',
          mimeType: 'text/markdown',
          source: { kind: 'reference', uri: 'sandbox:/workspace/notes.md' },
        },
        {
          type: 'document',
          name: 'hosted.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'reference', uri: 'https://example.com/hosted.pdf' },
        },
        {
          type: 'document',
          name: 'uploaded.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'reference', uri: 'file:file_123' },
        },
      ],
    });

    expect(toAnthropicMessages(conversation).messages).toEqual([
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
            type: 'text',
            text: '[Document: workspace-notes.md (text/markdown) at sandbox:/workspace/notes.md]',
          },
          {
            type: 'document',
            title: 'hosted.pdf',
            source: {
              type: 'url',
              url: 'https://example.com/hosted.pdf',
            },
          },
          {
            type: 'document',
            title: 'uploaded.pdf',
            source: {
              type: 'file',
              file_id: 'file_123',
            },
          },
        ],
      },
    ]);
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
        source: { kind: 'base64', data: 'cGRm' },
      },
      {
        type: 'document',
        name: 'hosted.pdf',
        mimeType: 'application/octet-stream',
        source: { kind: 'reference', uri: 'https://example.com/hosted.pdf' },
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

  it('downgrades document content to text for providers without document blocks', () => {
    let conversation = createConversationHistory();
    conversation = appendMessages(conversation, {
      role: 'user',
      content: [
        {
          type: 'document',
          name: 'workspace-notes.md',
          mimeType: 'text/markdown',
          source: { kind: 'reference', uri: 'sandbox:/workspace/notes.md' },
        },
      ],
    });

    expect(toOpenAIMessages(conversation)).toEqual([
      {
        role: 'user',
        content: '[Document: workspace-notes.md (text/markdown) at sandbox:/workspace/notes.md]',
      },
    ]);
    expect(toGeminiMessages(conversation)).toEqual({
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: '[Document: workspace-notes.md (text/markdown) at sandbox:/workspace/notes.md]',
            },
          ],
        },
      ],
    });
  });
});
