import { describe, expect, it } from 'bun:test';

import { fromGeminiMessages } from '../src/adapters/gemini/inbound';
import type { Message } from '../src/types';

const getOrderedMessages = (messages: {
  ids: ReadonlyArray<string>;
  messages: Readonly<Record<string, Message>>;
}): Message[] =>
  messages.ids
    .map((id) => messages.messages[id])
    .filter((message): message is Message => Boolean(message));

function createGeminiMultimodalPayload(): unknown {
  return {
    systemInstruction: {
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'image/png',
            data: 'c3lzdGVtLWltYWdl',
          },
        },
        {
          fileData: {
            fileUri: 'gs://bucket/system-reference.png',
            mimeType: 'image/png',
          },
        },
      ],
    },
    contents: [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'unwrap_value',
              args: { _value: [1, { ok: true }] },
            },
          },
          {
            functionCall: {
              name: 'raw_args',
              args: { _raw: 'not-json' },
            },
          },
          {
            functionCall: {
              name: 'stringified',
              args: {
                weird: BigInt(5),
                nested: [Symbol('gemini')],
              },
            },
          },
          {
            functionCall: {
              name: 'array_response',
              args: {},
            },
          },
          { text: 'hello from model' },
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: 'bW9kZWwtaW1hZ2U=',
            },
          },
          {
            fileData: {
              fileUri: 'gs://bucket/model-reference.jpg',
              mimeType: 'image/jpeg',
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'unwrap_value',
              response: {
                outcome: 'action_required',
                content: { approval: true },
                action: { type: 'input', message: 'Provide confirmation' },
                inputDigest: 'gemini-input',
                outputDigest: 'gemini-output',
              },
            },
          },
          {
            functionResponse: {
              name: 'raw_args',
              response: { result: ['ok'] },
            },
          },
          {
            functionResponse: {
              name: 'stringified',
              response: {
                status: 'done',
                weird: BigInt(7),
              },
            },
          },
          {
            functionResponse: {
              name: 'array_response',
              response: ['not', 'canonical'],
            },
          },
          { text: 'thanks' },
        ],
      },
    ],
  };
}

function assertGeminiMultimodalConversion(
  conversation: ReturnType<typeof fromGeminiMessages>,
): void {
  const messages = getOrderedMessages(conversation);
  const toolCalls = messages.filter((message) => message.role === 'tool-call');
  expect(messages.map((message) => message.role)).toEqual([
    'system',
    'tool-call',
    'tool-call',
    'tool-call',
    'tool-call',
    'assistant',
    'assistant',
    'assistant',
    'tool-result',
    'tool-result',
    'tool-result',
    'tool-result',
    'user',
  ]);
  expect(messages[0]?.content).toEqual([
    {
      type: 'image',
      source: { kind: 'inline', data: 'c3lzdGVtLWltYWdl', encoding: 'base64' },
      mimeType: 'image/png',
    },
    {
      type: 'image',
      source: {
        kind: 'provider-file',
        provider: 'gemini',
        providerFileId: 'gs://bucket/system-reference.png',
      },
      mimeType: 'image/png',
    },
  ]);
  expect(toolCalls[0]?.toolCall).toEqual({
    id: 'gemini-call-1',
    name: 'unwrap_value',
    arguments: [1, { ok: true }],
  });
  expect(toolCalls[1]?.toolCall).toEqual({
    id: 'gemini-call-2',
    name: 'raw_args',
    arguments: 'not-json',
  });
  expect(toolCalls[2]?.toolCall).toEqual({
    id: 'gemini-call-3',
    name: 'stringified',
    arguments: { weird: '5', nested: ['Symbol(gemini)'] },
  });
  assertGeminiToolResults(conversation);
}

function assertGeminiToolResults(conversation: ReturnType<typeof fromGeminiMessages>): void {
  const messages = getOrderedMessages(conversation);
  const toolCalls = messages.filter((message) => message.role === 'tool-call');
  const toolResults = messages.filter((message) => message.role === 'tool-result');
  expect(toolCalls[3]?.toolCall).toEqual({
    id: 'gemini-call-4',
    name: 'array_response',
    arguments: {},
  });
  expect(messages[5]?.content).toBe('hello from model');
  expect(messages[6]?.content).toEqual([
    {
      type: 'image',
      source: { kind: 'inline', data: 'bW9kZWwtaW1hZ2U=', encoding: 'base64' },
      mimeType: 'image/jpeg',
    },
  ]);
  expect(messages[7]?.content).toEqual([
    {
      type: 'image',
      source: {
        kind: 'provider-file',
        provider: 'gemini',
        providerFileId: 'gs://bucket/model-reference.jpg',
      },
      mimeType: 'image/jpeg',
    },
  ]);
  expect(toolResults[0]?.toolResult).toMatchObject({
    callId: 'gemini-call-1',
    outcome: 'action_required',
    content: { approval: true },
    action: { type: 'input', message: 'Provide confirmation' },
    inputDigest: 'gemini-input',
    outputDigest: 'gemini-output',
  });
  expect(toolResults[1]?.toolResult).toEqual({
    callId: 'gemini-call-2',
    outcome: 'success',
    content: ['ok'],
  });
  expect(toolResults[2]?.toolResult).toEqual({
    callId: 'gemini-call-3',
    outcome: 'success',
    content: { status: 'done', weird: '7' },
  });
  expect(toolResults[3]?.toolResult).toEqual({
    callId: 'gemini-call-4',
    outcome: 'success',
    content: ['not', 'canonical'],
  });
  expect(messages[12]?.content).toBe('thanks');
}

describe('Gemini provider conversion', () => {
  it('reconstructs Gemini function calls and pairs synthetic call IDs', () => {
    const conversation = fromGeminiMessages({
      systemInstruction: { role: 'user', parts: [{ text: 'You are helpful.' }] },
      contents: [
        {
          role: 'model',
          parts: [
            { text: 'Checking the weather.' },
            { functionCall: { name: 'lookup_weather', args: { city: 'Denver' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'lookup_weather',
                response: { result: { forecast: 'sunny' } },
              },
            },
            { text: 'Thanks!' },
          ],
        },
      ],
    });
    const messages = getOrderedMessages(conversation);
    const toolCall = messages.find((message) => message.role === 'tool-call');
    const toolResult = messages.find((message) => message.role === 'tool-result');
    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'assistant',
      'tool-call',
      'tool-result',
      'user',
    ]);
    expect(toolCall?.toolCall?.id).toMatch(/^gemini-call-\d+$/);
    expect(toolCall?.toolCall?.arguments).toEqual({ city: 'Denver' });
    expect(toolResult?.toolResult).toMatchObject({
      callId: toolCall?.toolCall?.id,
      outcome: 'success',
      content: { forecast: 'sunny' },
    });
  });
  it('reconstructs Gemini multimodal payloads, wrappers, and orphan responses', () => {
    assertGeminiMultimodalConversion(
      Reflect.apply(fromGeminiMessages, undefined, [createGeminiMultimodalPayload()]),
    );
  });
});
