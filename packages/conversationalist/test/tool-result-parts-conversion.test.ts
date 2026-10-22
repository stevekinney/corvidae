import { describe, expect, it } from 'bun:test';

import { fromAnthropicMessages } from '../src/adapters/anthropic/inbound';
import { toAnthropicMessages } from '../src/adapters/anthropic/outbound';
import { toAnthropicMessagesForSdk } from '../src/adapters/anthropic/sdk';
import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import { resolvedSourceKey } from '../src/adapters/media';
import { toOpenAIMessages } from '../src/adapters/openai/outbound';
import {
  appendMessages,
  appendToolResult,
  createConversationHistory,
  deserializeConversationHistory,
} from '../src/conversation';
import { UnsupportedContentError } from '../src/errors';
import type { ToolResultPart } from '../src/multi-modal';
import type { ConversationHistory } from '../src/types';
import { getOrderedMessages } from '../src/utilities/message-store';

/**
 * COR-792: a tool result's ordered parts reach each provider natively or are
 * rejected before the provider call. They never become JSON text.
 */
const PNG = 'iVBORw0KGgo=';
const PDF = 'JVBERi0xLjQKJcfsj6IKJSVFT0YK';

const TEXT_AND_IMAGE: ToolResultPart[] = [
  { type: 'text', text: 'Before the chart.' },
  {
    type: 'image',
    mimeType: 'image/png',
    source: { kind: 'inline', data: PNG, encoding: 'base64' },
  },
  { type: 'text', text: 'After the chart.' },
];

function withToolResult(parts: ToolResultPart[], content: unknown = null): ConversationHistory {
  const conversation = appendMessages(createConversationHistory({ id: 'tool-parts' }), {
    role: 'tool-call',
    content: '',
    toolCall: { id: 'call-1', name: 'chart', arguments: {} },
  });
  return appendToolResult(conversation, {
    callId: 'call-1',
    outcome: 'success',
    content,
    parts,
  });
}

function rejection(run: () => unknown): UnsupportedContentError {
  try {
    run();
  } catch (error) {
    if (error instanceof UnsupportedContentError) return error;
    throw error;
  }
  throw new Error('expected an UnsupportedContentError');
}

describe('tool-result parts in the conversation', () => {
  it('stores ordered parts beside the JSON value and survives serialization', () => {
    const conversation = withToolResult(TEXT_AND_IMAGE, { width: 640 });
    const row = getOrderedMessages(conversation).at(-1);
    expect(row?.toolResult?.parts).toEqual(TEXT_AND_IMAGE);
    expect(row?.toolResult?.content).toEqual({ width: 640 });
    const restored = deserializeConversationHistory(JSON.parse(JSON.stringify(conversation)));
    expect(getOrderedMessages(restored).at(-1)?.toolResult?.parts).toEqual(TEXT_AND_IMAGE);
  });

  it('refuses a stored part the conversation schema does not accept', () => {
    const conversation = withToolResult(TEXT_AND_IMAGE);
    const json = JSON.parse(JSON.stringify(conversation)) as {
      messages: Record<string, { toolResult?: { parts?: unknown[] } }>;
    };
    const row = Object.values(json.messages).find((message) => message.toolResult);
    if (row?.toolResult)
      row.toolResult.parts = [
        {
          type: 'image',
          mimeType: 'audio/mpeg',
          source: { kind: 'inline', data: PNG, encoding: 'base64' },
        },
      ];
    expect(() => deserializeConversationHistory(json)).toThrow();
  });
});

describe('OpenAI tool messages', () => {
  it('send text parts as ordered text content parts', () => {
    const { messages } = toOpenAIMessages(
      withToolResult([
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ]),
    );
    expect(messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call-1',
      content: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ],
    });
  });

  it('reject a media part rather than describing it in text', () => {
    const error = rejection(() => toOpenAIMessages(withToolResult(TEXT_AND_IMAGE)));
    expect(error.reason).toBe('role-not-accepted');
    expect(error.partIndex).toBe(1);
    expect(error.partType).toBe('image');
  });
});

describe('Anthropic tool_result blocks', () => {
  it('carry text, image, and document parts in order', () => {
    const conversation = withToolResult([
      ...TEXT_AND_IMAGE,
      {
        type: 'document',
        name: 'report',
        mimeType: 'application/pdf',
        source: { kind: 'inline', data: PDF, encoding: 'base64' },
      },
    ]);
    const { messages, lineage } = toAnthropicMessages(conversation);
    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: [
            { type: 'text', text: 'Before the chart.' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
            { type: 'text', text: 'After the chart.' },
            {
              type: 'document',
              title: 'report',
              source: { type: 'base64', media_type: 'application/pdf', data: PDF },
            },
          ],
        },
      ],
    });
    expect(lineage.map((entry) => entry.partIndex)).toEqual([1, 3]);

    const sdk = toAnthropicMessagesForSdk(conversation);
    const block = sdk.messages.at(-1)?.content;
    expect(Array.isArray(block) && block[0]).toMatchObject({
      type: 'tool_result',
      content: [
        { type: 'text', text: 'Before the chart.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
        { type: 'text', text: 'After the chart.' },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf' } },
      ],
    });
  });

  it('reject audio, which a tool_result cannot hold', () => {
    const error = rejection(() =>
      toAnthropicMessages(
        withToolResult([
          {
            type: 'audio',
            mimeType: 'audio/mpeg',
            source: { kind: 'inline', data: PNG, encoding: 'base64' },
          },
        ]),
      ),
    );
    expect(error.reason).toBe('modality-not-accepted');
  });

  it('read block content back into ordered parts', () => {
    const imported = fromAnthropicMessages({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call-1', name: 'chart', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-1',
              content: [
                { type: 'text', text: 'Before the chart.' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
              ],
            },
          ],
        },
      ],
    });
    const result = getOrderedMessages(imported).at(-1)?.toolResult;
    expect(result?.content).toBeNull();
    expect(result?.parts?.map((part) => part.type)).toEqual(['text', 'image']);
  });
});

describe('Gemini function responses', () => {
  it('carry media as inline parts and keep the order in response.output', () => {
    const { contents, lineage } = toGeminiMessages(withToolResult(TEXT_AND_IMAGE));
    expect(contents.at(-1)).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'chart',
            response: { output: ['Before the chart.', { part: 0 }, 'After the chart.'] },
            parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }],
          },
        },
      ],
    });
    expect(lineage).toHaveLength(1);
  });

  it('reject a remote URL, which a function response cannot reference', () => {
    const error = rejection(() =>
      toGeminiMessages(
        withToolResult([
          {
            type: 'image',
            mimeType: 'image/png',
            source: { kind: 'remote-url', url: 'https://example.com/chart.png' },
          },
        ]),
      ),
    );
    expect(error.reason).toBe('source-form-not-accepted');
  });
});

describe('managed-asset parts', () => {
  const asset: ToolResultPart[] = [
    {
      type: 'image',
      mimeType: 'image/png',
      source: { kind: 'managed-asset', assetId: 'asset-1', revision: 1 },
    },
  ];

  it('are rejected by every provider until a resolver projects them', () => {
    const conversation = withToolResult(asset);
    for (const run of [
      () => toAnthropicMessages(conversation),
      () => toGeminiMessages(conversation),
    ]) {
      expect(rejection(run).reason).toBe('source-form-not-accepted');
    }
    expect(rejection(() => toOpenAIMessages(conversation)).reason).toBe('role-not-accepted');
  });

  it('are delivered once a resolver projects them to bytes', () => {
    const conversation = withToolResult(asset);
    const row = getOrderedMessages(conversation).at(-1);
    const sources = new Map([
      [
        resolvedSourceKey(row?.id ?? '', 0),
        {
          outcome: 'resolved' as const,
          source: { kind: 'inline' as const, data: PNG, encoding: 'base64' as const },
          mimeType: 'image/png',
          safety: 'clean' as const,
        },
      ],
    ]);
    const { messages, lineage } = toAnthropicMessages(conversation, { sources });
    expect(JSON.stringify(messages)).toContain(PNG);
    expect(lineage[0]).toMatchObject({ assetId: 'asset-1', revision: 1 });
  });
});
