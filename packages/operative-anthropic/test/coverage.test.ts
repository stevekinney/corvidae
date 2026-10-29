import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import {
  type GenerateContext,
  type StreamingHandle,
  ProviderError,
  ToolCallParseError,
} from '@lostgradient/operative/provider-kit';
import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { toAnthropicToolChoice } from '../src/anthropic-tool-choice.ts';
import type {
  AnthropicMessageCreateRequest,
  AnthropicStreamEvent,
  AnthropicStreamingClient,
} from '../src/anthropic-types.ts';
import { createAnthropicProvider, createAnthropicProviderStream } from '../src/anthropic.ts';
import {
  anthropicMixedResponse,
  anthropicNoUsageResponse,
  anthropicStreamEmptyEvents,
  anthropicStreamMixedEvents,
  anthropicStreamMultiToolEvents,
  anthropicStreamTextEvents,
  anthropicStreamToolUseEvents,
  anthropicTextResponse,
  anthropicToolUseResponse,
} from '../src/test/anthropic-fixtures.ts';
import {
  createMockAnthropicClient,
  createMockAnthropicStreamingClient,
} from '../src/test/anthropic-mock-clients.ts';

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
  it('adapts every supported tool choice shape', () => {
    expect(toAnthropicToolChoice('auto')).toEqual({ type: 'auto' });
    expect(toAnthropicToolChoice('required')).toEqual({ type: 'any' });
    expect(toAnthropicToolChoice('none')).toBeUndefined();
    expect(toAnthropicToolChoice({ tool: 'get_weather' })).toEqual({
      type: 'tool',
      name: 'get_weather',
    });
  });

  it('mock clients fail loudly when queued responses are exhausted', async () => {
    expect(
      await throwingRejectionOf(
        createMockAnthropicClient([]).messages.create({} as AnthropicMessageCreateRequest),
      ),
    ).toThrow('MockAnthropicClient: no response at index 0');
  });

  it('streaming mock clients can fail after yielding part of a stream', async () => {
    const anthropicStream = await createMockAnthropicStreamingClient(
      [anthropicStreamTextEvents],
      [new Error('anthropic stream failed')],
      { errorAfterEvents: 1 },
    ).messages.create({} as AnthropicMessageCreateRequest);
    expect(
      await throwingRejectionOf(
        (async () => {
          for await (const _event of anthropicStream) {
            // consume until the configured error fires
          }
        })(),
      ),
    ).toThrow('anthropic stream failed');
  });

  it('streaming mock clients throw after a short stream when the error threshold is beyond the stream length', async () => {
    const anthropicStream = await createMockAnthropicStreamingClient(
      [[]],
      [new Error('anthropic late failure')],
      { errorAfterEvents: 1 },
    ).messages.create({} as AnthropicMessageCreateRequest);
    expect(
      await throwingRejectionOf(
        (async () => {
          for await (const _event of anthropicStream) {
            // consume until the configured error fires
          }
        })(),
      ),
    ).toThrow('anthropic late failure');
  });
});

describe('Anthropic provider coverage', () => {
  it('maps text, tool calls, usage fallbacks, request options, and errors', async () => {
    const client = createMockAnthropicClient([
      anthropicTextResponse,
      anthropicToolUseResponse,
      anthropicMixedResponse,
      anthropicNoUsageResponse,
      {
        content: [{ type: 'text' }],
        usage: { input_tokens: 3 },
      },
      {
        content: [{ type: 'text', text: 'No cache activity.' }],
        // A real Anthropic response reports these as `null`, not merely
        // omitted, when there was no cache activity — see
        // `buildAnthropicUsage`'s doc comment.
        usage: {
          input_tokens: 7,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
    ]);
    const generate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client,
      maximumTokens: 200,
      temperature: 0.1,
      topP: 0.8,
      stopSequences: ['END'],
      toolChoice: { tool: 'get_weather' },
    });

    expect(await generate(makeContext())).toMatchObject({
      content: 'Hello from Anthropic!',
      usage: { prompt: 10, completion: 5, total: 15 },
    });
    const anthropicToolCallResponse = await generate(makeContext());
    expect(anthropicToolCallResponse.toolCalls).toEqual([
      { id: 'toolu_01', name: 'get_weather', arguments: { location: 'San Francisco' } },
    ]);
    expect(await generate(makeContext())).toMatchObject({
      content: 'Let me check the weather.',
      usage: { prompt: 20, completion: 25, total: 45 },
    });
    const anthropicResponseWithoutUsage = await generate(makeContext());
    expect(anthropicResponseWithoutUsage.usage).toBeUndefined();
    expect(await generate(makeContext())).toMatchObject({
      content: '',
      usage: { prompt: 3, completion: 0, total: 3 },
    });
    const anthropicResponseWithNullCacheTokens = await generate(makeContext());
    expect(anthropicResponseWithNullCacheTokens.usage).toEqual({
      prompt: 7,
      completion: 0,
      total: 7,
    });
    expect(anthropicResponseWithNullCacheTokens.usage).not.toHaveProperty('cacheCreationTokens');
    expect(anthropicResponseWithNullCacheTokens.usage).not.toHaveProperty('cacheReadTokens');

    expect(client._calls[0]).toMatchObject({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 200,
      temperature: 0.1,
      top_p: 0.8,
      stop_sequences: ['END'],
      tool_choice: { type: 'tool', name: 'get_weather' },
    });

    const noToolsClient = createMockAnthropicClient([anthropicTextResponse]);
    const noToolsGenerate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client: noToolsClient,
      toolChoice: 'none',
    });
    await noToolsGenerate(makeContext());
    expect(noToolsClient._calls[0]?.['tools']).toBeUndefined();

    const failingClient = createMockAnthropicClient([], [new Error('Anthropic failed')]);
    const failingGenerate = createAnthropicProvider({
      model: 'claude-3-5-sonnet-20241022',
      client: failingClient,
    });
    expect(await rejectionOf(failingGenerate(makeContext()))).toMatchObject({
      provider: 'anthropic',
    });
  });

  it('streams text, tool calls, empty responses, usage fallbacks, aborts, and errors', async () => {
    const client = createMockAnthropicStreamingClient([
      anthropicStreamTextEvents,
      anthropicStreamToolUseEvents,
      anthropicStreamMixedEvents,
      anthropicStreamEmptyEvents,
      [{ type: 'message_start' }, { type: 'message_delta' }, { type: 'message_stop' }],
      anthropicStreamMultiToolEvents,
      [
        {
          type: 'message_start',
          // A real Anthropic response reports these as `null`, not merely
          // omitted, when there was no cache activity — see the streaming
          // usage accumulator's doc comment in providers/anthropic.ts.
          message: {
            usage: {
              input_tokens: 9,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
            },
          },
        },
        { type: 'message_delta' },
        { type: 'message_stop' },
      ],
    ]);
    const generate = createAnthropicProviderStream({
      model: 'claude-3-5-sonnet-20241022',
      client,
      toolChoice: 'required',
    });

    const textUpdates: string[] = [];
    expect(
      await generate({ ...makeContext(), streaming: makeStreamingHandle(textUpdates) }),
    ).toMatchObject({
      content: 'Hello from Anthropic!',
      usage: { prompt: 10, completion: 5, total: 15 },
    });
    expect(textUpdates).toEqual(['Hello ', 'Hello from Anthropic!']);

    const anthropicStreamingToolCallResponse = await generate({
      ...makeContext(),
      streaming: makeStreamingHandle(),
    });
    expect(anthropicStreamingToolCallResponse.toolCalls).toEqual([
      { id: 'toolu_01', name: 'get_weather', arguments: { location: 'San Francisco' } },
    ]);
    expect(await generate({ ...makeContext(), streaming: makeStreamingHandle() })).toMatchObject({
      content: 'Let me check.',
      toolCalls: [
        { id: 'toolu_mixed_01', name: 'get_weather', arguments: { location: 'New York' } },
      ],
    });
    expect(await generate({ ...makeContext(), streaming: makeStreamingHandle() })).toMatchObject({
      content: '',
      usage: { prompt: 5, completion: 0, total: 5 },
    });
    const anthropicStreamingResponseWithoutUsage = await generate({
      ...makeContext(),
      streaming: makeStreamingHandle(),
    });
    expect(anthropicStreamingResponseWithoutUsage.usage).toBeUndefined();
    const anthropicStreamingMultipleToolCallResponse = await generate({
      ...makeContext(),
      streaming: makeStreamingHandle(),
    });
    expect(anthropicStreamingMultipleToolCallResponse.toolCalls).toEqual([
      { id: 'toolu_multi_01', name: 'get_weather', arguments: { location: 'Paris' } },
      { id: 'toolu_multi_02', name: 'get_weather', arguments: { location: 'London' } },
    ]);
    const anthropicStreamingResponseWithNullCacheTokens = await generate({
      ...makeContext(),
      streaming: makeStreamingHandle(),
    });
    expect(anthropicStreamingResponseWithNullCacheTokens.usage).toEqual({
      prompt: 9,
      completion: 0,
      total: 9,
    });
    expect(anthropicStreamingResponseWithNullCacheTokens.usage).not.toHaveProperty(
      'cacheCreationTokens',
    );
    expect(anthropicStreamingResponseWithNullCacheTokens.usage).not.toHaveProperty(
      'cacheReadTokens',
    );

    const abortController = new AbortController();
    abortController.abort();
    const abortedClient = createMockAnthropicStreamingClient([anthropicStreamTextEvents]);
    const abortedGenerate = createAnthropicProviderStream({
      model: 'claude-3-5-sonnet-20241022',
      client: abortedClient,
    });
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
      metadata: { effectiveModel: 'claude-3-5-sonnet-20241022', effectiveEffort: 'none' },
    });

    const failingClient = createMockAnthropicStreamingClient(
      [],
      [new Error('Anthropic stream failed')],
    );
    const failingGenerate = createAnthropicProviderStream({
      model: 'claude-3-5-sonnet-20241022',
      client: failingClient,
    });
    expect(
      await rejectionOf(failingGenerate({ ...makeContext(), streaming: makeStreamingHandle() })),
    ).toMatchObject({ provider: 'anthropic' });
  });

  it('surfaces malformed streamed tool-call JSON as a distinct ToolCallParseError, not a generic ProviderError', async () => {
    const malformedToolUseEvents: AnthropicStreamEvent[] = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_bad_01', name: 'roll_dice' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"sides": 2' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ];
    const client = createMockAnthropicStreamingClient([malformedToolUseEvents]);
    const generate = createAnthropicProviderStream({
      model: 'claude-3-5-sonnet-20241022',
      client,
    });

    let caught: unknown;
    try {
      await generate({ ...makeContext(), streaming: makeStreamingHandle() });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ToolCallParseError);
    expect(caught).toBeInstanceOf(ProviderError);
    const parseError = caught as ToolCallParseError;
    expect(parseError.provider).toBe('anthropic');
    expect(parseError.toolName).toBe('roll_dice');
    expect(parseError.toolCallId).toBe('toolu_bad_01');
    expect(parseError.rawArguments).toBe('{"sides": 2');
    expect(parseError.retryable).toBe(false);
  });

  it('does not treat an aborted mid-stream tool call as malformed model output', async () => {
    const abortController = new AbortController();
    const client: AnthropicStreamingClient = {
      messages: {
        async *create() {
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_aborted_01', name: 'roll_dice' },
          };
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"sides": 2' },
          };
          // The caller cancels between chunks — the accumulated partial JSON
          // is truncated by cancellation, not by the model.
          abortController.abort();
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '}' },
          };
          yield { type: 'content_block_stop', index: 0 };
          yield { type: 'message_stop' };
        },
      },
    };
    const generate = createAnthropicProviderStream({
      model: 'claude-3-5-sonnet-20241022',
      client,
    });

    const result = await generate({
      ...makeContext({ signal: abortController.signal }),
      streaming: makeStreamingHandle(),
    });

    expect(result.toolCalls).toEqual([]);
  });
});
