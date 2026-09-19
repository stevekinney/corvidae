import { describe, expect, it } from 'bun:test';

import { fromOpenAIMessages } from '../src/adapters/openai/inbound';
import type { OpenAIMessage } from '../src/adapters/openai/types';
import type { Message } from '../src/types';

function approvalAction(message: string, idempotencyKey: string) {
  return {
    type: 'approval' as const,
    message,
    risk: 'high' as const,
    operation: { kind: 'other' as const },
    policyVersion: 'policy:test',
    idempotencyKey,
  };
}
const getOrderedMessages = (messages: {
  ids: ReadonlyArray<string>;
  messages: Readonly<Record<string, Message>>;
}): Message[] =>
  messages.ids
    .map((id) => messages.messages[id])
    .filter((message): message is Message => Boolean(message));

describe('OpenAI provider conversion', () => {
  it('reconstructs OpenAI messages into canonical tool interactions', () => {
    const payload: OpenAIMessage[] = [
      {
        role: 'system',
        content: 'You are helpful.',
      },
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'lookup_weather',
              arguments: JSON.stringify({ city: 'Denver' }),
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: JSON.stringify({
          outcome: 'action_required',
          content: { prompt: 'Approve tool' },
          action: approvalAction('Need approval', 'approval:openai-provider'),
        }),
      },
    ];

    const conversation = Reflect.apply(fromOpenAIMessages, undefined, [payload]);
    const messages = getOrderedMessages(conversation);

    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'assistant',
      'tool-call',
      'tool-result',
    ]);
    expect(messages[1]?.content).toBe('Let me check.');
    expect(messages[2]?.toolCall).toEqual({
      id: 'call-1',
      name: 'lookup_weather',
      arguments: { city: 'Denver' },
    });
    expect(messages[3]?.toolResult).toMatchObject({
      callId: 'call-1',
      outcome: 'action_required',
      content: { prompt: 'Approve tool' },
      action: approvalAction('Need approval', 'approval:openai-provider'),
    });
  });

  it('reconstructs OpenAI null, multimodal, and fallback payload variants', () => {
    // Untyped here on purpose: this payload deliberately includes shapes a real
    // OpenAI API response can send but `OpenAIMessage`'s per-role content typing
    // forbids (a `system` message with `content: null`, an `assistant` message
    // mixing text and image parts) — the point of this test is that
    // `fromOpenAIMessages` handles them defensively.
    const payload = [
      {
        role: 'system',
        content: null,
      },
      {
        role: 'user',
        content: [],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Single text part' }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'See this image' },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/weather-map.png' },
          },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-invalid',
            type: 'function',
            function: {
              name: 'invalid_args',
              arguments: '{not-json',
            },
          },
          {
            id: 'call-digest',
            type: 'function',
            function: {
              name: 'digest_payload',
              arguments: JSON.stringify({ ok: true }),
            },
          },
          {
            id: 'call-array',
            type: 'function',
            function: {
              name: 'array_payload',
              arguments: JSON.stringify(['x', 'y']),
            },
          },
          {
            id: 'call-raw',
            type: 'function',
            function: {
              name: 'raw_payload',
              arguments: JSON.stringify({ raw: true }),
            },
          },
          {
            id: 'call-parts',
            type: 'function',
            function: {
              name: 'parts_payload',
              arguments: JSON.stringify({ parts: true }),
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call-digest',
        content: JSON.stringify({
          outcome: 'error',
          content: { reason: 'denied' },
          error: {
            code: 'DENIED',
            category: 'permission',
            retryable: false,
            message: 'Permission denied',
          },
          inputDigest: 'input-digest',
          outputDigest: 'output-digest',
        }),
      },
      {
        role: 'tool',
        tool_call_id: 'call-array',
        content: JSON.stringify(['fallback', 'array']),
      },
      {
        role: 'tool',
        tool_call_id: 'call-raw',
        content: 'plain text fallback',
      },
      {
        role: 'tool',
        tool_call_id: 'call-parts',
        content: [
          { type: 'text', text: 'line one' },
          { type: 'text', text: 'line two' },
        ],
      },
    ];

    const conversation = Reflect.apply(fromOpenAIMessages, undefined, [payload]);
    const messages = getOrderedMessages(conversation);
    const toolCalls = messages.filter((message) => message.role === 'tool-call');
    const toolResults = messages.filter((message) => message.role === 'tool-result');

    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'assistant',
      'tool-call',
      'tool-call',
      'tool-call',
      'tool-call',
      'tool-call',
      'tool-result',
      'tool-result',
      'tool-result',
      'tool-result',
    ]);
    expect(messages[0]?.content).toBe('');
    expect(messages[1]?.content).toBe('');
    expect(messages[2]?.content).toBe('Single text part');
    expect(messages[3]?.content).toEqual([
      { type: 'text', text: 'See this image' },
      { type: 'image', url: 'https://example.com/weather-map.png' },
    ]);
    expect(toolCalls[0]?.toolCall).toEqual({
      id: 'call-invalid',
      name: 'invalid_args',
      arguments: '{not-json',
    });
    expect(toolResults[0]?.toolResult).toMatchObject({
      callId: 'call-digest',
      outcome: 'error',
      content: { reason: 'denied' },
      inputDigest: 'input-digest',
      outputDigest: 'output-digest',
    });
    expect(toolResults[1]?.toolResult).toEqual({
      callId: 'call-array',
      outcome: 'success',
      content: ['fallback', 'array'],
    });
    expect(toolResults[2]?.toolResult).toEqual({
      callId: 'call-raw',
      outcome: 'success',
      content: 'plain text fallback',
    });
    expect(toolResults[3]?.toolResult).toEqual({
      callId: 'call-parts',
      outcome: 'success',
      content: 'line one\n\nline two',
    });
  });
});
