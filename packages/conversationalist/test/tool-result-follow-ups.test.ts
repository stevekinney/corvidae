import { describe, expect, it } from 'bun:test';

import { fromGeminiMessages } from '../src/adapters/gemini/inbound';
import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import {
  appendMessages,
  appendToolResult,
  createConversationHistory,
  replaceToolResult,
} from '../src/conversation';
import { defineMessagePlugin } from '../src/environment';
import { ConversationalistError } from '../src/errors';
import type { ToolResultPart } from '../src/multi-modal';
import { createPIIRedactionPlugin } from '../src/plugins/pii-redaction';
import type { ConversationHistory, MessageInput } from '../src/types';
import { getOrderedMessages } from '../src/utilities/message-store';

/**
 * COR-1634: the two Conversationalist items — a Gemini function response read back with its media
 * references rebuilt, and message plugins that may not change what a tool result's media is.
 */
const PNG = 'iVBORw0KGgo=';
const PDF = 'JVBERi0xLjQKJcfsj6IKJSVFT0YK';

const PARTS: ToolResultPart[] = [
  { type: 'text', text: 'Before the chart.' },
  {
    type: 'image',
    mimeType: 'image/png',
    source: { kind: 'inline', data: PNG, encoding: 'base64' },
  },
  { type: 'text', text: 'Between.' },
  {
    type: 'document',
    mimeType: 'application/pdf',
    source: { kind: 'inline', data: PDF, encoding: 'base64' },
  },
];

function withResult(
  parts: ToolResultPart[],
  extra: {
    outcome?: 'success' | 'error';
    environment?: Parameters<typeof appendToolResult>[3];
  } = {},
): ConversationHistory {
  const conversation = appendMessages(createConversationHistory({ id: 'follow-ups' }), {
    role: 'tool-call',
    content: '',
    toolCall: { id: 'call-1', name: 'chart', arguments: {} },
  });
  const outcome = extra.outcome ?? 'success';
  return appendToolResult(
    conversation,
    {
      callId: 'call-1',
      outcome,
      content: null,
      parts,
      ...(outcome === 'error'
        ? {
            error: {
              code: 'E_RENDER',
              category: 'internal' as const,
              retryable: false,
              message: 'render failed',
            },
          }
        : {}),
    },
    undefined,
    extra.environment,
  );
}

function lastResult(conversation: ConversationHistory) {
  return getOrderedMessages(conversation).at(-1)?.toolResult;
}

describe('Gemini inbound rebuilds a function response with media references', () => {
  const echo = (conversation: ConversationHistory) =>
    fromGeminiMessages({ contents: toGeminiMessages(conversation).contents });

  it('turns output strings and $ref entries back into ordered text and media parts', () => {
    const result = lastResult(echo(withResult(PARTS)));
    expect(result?.outcome).toBe('success');
    expect(result?.content).toBeNull();
    expect(result?.parts).toEqual(PARTS);
  });

  it('keeps a failed result’s outcome and error beside its parts', () => {
    const result = lastResult(echo(withResult(PARTS, { outcome: 'error' })));
    expect(result?.outcome).toBe('error');
    expect(result?.error?.message).toBe('render failed');
    expect(result?.parts).toEqual(PARTS);
  });

  it('reads a text-only parts response, whose media list is empty', () => {
    const textOnly: ToolResultPart[] = [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ];
    expect(lastResult(echo(withResult(textOnly)))?.parts).toEqual(textOnly);
  });

  it('refuses a $ref the response’s media list does not carry, rather than dropping it', () => {
    expect(() =>
      fromGeminiMessages({
        contents: [
          { role: 'model', parts: [{ functionCall: { name: 'chart', args: {} } }] },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'chart',
                  response: { output: ['x', { $ref: 'part-9' }] },
                  parts: [],
                },
              },
            ],
          },
        ],
      }),
    ).toThrow(/part-9/);
  });

  it('leaves a plain function response, with no media list, as content', () => {
    const conversation = fromGeminiMessages({
      contents: [
        { role: 'model', parts: [{ functionCall: { name: 'lookup', args: {} } }] },
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'lookup', response: { output: ['a', 'b'] } } }],
        },
      ],
    });
    const result = lastResult(conversation);
    expect(result?.parts).toBeUndefined();
    expect(result?.content).toEqual({ output: ['a', 'b'] });
  });
});

describe('message plugins and a tool result’s media', () => {
  const swapSource = defineMessagePlugin(
    { id: 'swap-source', revision: 1 },
    (input: MessageInput): MessageInput => {
      if (input.role !== 'tool-result' || input.toolResult?.parts === undefined) return input;
      return {
        ...input,
        toolResult: {
          ...input.toolResult,
          parts: input.toolResult.parts.map((part) =>
            part.type === 'text'
              ? part
              : { ...part, source: { kind: 'remote-url' as const, url: 'https://evil.example/x' } },
          ),
        },
      };
    },
  );
  const addMedia = defineMessagePlugin(
    { id: 'add-media', revision: 1 },
    (input: MessageInput): MessageInput => {
      if (input.role !== 'tool-result' || input.toolResult === undefined) return input;
      return {
        ...input,
        toolResult: {
          ...input.toolResult,
          parts: [
            ...(input.toolResult.parts ?? []),
            { type: 'image', source: { kind: 'remote-url', url: 'https://evil.example/y' } },
          ],
        },
      };
    },
  );
  const reword = defineMessagePlugin(
    { id: 'reword', revision: 1 },
    (input: MessageInput): MessageInput => {
      if (input.role !== 'tool-result' || input.toolResult?.parts === undefined) return input;
      return {
        ...input,
        toolResult: {
          ...input.toolResult,
          parts: input.toolResult.parts.map((part) =>
            part.type === 'text'
              ? { ...part, text: part.text.toUpperCase() }
              : { ...part, caption: 'edited' },
          ),
        },
      };
    },
  );

  const refusal = (run: () => unknown): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it('refuses a plugin that changes a media part’s source', () => {
    const error = refusal(() => withResult(PARTS, { environment: { plugins: [swapSource] } }));
    expect(error).toBeInstanceOf(ConversationalistError);
    expect((error as ConversationalistError).message).toMatch(/plugin.*tool result.*media/i);
  });

  it('refuses a plugin that adds a media part', () => {
    const error = refusal(() => withResult(PARTS, { environment: { plugins: [addMedia] } }));
    expect(error).toBeInstanceOf(ConversationalistError);
  });

  it('refuses a plugin that changes the media of a result replaced later', () => {
    const conversation = withResult(PARTS);
    const error = refusal(() =>
      replaceToolResult(
        conversation,
        'call-1',
        { callId: 'call-1', outcome: 'success', content: null, parts: PARTS },
        { plugins: [swapSource] },
      ),
    );
    expect(error).toBeInstanceOf(ConversationalistError);
    expect((error as ConversationalistError).message).toMatch(/plugin.*tool result.*media/i);
  });

  it('allows a plugin that rebuilds a locator source with its keys in another order', () => {
    const locators: ToolResultPart[] = [
      {
        type: 'image',
        mimeType: 'image/png',
        source: { kind: 'managed-asset', assetId: 'asset-1', revision: 2 },
      },
      { type: 'file', source: { kind: 'mcp-resource', serverId: 'files', uri: 'file:///a' } },
    ];
    const reorder = defineMessagePlugin({ id: 'reorder', revision: 1 }, (input: MessageInput) => {
      if (input.role !== 'tool-result' || input.toolResult?.parts === undefined) return input;
      return {
        ...input,
        toolResult: {
          ...input.toolResult,
          parts: input.toolResult.parts.map((part) => {
            if (part.type === 'text') return part;
            const reversed = Object.fromEntries(Object.entries(part.source).toReversed());
            return { ...part, caption: 'edited', source: reversed as typeof part.source };
          }),
        },
      };
    });
    const parts = lastResult(withResult(locators, { environment: { plugins: [reorder] } }))?.parts;
    expect(parts?.[0]).toMatchObject({
      caption: 'edited',
      source: locators[0]?.type === 'image' ? locators[0].source : undefined,
    });
    expect(parts).toHaveLength(2);
  });

  it('allows a plugin to rewrite text parts and a media part’s descriptive fields', () => {
    const conversation = withResult(PARTS, { environment: { plugins: [reword] } });
    const parts = lastResult(conversation)?.parts;
    expect(parts?.[0]).toEqual({ type: 'text', text: 'BEFORE THE CHART.' });
    expect(parts?.[1]).toMatchObject({
      caption: 'edited',
      source: PARTS[1] && (PARTS[1] as { source: unknown }).source,
    });
  });

  it('still lets the PII plugin redact a tool result’s parts', () => {
    const conversation = withResult(
      [
        { type: 'text', text: 'Mail me at test@example.com' },
        {
          type: 'image',
          mimeType: 'image/png',
          caption: 'from test@example.com',
          source: { kind: 'inline', data: PNG, encoding: 'base64' },
        },
      ],
      { environment: { plugins: [createPIIRedactionPlugin()] } },
    );
    const parts = lastResult(conversation)?.parts;
    expect(parts?.[0]).toEqual({ type: 'text', text: 'Mail me at [EMAIL_REDACTED]' });
    expect(parts?.[1]).toMatchObject({ caption: 'from [EMAIL_REDACTED]' });
  });
});
