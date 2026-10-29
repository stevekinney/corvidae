import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import type { GenerateContext, StreamingHandle } from '@lostgradient/operative/provider-kit';
import { rejectionOf, throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { toGeminiResponseFormat } from '../src/gemini-response-format.ts';
import { toGeminiToolChoice } from '../src/gemini-tool-choice.ts';
import type { GeminiGenerateContentRequest } from '../src/gemini-types.ts';
import { createGeminiProvider, createGeminiProviderStream } from '../src/gemini.ts';
import {
  geminiFunctionCallResponse,
  geminiMixedResponse,
  geminiNoUsageResponse,
  geminiStreamEmptyChunks,
  geminiStreamFunctionCallChunks,
  geminiStreamMixedChunks,
  geminiStreamMultiFunctionCallChunks,
  geminiStreamTextChunks,
  geminiTextResponse,
} from '../src/test/gemini-fixtures.ts';
import {
  createMockGeminiModel,
  createMockGeminiStreamingModel,
} from '../src/test/gemini-mock-clients.ts';

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
  it('adapts Gemini response formats', () => {
    expect(toGeminiResponseFormat({ type: 'text' })).toBeUndefined();
    expect(toGeminiResponseFormat({ type: 'json' })).toEqual({
      responseMimeType: 'application/json',
    });
    // `responseSchema` here is Gemini's OWN `GenerationConfig` field name
    // (unrelated to AB-18's `RunOptions.output`/`responseSchema` rename) —
    // this asserts the shape `toGeminiResponseFormat` sends the SDK.
    expect(toGeminiResponseFormat({ type: 'json_schema', schema: { type: 'object' } })).toEqual({
      responseMimeType: 'application/json',
      responseSchema: { type: 'object' },
    });
  });

  it('adapts every supported tool choice shape', () => {
    expect(toGeminiToolChoice('auto')).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    expect(toGeminiToolChoice('required')).toEqual({ functionCallingConfig: { mode: 'ANY' } });
    expect(toGeminiToolChoice('none')).toEqual({ functionCallingConfig: { mode: 'NONE' } });
    expect(toGeminiToolChoice({ tool: 'get_weather' })).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
    });
  });

  it('mock clients fail loudly when queued responses are exhausted', async () => {
    expect(
      await throwingRejectionOf(
        createMockGeminiModel([]).models.generateContent({} as GeminiGenerateContentRequest),
      ),
    ).toThrow('MockGeminiModel: no response at index 0');
  });

  it('streaming mock clients can fail after yielding part of a stream', async () => {
    const geminiStream = await createMockGeminiStreamingModel(
      [geminiStreamTextChunks],
      [new Error('gemini stream failed')],
      { errorAfterEvents: 1 },
    ).models.generateContentStream({} as GeminiGenerateContentRequest);

    expect(
      await throwingRejectionOf(
        (async () => {
          for await (const _chunk of geminiStream) {
            // consume until the configured error fires
          }
        })(),
      ),
    ).toThrow('gemini stream failed');
  });

  it('streaming mock clients throw after a short stream when the error threshold is beyond the stream length', async () => {
    const geminiStream = await createMockGeminiStreamingModel(
      [[]],
      [new Error('gemini late failure')],
      { errorAfterEvents: 1 },
    ).models.generateContentStream({} as GeminiGenerateContentRequest);

    expect(
      await throwingRejectionOf(
        (async () => {
          for await (const _chunk of geminiStream) {
            // consume until the configured error fires
          }
        })(),
      ),
    ).toThrow('gemini late failure');
  });
});

describe('Gemini provider coverage', () => {
  it('maps text, function calls, usage fallbacks, request options, and errors', async () => {
    const client = createMockGeminiModel([
      geminiTextResponse,
      geminiFunctionCallResponse,
      geminiMixedResponse,
      geminiNoUsageResponse,
      {
        candidates: [{ content: {} }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
      },
    ]);
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
      maximumTokens: 200,
      temperature: 0.1,
      topP: 0.8,
      stopSequences: ['END'],
      toolChoice: { tool: 'get_weather' },
      responseFormat: { type: 'json' },
    });

    expect(await generate(makeContext())).toMatchObject({
      content: 'Hello from Gemini!',
      usage: { prompt: 10, completion: 5, total: 15 },
    });
    const geminiToolCallResponse = await generate(makeContext());
    expect(geminiToolCallResponse.toolCalls).toEqual([
      { name: 'get_weather', arguments: { location: 'San Francisco' } },
    ]);
    expect(await generate(makeContext())).toMatchObject({
      content: 'Let me check the weather.',
      usage: { prompt: 20, completion: 25, total: 45 },
    });
    const geminiResponseWithoutUsage = await generate(makeContext());
    expect(geminiResponseWithoutUsage.usage).toBeUndefined();
    expect(await generate(makeContext())).toMatchObject({
      content: '',
      usage: { prompt: 3, completion: 4, total: 7 },
    });

    // `@google/genai` takes the model per request and folds the tool config
    // and the former `generationConfig` fields into one flat `config` object.
    expect(client._calls[0]).toMatchObject({
      model: 'gemini-pro',
      contents: [],
      config: {
        toolConfig: {
          functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
        },
        maxOutputTokens: 200,
        temperature: 0.1,
        topP: 0.8,
        stopSequences: ['END'],
        responseMimeType: 'application/json',
      },
    });

    const failingClient = createMockGeminiModel([], [new Error('Gemini failed')]);
    const failingGenerate = createGeminiProvider({ model: 'gemini-pro', client: failingClient });
    expect(await rejectionOf(failingGenerate(makeContext()))).toMatchObject({ provider: 'gemini' });
  });

  it("falls back to the run's context.responseFormat when no construction-time responseFormat is set", async () => {
    const client = createMockGeminiModel([geminiTextResponse]);
    const generate = createGeminiProvider({ model: 'gemini-pro', client });

    await generate(makeContext({ responseFormat: { type: 'json' } }));

    expect(client._calls[0]).toMatchObject({
      config: { responseMimeType: 'application/json' },
    });
  });

  it('prefers an explicit construction-time responseFormat over context.responseFormat', async () => {
    const client = createMockGeminiModel([geminiTextResponse]);
    const generate = createGeminiProvider({
      model: 'gemini-pro',
      client,
      responseFormat: { type: 'json_schema', schema: { type: 'object' }, name: 'ctor' },
    });

    await generate(makeContext({ responseFormat: { type: 'json' } }));

    expect(client._calls[0]).toMatchObject({
      config: { responseMimeType: 'application/json', responseSchema: { type: 'object' } },
    });
  });

  it('streams text, function calls, empty responses, usage fallbacks, aborts, and errors', async () => {
    const client = createMockGeminiStreamingModel([
      geminiStreamTextChunks,
      geminiStreamFunctionCallChunks,
      geminiStreamMixedChunks,
      geminiStreamEmptyChunks,
      [
        {
          candidates: [{ content: {} }],
          usageMetadata: { promptTokenCount: 2 },
        },
      ],
      geminiStreamMultiFunctionCallChunks,
    ]);
    const generate = createGeminiProviderStream({
      model: 'gemini-pro',
      client,
      maximumTokens: 200,
      toolChoice: 'required',
      responseFormat: { type: 'json' },
    });

    const textUpdates: string[] = [];
    expect(
      await generate({ ...makeContext(), streaming: makeStreamingHandle(textUpdates) }),
    ).toMatchObject({
      content: 'Hello from Gemini!',
      usage: { prompt: 10, completion: 5, total: 15 },
    });
    expect(textUpdates).toEqual(['Hello ', 'Hello from Gemini!']);

    const geminiStreamingToolCallResponse = await generate({
      ...makeContext(),
      streaming: makeStreamingHandle(),
    });
    expect(geminiStreamingToolCallResponse.toolCalls).toEqual([
      { name: 'get_weather', arguments: { location: 'San Francisco' } },
    ]);
    expect(await generate({ ...makeContext(), streaming: makeStreamingHandle() })).toMatchObject({
      content: 'Checking weather...',
      toolCalls: [{ name: 'get_weather', arguments: { location: 'Tokyo' } }],
    });
    expect(await generate({ ...makeContext(), streaming: makeStreamingHandle() })).toMatchObject({
      content: '',
      usage: { prompt: 5, completion: 0, total: 5 },
    });
    expect(await generate({ ...makeContext(), streaming: makeStreamingHandle() })).toMatchObject({
      usage: { prompt: 2, completion: 0, total: 2 },
    });
    const geminiStreamingMultipleToolCallResponse = await generate({
      ...makeContext(),
      streaming: makeStreamingHandle(),
    });
    expect(geminiStreamingMultipleToolCallResponse.toolCalls).toEqual([
      { name: 'get_weather', arguments: { location: 'Paris' } },
      { name: 'get_weather', arguments: { location: 'London' } },
    ]);

    const abortController = new AbortController();
    abortController.abort();
    const abortedClient = createMockGeminiStreamingModel([geminiStreamTextChunks]);
    const abortedGenerate = createGeminiProviderStream({
      model: 'gemini-pro',
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
      metadata: { effectiveModel: 'gemini-pro', effectiveEffort: 'none' },
    });

    const failingClient = createMockGeminiStreamingModel([], [new Error('Gemini stream failed')]);
    const failingGenerate = createGeminiProviderStream({
      model: 'gemini-pro',
      client: failingClient,
    });
    expect(
      await rejectionOf(failingGenerate({ ...makeContext(), streaming: makeStreamingHandle() })),
    ).toMatchObject({ provider: 'gemini' });

    expect(client._calls[0]?.['model']).toBe('gemini-pro');
    expect(client._calls[0]?.['config']).toMatchObject({
      maxOutputTokens: 200,
      responseMimeType: 'application/json',
    });
  });
});
