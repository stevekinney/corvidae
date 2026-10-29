import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import type { GenerateContext, StreamingHandle } from '@lostgradient/operative/provider-kit';
import { ProviderError, ToolCallParseError } from '@lostgradient/operative/provider-kit';
import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { toOpenAIResponseFormat } from '../src/openai-response-format.ts';
import { toOpenAIToolChoice } from '../src/openai-tool-choice.ts';
import type {
  OpenAIChatCompletionCreateRequest,
  OpenAIStreamingClient,
} from '../src/openai-types.ts';
import { createOpenAIProvider, createOpenAIProviderStream } from '../src/openai.ts';
import {
  openAIMixedResponse,
  openAINoUsageResponse,
  openAIStreamEmptyChunks,
  openAIStreamMixedChunks,
  openAIStreamMultiToolChunks,
  openAIStreamTextChunks,
  openAIStreamToolCallChunks,
  openAITextResponse,
  openAIToolCallResponse,
} from '../src/test/openai-fixtures.ts';
import {
  createMockOpenAIClient,
  createMockOpenAIStreamingClient,
} from '../src/test/openai-mock-clients.ts';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ location }),
});

function makeContext(
  options: {
    maximumTokens?: number;
    signal?: AbortSignal;
    responseFormat?: GenerateContext['responseFormat'];
  } = {},
): GenerateContext {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createToolbox([weatherTool]),
    maximumTokens: options.maximumTokens,
    signal: options.signal,
    responseFormat: options.responseFormat,
  };
}

function makeStreamingHandle(updates: string[] = []): StreamingHandle {
  return {
    update: (text) => {
      updates.push(text);
    },
    messageId: 'test-message-id',
  };
}

describe('provider helper coverage', () => {
  it('adapts OpenAI response formats', () => {
    expect(toOpenAIResponseFormat({ type: 'text' })).toBeUndefined();
    expect(toOpenAIResponseFormat({ type: 'json' })).toEqual({ type: 'json_object' });
    expect(toOpenAIResponseFormat({ type: 'json_schema', schema: { type: 'object' } })).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema: { type: 'object' }, strict: false },
    });
    expect(
      toOpenAIResponseFormat({
        type: 'json_schema',
        name: 'answer',
        schema: { type: 'object' },
      }),
    ).toEqual({
      type: 'json_schema',
      json_schema: { name: 'answer', schema: { type: 'object' }, strict: false },
    });

    const strictSchema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    };
    expect(toOpenAIResponseFormat({ type: 'json_schema', schema: strictSchema })).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema: strictSchema, strict: true },
    });
  });

  it('adapts every supported tool choice shape', () => {
    expect(toOpenAIToolChoice('auto')).toBe('auto');
    expect(toOpenAIToolChoice('required')).toBe('required');
    expect(toOpenAIToolChoice('none')).toBe('none');
    expect(toOpenAIToolChoice({ tool: 'get_weather' })).toEqual({
      type: 'function',
      function: { name: 'get_weather' },
    });
  });

  it('mock clients fail loudly when queued responses are exhausted', async () => {
    expect(
      await throwingRejectionOf(
        createMockOpenAIClient([]).chat.completions.create({} as OpenAIChatCompletionCreateRequest),
      ),
    ).toThrow('MockOpenAIClient: no response at index 0');
  });

  it('streaming mock clients can fail after yielding part of a stream', async () => {
    const openAIStream = await createMockOpenAIStreamingClient(
      [openAIStreamTextChunks],
      [new Error('openai stream failed')],
      { errorAfterEvents: 1 },
    ).chat.completions.create({} as OpenAIChatCompletionCreateRequest);
    expect(
      await throwingRejectionOf(
        (async () => {
          for await (const _chunk of openAIStream) {
            // consume until the configured error fires
          }
        })(),
      ),
    ).toThrow('openai stream failed');
  });

  it('streaming mock clients throw after a short stream when the error threshold is beyond the stream length', async () => {
    const openAIStream = await createMockOpenAIStreamingClient(
      [[]],
      [new Error('openai late failure')],
      { errorAfterEvents: 1 },
    ).chat.completions.create({} as OpenAIChatCompletionCreateRequest);
    expect(
      await throwingRejectionOf(
        (async () => {
          for await (const _chunk of openAIStream) {
            // consume until the configured error fires
          }
        })(),
      ),
    ).toThrow('openai late failure');
  });
});

describe('OpenAI provider coverage', () => {
  it('maps text, tool calls, usage fallbacks, request options, and errors', async () => {
    const client = createMockOpenAIClient([
      openAITextResponse,
      openAIToolCallResponse,
      openAIMixedResponse,
      openAINoUsageResponse,
      {
        choices: [{ message: { content: undefined }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      },
    ]);
    const generate = createOpenAIProvider({
      model: 'gpt-4o',
      client,
      maximumTokens: 200,
      temperature: 0.1,
      topP: 0.8,
      stopSequences: ['END'],
      toolChoice: { tool: 'get_weather' },
      responseFormat: { type: 'json' },
    });

    expect(await generate(makeContext())).toMatchObject({
      content: 'Hello from OpenAI!',
      usage: { prompt: 10, completion: 5, total: 15 },
    });
    const generatedOpenAIToolCallResponse = await generate(makeContext());
    expect(generatedOpenAIToolCallResponse.toolCalls).toEqual([
      { id: 'call_01', name: 'get_weather', arguments: { location: 'San Francisco' } },
    ]);
    expect(await generate(makeContext())).toMatchObject({
      content: 'Let me check the weather.',
      usage: { prompt: 20, completion: 25, total: 45 },
    });
    const openAIResponseWithoutUsage = await generate(makeContext());
    expect(openAIResponseWithoutUsage.usage).toBeUndefined();
    expect(await generate(makeContext())).toMatchObject({
      content: '',
      usage: { prompt: 3, completion: 4, total: 7 },
    });

    expect(client._calls[0]).toMatchObject({
      model: 'gpt-4o',
      max_tokens: 200,
      temperature: 0.1,
      top_p: 0.8,
      stop: ['END'],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      response_format: { type: 'json_object' },
    });

    const failingClient = createMockOpenAIClient([], [new Error('OpenAI failed')]);
    const failingGenerate = createOpenAIProvider({ model: 'gpt-4o', client: failingClient });
    expect(await rejectionOf(failingGenerate(makeContext()))).toMatchObject({ provider: 'openai' });
  });

  it('rejects a custom tool call with a defined ProviderError', async () => {
    const client = createMockOpenAIClient([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: 'call_custom_01', type: 'custom', custom: { name: 'tool', input: 'x' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]);
    const generate = createOpenAIProvider({ model: 'gpt-4o', client });

    const error = await rejectionOf(generate(makeContext()));

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      provider: 'openai',
      message:
        '[provider:openai] OpenAI returned a custom tool call (id "call_custom_01"); only function tool calls are supported',
      retryable: false,
    });
    const cause = (error as ProviderError).cause;
    expect(cause).toBeInstanceOf(Error);
    expect(cause).not.toBeInstanceOf(TypeError);
  });

  it("falls back to the run's context.responseFormat when no construction-time responseFormat is set", async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({ model: 'gpt-4o', client });

    await generate(makeContext({ responseFormat: { type: 'json' } }));

    expect(client._calls[0]).toMatchObject({ response_format: { type: 'json_object' } });
  });

  it('prefers an explicit construction-time responseFormat over context.responseFormat', async () => {
    const client = createMockOpenAIClient([openAITextResponse]);
    const generate = createOpenAIProvider({
      model: 'gpt-4o',
      client,
      responseFormat: { type: 'json' },
    });

    await generate(
      makeContext({
        responseFormat: { type: 'json_schema', schema: { type: 'object' }, name: 'other' },
      }),
    );

    expect(client._calls[0]).toMatchObject({ response_format: { type: 'json_object' } });
  });

  it('streams text, tool calls, empty responses, usage fallbacks, aborts, and errors', async () => {
    const client = createMockOpenAIStreamingClient([
      openAIStreamTextChunks,
      openAIStreamToolCallChunks,
      openAIStreamMixedChunks,
      openAIStreamEmptyChunks,
      [
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: null },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2 } },
      ],
      openAIStreamMultiToolChunks,
    ]);
    const generate = createOpenAIProviderStream({
      model: 'gpt-4o',
      client,
      toolChoice: 'required',
      responseFormat: { type: 'text' },
    });

    const textUpdates: string[] = [];
    expect(
      await generate({ ...makeContext(), streaming: makeStreamingHandle(textUpdates) }),
    ).toMatchObject({
      content: 'Hello from OpenAI!',
      usage: { prompt: 10, completion: 5, total: 15 },
    });
    expect(textUpdates).toEqual(['Hello ', 'Hello from OpenAI!']);

    const openAIStreamingToolCallResponse = await generate({
      ...makeContext(),
      streaming: makeStreamingHandle(),
    });
    expect(openAIStreamingToolCallResponse.toolCalls).toEqual([
      { id: 'call_01', name: 'get_weather', arguments: { location: 'San Francisco' } },
    ]);

    expect(await generate({ ...makeContext(), streaming: makeStreamingHandle() })).toMatchObject({
      content: 'Checking weather.',
      toolCalls: [{ id: 'call_mixed_01', name: 'get_weather', arguments: { location: 'NYC' } }],
    });
    expect(await generate({ ...makeContext(), streaming: makeStreamingHandle() })).toMatchObject({
      content: '',
      usage: { prompt: 5, completion: 0, total: 5 },
    });
    expect(await generate({ ...makeContext(), streaming: makeStreamingHandle() })).toMatchObject({
      usage: { prompt: 2, completion: 0, total: 2 },
    });
    const openAIStreamingMultipleToolCallResponse = await generate({
      ...makeContext(),
      streaming: makeStreamingHandle(),
    });
    expect(openAIStreamingMultipleToolCallResponse.toolCalls).toEqual([
      { id: 'call_multi_01', name: 'get_weather', arguments: { location: 'Paris' } },
      { id: 'call_multi_02', name: 'get_weather', arguments: { location: 'London' } },
    ]);

    const abortController = new AbortController();
    abortController.abort();
    const abortedClient = createMockOpenAIStreamingClient([openAIStreamTextChunks]);
    const abortedGenerate = createOpenAIProviderStream({ model: 'gpt-4o', client: abortedClient });
    expect(
      await abortedGenerate({
        ...makeContext({ signal: abortController.signal }),
        streaming: makeStreamingHandle(),
      }),
    ).toEqual({
      content: '',
      parts: [],
      toolCalls: [],
      usage: undefined,
      metadata: { effectiveModel: 'gpt-4o', effectiveEffort: 'none' },
    });

    const failingClient = createMockOpenAIStreamingClient([], [new Error('OpenAI stream failed')]);
    const failingGenerate = createOpenAIProviderStream({ model: 'gpt-4o', client: failingClient });
    expect(
      await rejectionOf(failingGenerate({ ...makeContext(), streaming: makeStreamingHandle() })),
    ).toMatchObject({ provider: 'openai' });
  });

  it('surfaces malformed streamed tool-call JSON as a distinct ToolCallParseError, not a generic ProviderError', async () => {
    const malformedToolCallChunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_bad_01',
                  type: 'function' as const,
                  function: { name: 'roll_dice', arguments: '{"sides": 2' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
        usage: null,
      },
    ];
    const client = createMockOpenAIStreamingClient([malformedToolCallChunks]);
    const generate = createOpenAIProviderStream({ model: 'gpt-4o', client });

    let caught: unknown;
    try {
      await generate({ ...makeContext(), streaming: makeStreamingHandle() });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ToolCallParseError);
    expect(caught).toBeInstanceOf(ProviderError);
    const parseError = caught as ToolCallParseError;
    expect(parseError.provider).toBe('openai');
    expect(parseError.toolName).toBe('roll_dice');
    expect(parseError.toolCallId).toBe('call_bad_01');
    expect(parseError.rawArguments).toBe('{"sides": 2');
    expect(parseError.retryable).toBe(false);
  });

  it('does not treat an aborted mid-stream tool call as malformed model output', async () => {
    const abortController = new AbortController();
    const client: OpenAIStreamingClient = {
      chat: {
        completions: {
          async *create() {
            yield {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_aborted_01',
                        type: 'function',
                        function: { name: 'roll_dice', arguments: '{"sides": 2' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
              usage: null,
            };
            // The caller cancels between chunks — the accumulated arguments
            // fragment is truncated by cancellation, not by the model.
            abortController.abort();
            yield {
              choices: [
                {
                  delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] },
                  finish_reason: null,
                },
              ],
              usage: null,
            };
          },
        },
      },
    };
    const generate = createOpenAIProviderStream({ model: 'gpt-4o', client });

    const result = await generate({
      ...makeContext({ signal: abortController.signal }),
      streaming: makeStreamingHandle(),
    });

    expect(result.toolCalls).toEqual([]);
  });
});
