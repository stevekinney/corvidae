import { describe, expect, it } from 'bun:test';

import { fromAnthropicMessages } from '../src/adapters/anthropic/inbound';
import type { AnthropicConversation } from '../src/adapters/anthropic/types';
import type { Message } from '../src/types';

const getOrderedMessages = (messages: {
  ids: ReadonlyArray<string>;
  messages: Readonly<Record<string, Message>>;
}): Message[] =>
  messages.ids
    .map((id) => messages.messages[id])
    .filter((message): message is Message => Boolean(message));

function createAnthropicMultimodalPayload(): AnthropicConversation {
  return {
    system: 'System prompt',
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'image',
            source: {
              type: 'url',
              url: 'https://example.com/chart.png',
            },
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'YWJjMTIz',
            },
          },
          {
            type: 'tool_use',
            id: 'tool-array',
            name: 'complex_input',
            input: {
              nested: [1, { flag: true }],
              strange: Symbol('anthropic'),
              huge: BigInt(4),
              handler: () => 'ok',
            },
          },
          {
            type: 'tool_use',
            id: 'tool-fallback',
            name: 'fallback_input',
            input: ['x', { y: 2 }],
          },
          {
            type: 'tool_use',
            id: 'tool-raw',
            name: 'raw_input',
            input: { raw: true },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-array',
            content: JSON.stringify({
              outcome: 'action_required',
              content: { approval: true },
              action: { type: 'approval', message: 'Approve this tool call' },
              inputDigest: 'anthropic-input',
              outputDigest: 'anthropic-output',
            }),
          },
          {
            type: 'tool_result',
            tool_use_id: 'tool-fallback',
            content: JSON.stringify(['fallback', 'array']),
            is_error: true,
          },
          {
            type: 'tool_result',
            tool_use_id: 'tool-raw',
            content: 'plain text fallback',
          },
          { type: 'text', text: 'Please continue.' },
        ],
      },
    ],
  };
}

function assertAnthropicMultimodalConversion(
  conversation: ReturnType<typeof fromAnthropicMessages>,
): void {
  const messages = getOrderedMessages(conversation);
  const toolCalls = messages.filter((message) => message.role === 'tool-call');
  expect(messages.map((message) => message.role)).toEqual([
    'system',
    'assistant',
    'tool-call',
    'tool-call',
    'tool-call',
    'tool-result',
    'tool-result',
    'tool-result',
    'user',
  ]);
  expect(messages[1]?.content).toEqual([
    { type: 'image', url: 'https://example.com/chart.png' },
    { type: 'image', url: 'data:image/png;base64,YWJjMTIz', mimeType: 'image/png' },
  ]);
  expect(toolCalls[0]?.toolCall).toMatchObject({
    id: 'tool-array',
    name: 'complex_input',
    arguments: { nested: [1, { flag: true }], strange: 'Symbol(anthropic)', huge: '4' },
  });
  const firstToolCall = toolCalls[0]?.toolCall;
  if (
    !firstToolCall ||
    typeof firstToolCall.arguments !== 'object' ||
    firstToolCall.arguments === null
  )
    throw new Error('Expected object tool arguments');
  if (!('handler' in firstToolCall.arguments)) throw new Error('Expected handler argument');
  expect(typeof firstToolCall.arguments['handler']).toBe('string');
  assertAnthropicToolResults(conversation);
}

function assertAnthropicToolResults(conversation: ReturnType<typeof fromAnthropicMessages>): void {
  const messages = getOrderedMessages(conversation);
  const toolCalls = messages.filter((message) => message.role === 'tool-call');
  const toolResults = messages.filter((message) => message.role === 'tool-result');
  expect(toolCalls[1]?.toolCall).toEqual({
    id: 'tool-fallback',
    name: 'fallback_input',
    arguments: ['x', { y: 2 }],
  });
  expect(toolCalls[2]?.toolCall).toEqual({
    id: 'tool-raw',
    name: 'raw_input',
    arguments: { raw: true },
  });
  expect(toolResults[0]?.toolResult).toMatchObject({
    callId: 'tool-array',
    outcome: 'action_required',
    content: { approval: true },
    action: { type: 'approval', message: 'Approve this tool call' },
    inputDigest: 'anthropic-input',
    outputDigest: 'anthropic-output',
  });
  expect(toolResults[1]?.toolResult).toEqual({
    callId: 'tool-fallback',
    outcome: 'error',
    content: ['fallback', 'array'],
  });
  expect(toolResults[2]?.toolResult).toEqual({
    callId: 'tool-raw',
    outcome: 'success',
    content: 'plain text fallback',
  });
  expect(messages[8]?.content).toBe('Please continue.');
}

describe('Anthropic provider conversion', () => {
  it('reconstructs Anthropic mixed blocks in original order', () => {
    const conversation = fromAnthropicMessages({
      system: 'Top-level system prompt',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I need to call a tool.' },
            { type: 'tool_use', id: 'tool-1', name: 'lookup_weather', input: { city: 'Denver' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: JSON.stringify({
                outcome: 'error',
                content: { city: 'Denver' },
                error: {
                  code: 'TEMP_DOWN',
                  category: 'transient',
                  retryable: true,
                  message: 'Temporary outage',
                },
              }),
              is_error: true,
            },
            { type: 'text', text: 'Please try again.' },
          ],
        },
      ],
    });
    const messages = getOrderedMessages(conversation);
    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'assistant',
      'tool-call',
      'tool-result',
      'user',
    ]);
    expect(messages[1]?.content).toBe('I need to call a tool.');
    expect(messages[2]?.toolCall).toEqual({
      id: 'tool-1',
      name: 'lookup_weather',
      arguments: { city: 'Denver' },
    });
    expect(messages[3]?.toolResult).toMatchObject({
      callId: 'tool-1',
      outcome: 'error',
      content: { city: 'Denver' },
      error: {
        code: 'TEMP_DOWN',
        category: 'transient',
        retryable: true,
        message: 'Temporary outage',
      },
    });
    expect(messages[4]?.content).toBe('Please try again.');
  });
  it('reconstructs Anthropic multimodal and coerced tool payloads', () => {
    assertAnthropicMultimodalConversion(fromAnthropicMessages(createAnthropicMultimodalPayload()));
  });
});
