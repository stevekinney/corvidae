import { describe, expect, it } from 'bun:test';

import { fromAnthropicMessages } from '../src/adapters/anthropic/inbound';
import { toAnthropicMessages } from '../src/adapters/anthropic/outbound';
import { toAnthropicMessagesForSdk } from '../src/adapters/anthropic/sdk';
import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import { resolvedSourceKey } from '../src/adapters/media';
import { fromOpenAIMessages } from '../src/adapters/openai/inbound';
import { toOpenAIMessages } from '../src/adapters/openai/outbound';
import { partitionMessages } from '../src/compaction/preservation';
import { stripToolResultDetails } from '../src/compaction/stripping';
import {
  appendMessages,
  appendToolResult,
  createConversationHistory,
  deserializeConversationHistory,
} from '../src/conversation';
import { simpleTokenEstimator } from '../src/environment';
import { UnsupportedContentError } from '../src/errors';
import type { ToolResultPart } from '../src/multi-modal';
import { messageMediaParts } from '../src/multi-modal';
import { createPIIRedactionPlugin } from '../src/plugins/pii-redaction';
import type { ConversationHistory } from '../src/types';
import { getOrderedMessages } from '../src/utilities/message-store';
import { redactToolResult } from '../src/utilities/tool-results';

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
  it('carry media as inline parts and reference them in order from response.output', () => {
    const { contents, lineage } = toGeminiMessages(withToolResult(TEXT_AND_IMAGE));
    expect(contents.at(-1)).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'chart',
            response: { output: ['Before the chart.', { $ref: 'part-1' }, 'After the chart.'] },
            parts: [{ inlineData: { mimeType: 'image/png', data: PNG, displayName: 'part-1' } }],
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

describe('tool-result parts on other outcomes and redaction', () => {
  function withErrorResult(parts: ToolResultPart[]): ConversationHistory {
    const conversation = appendMessages(createConversationHistory({ id: 'tool-error' }), {
      role: 'tool-call',
      content: '',
      toolCall: { id: 'call-1', name: 'chart', arguments: {} },
    });
    return appendToolResult(conversation, {
      callId: 'call-1',
      outcome: 'error',
      content: null,
      parts,
      error: { code: 'E', category: 'internal', retryable: false, message: 'failed' },
    });
  }

  it("keeps an error result's parts for every provider and flags the outcome", () => {
    const conversation = withErrorResult(TEXT_AND_IMAGE);
    const anthropic = toAnthropicMessages(conversation).messages.at(-1);
    expect(anthropic?.content).toMatchObject([
      {
        type: 'tool_result',
        is_error: true,
        content: [{ type: 'text' }, { type: 'image' }, { type: 'text' }],
      },
    ]);
    const gemini = toGeminiMessages(conversation).contents.at(-1);
    expect(gemini?.parts[0]).toMatchObject({
      functionResponse: { response: { outcome: 'error', error: { message: 'failed' } } },
    });
    const openai = toOpenAIMessages(withErrorResult([{ type: 'text', text: 'why' }])).messages.at(
      -1,
    );
    expect(openai).toMatchObject({
      role: 'tool',
      content: [{ type: 'text' }, { type: 'text', text: 'why' }],
    });
    const lead = (openai as { content: Array<{ text: string }> }).content[0]?.text ?? '';
    expect(JSON.parse(lead)).toMatchObject({ outcome: 'error', error: { message: 'failed' } });
  });

  it('removes parts when a tool result is redacted', () => {
    const conversation = withToolResult(TEXT_AND_IMAGE);
    const row = getOrderedMessages(conversation).at(-1);
    const redacted =
      row?.toolResult === undefined ? undefined : redactToolResult(row.toolResult, '[redacted]');
    expect(redacted).toEqual({ callId: 'call-1', outcome: 'success', content: '[redacted]' });
  });
});

describe('tool-result parts reach every media consumer', () => {
  it('lists tool-result media beside content media', () => {
    expect(
      messageMediaParts({ content: '', toolResult: { parts: TEXT_AND_IMAGE } }).map(
        ({ partIndex, inToolResult }) => [partIndex, inToolResult],
      ),
    ).toEqual([[1, true]]);
  });

  it('preserves a tool result carrying media through compaction', () => {
    let conversation = withToolResult(TEXT_AND_IMAGE);
    for (let index = 0; index < 6; index += 1) {
      conversation = appendMessages(conversation, { role: 'user', content: `filler ${index}` });
    }
    const { preserved } = partitionMessages(conversation, { preserveRecentCount: 2 });
    expect(preserved.some((message) => message.toolResult?.parts !== undefined)).toBe(true);
    expect(preserved.some((message) => message.role === 'tool-call')).toBe(true);
  });

  it('redacts PII in tool-result parts', () => {
    const plugin = createPIIRedactionPlugin();
    const redacted = plugin({
      role: 'tool-result',
      content: '',
      toolResult: {
        callId: 'call-1',
        outcome: 'success',
        content: null,
        parts: [
          { type: 'text', text: 'Mail jane@example.com' },
          { ...(TEXT_AND_IMAGE[1] as ToolResultPart & { type: 'image' }), alt: 'jane@example.com' },
        ],
      },
    });
    expect(JSON.stringify(redacted)).not.toContain('jane@example.com');
  });

  it('round-trips an OpenAI error result with parts, outcome included', () => {
    const conversation = appendMessages(createConversationHistory({ id: 'round-trip' }), {
      role: 'tool-call',
      content: '',
      toolCall: { id: 'call-1', name: 'chart', arguments: {} },
    });
    const withError = appendToolResult(conversation, {
      callId: 'call-1',
      outcome: 'error',
      content: null,
      parts: [{ type: 'text', text: 'why' }],
      error: { code: 'E', category: 'internal', retryable: false, message: 'failed' },
    });
    const imported = fromOpenAIMessages(toOpenAIMessages(withError).messages);
    const result = getOrderedMessages(imported).at(-1)?.toolResult;
    expect(result).toMatchObject({
      outcome: 'error',
      error: { message: 'failed' },
      parts: [{ type: 'text', text: 'why' }],
    });
  });
});

describe('tool-result parts in compaction, estimation, and replay', () => {
  it('strips parts with content before a tool result is summarized', () => {
    const row = getOrderedMessages(withToolResult(TEXT_AND_IMAGE)).at(-1);
    const [stripped] = stripToolResultDetails(row === undefined ? [] : [row]);
    expect(stripped?.toolResult?.parts).toBeUndefined();
    expect(JSON.stringify(stripped)).not.toContain('Before the chart.');
  });

  it("counts a tool result's parts in the token estimate", () => {
    const row = getOrderedMessages(withToolResult([{ type: 'text', text: 'x'.repeat(400) }])).at(
      -1,
    );
    expect(row === undefined ? 0 : simpleTokenEstimator(row)).toBeGreaterThanOrEqual(100);
  });

  it('keeps citations on Anthropic tool_result text', () => {
    const citations = [{ type: 'char_location', cited_text: 'a' }];
    const { messages } = toAnthropicMessages(
      withToolResult([{ type: 'text', text: 'cited', citations }]),
    );
    expect(JSON.stringify(messages.at(-1))).toContain('char_location');
  });
});
