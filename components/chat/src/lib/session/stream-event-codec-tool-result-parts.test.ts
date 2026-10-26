import { describe, expect, test } from 'bun:test';
import { decodeChatStreamEvent, encodeChatStreamEvent } from './stream-event-codec.ts';

/**
 * COR-1634: a tool result's ordered `parts` (text and media) cross the stream wire beside its
 * `content`. The encoder's whitelist once dropped them, so a client saw only the structured value.
 */
const parts = [
  { type: 'text' as const, text: 'Here is the chart:' },
  {
    type: 'image' as const,
    mimeType: 'image/png',
    name: 'chart.png',
    source: { kind: 'managed-asset' as const, assetId: 'asset-1', revision: 2 },
  },
];

describe('tool results carry their parts across the wire (COR-1634)', () => {
  test('round-trips tool.settled with parts beside content', () => {
    const event = {
      type: 'tool.settled' as const,
      toolCallId: 'call-1',
      toolName: 'chart',
      result: {
        callId: 'call-1',
        outcome: 'success' as const,
        content: { series: 'sales' },
        parts,
      },
      wireVersion: 4 as const,
      sequence: 1,
    };
    expect(decodeChatStreamEvent(encodeChatStreamEvent(event))).toEqual(event);
  });

  test('round-trips the legacy tool_result frame with parts', () => {
    const event = {
      type: 'tool_result' as const,
      callId: 'call-1',
      outcome: 'success' as const,
      content: null,
      parts,
    };
    expect(decodeChatStreamEvent(encodeChatStreamEvent(event))).toEqual(event);
  });

  test('carries the parts of a failed result with its error', () => {
    const event = {
      type: 'tool.settled' as const,
      toolCallId: 'call-2',
      toolName: 'chart',
      result: {
        callId: 'call-2',
        outcome: 'error' as const,
        content: null,
        parts: [{ type: 'text' as const, text: 'render failed' }],
        error: {
          code: 'E_RENDER',
          category: 'internal' as const,
          retryable: false,
          message: 'render failed',
        },
      },
      wireVersion: 3 as const,
      sequence: 1,
    };
    expect(decodeChatStreamEvent(encodeChatStreamEvent(event))).toEqual(event);
  });

  test('leaves a result without parts without a parts field', () => {
    const encoded = encodeChatStreamEvent({
      type: 'tool_result',
      callId: 'call-3',
      outcome: 'success',
      content: 'ok',
    });
    expect(JSON.stringify(encoded)).not.toContain('parts');
  });

  test('refuses to encode malformed parts, and a decoded frame with them', () => {
    const malformed = [{ type: 'image', source: { kind: 'managed-asset' } }];
    expect(() =>
      encodeChatStreamEvent({
        type: 'tool_result',
        callId: 'call-4',
        outcome: 'success',
        content: null,
        parts: malformed,
      } as never),
    ).toThrow('Invalid chat stream event');
    expect(() =>
      decodeChatStreamEvent({
        type: 'tool_result',
        callId: 'call-4',
        outcome: 'success',
        content: null,
        parts: malformed,
      }),
    ).toThrow('Invalid chat stream event');
  });

  test('refuses non-finite JSON inside a part’s metadata, as it does inside content', () => {
    expect(() =>
      encodeChatStreamEvent({
        type: 'tool_result',
        callId: 'call-5',
        outcome: 'success',
        content: null,
        parts: [
          {
            type: 'file',
            source: { kind: 'managed-asset', assetId: 'a' },
            metadata: { size: Number.POSITIVE_INFINITY },
          },
        ],
      }),
    ).toThrow();
  });
});
