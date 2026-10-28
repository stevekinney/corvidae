import { HookRegistry } from '@lostgradient/lifecycle';
import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import { GeneratedMediaNotAdmittedError } from '../src/errors';
import { createStepGeneratedMediaAdmitter } from '../src/generated-media';
import type { OperativeHookMap } from '../src/hooks';
import {
  readBackendDescriptors,
  withBackendDescriptors,
} from '../src/providers/backend-descriptor-attachment';
import { createModelCatalog } from '../src/providers/model-catalog';
import { withStreaming } from '../src/streaming';
import { withEnhancedStreaming } from '../src/streaming/enhanced-streaming';
import { createScriptedMediaAdmitter } from '../src/testing/generated-media.test-support';
import type { GenerateContext, GenerateResponse, StreamingGenerateFunction } from '../src/types';
const run = (options: Parameters<typeof createActiveRun>[0]) => createActiveRun(options).result;

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function createWeatherToolbox() {
  return createTestToolbox([weatherTool]);
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

describe('withStreaming', () => {
  it('creates, updates, and finalizes a streaming message', async () => {
    const conversation = new Conversation();
    const toolbox = createWeatherToolbox();

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Hel');
      streaming.update('Hello');
      streaming.update('Hello, world!');
      return textResponse('Hello, world!');
    };

    const generate = withStreaming(streamingGenerate);

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.content).toBe('Hello, world!');

    const messages = result.conversation.getMessages();
    const assistantMessages = messages.filter((message) => message.role === 'assistant');
    expect(assistantMessages.length).toBe(1);

    // The streaming message should be finalized (not still streaming)
    const streamingMessage = result.conversation.getStreamingMessage();
    expect(streamingMessage).toBeUndefined();
  });

  it('cancels the streaming message on error', async () => {
    const conversation = new Conversation();

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Partial content...');
      throw new Error('LLM connection lost');
    };

    const generate = withStreaming(streamingGenerate);

    expect(
      await throwingRejectionOf(generate({ conversation, step: 0, toolbox: {} as any })),
    ).toThrow('LLM connection lost');

    // The streaming message should not be left hanging
    const streamingMessage = conversation.getStreamingMessage();
    expect(streamingMessage).toBeUndefined();
  });

  it('works in a full run loop', async () => {
    const conversation = new Conversation();
    const toolbox = createWeatherToolbox();

    let callCount = 0;
    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      callCount++;
      if (callCount === 1) {
        streaming.update('Checking...');
        return {
          content: 'Checking weather...',
          toolCalls: [{ name: 'get_weather', arguments: { location: 'Denver' } }],
        };
      }
      streaming.update('The weather is nice.');
      return textResponse('The weather is nice.');
    };

    const generate = withStreaming(streamingGenerate);

    const result = await run({
      generate,
      toolbox,
      conversation,
      stopWhen: noToolCalls(),
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(result.steps).toHaveLength(2);
    expect(result.content).toBe('The weather is nice.');
  });

  it('propagates the wrapped function’s attached BackendDescriptor(s) (AB-64, AB-245)', () => {
    const descriptor = createModelCatalog().descriptors.find((d) => d.provider === 'anthropic');
    if (!descriptor) throw new Error('expected at least one anthropic seed descriptor');
    const streamingGenerate: StreamingGenerateFunction = withBackendDescriptors(
      async ({ streaming }) => {
        streaming.update('hi');
        return textResponse('hi');
      },
      [descriptor],
    );

    const generate = withStreaming(streamingGenerate);

    expect(readBackendDescriptors(generate)).toEqual([descriptor]);
  });

  it('reports no descriptors when the wrapped function carries none', () => {
    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('hi');
      return textResponse('hi');
    };

    const generate = withStreaming(streamingGenerate);

    expect(readBackendDescriptors(generate)).toEqual([]);
  });
});

const thinkingPart = { type: 'thinking', thinking: 'Plan the call.', signature: 'sig-1' } as const;
const inlineImage = {
  type: 'image',
  mimeType: 'image/png',
  source: { kind: 'inline', data: 'AAAAUNIQUEBYTES', encoding: 'base64' },
} as const;

const wrappers: ReadonlyArray<
  readonly [string, (fn: StreamingGenerateFunction) => ReturnType<typeof withStreaming>]
> = [
  ['withStreaming', (fn) => withStreaming(fn)],
  ['withEnhancedStreaming', (fn) => withEnhancedStreaming(fn)],
];

function streamingContext(
  conversation: Conversation,
  admitter?: ReturnType<typeof createScriptedMediaAdmitter>,
  controller = new AbortController(),
): GenerateContext {
  return {
    conversation,
    step: 0,
    toolbox: createWeatherToolbox(),
    signal: controller.signal,
    ...(admitter === undefined
      ? {}
      : {
          generatedMediaAdmitter: createStepGeneratedMediaAdmitter({
            port: admitter.port,
            runId: 'run-1',
            step: 0,
            signal: controller.signal,
          }),
        }),
  };
}

describe.each(wrappers)('%s commits response parts', (_name, wrap) => {
  it('commits a thinking-then-tool_use response as a row that carries the thinking part', async () => {
    const conversation = new Conversation();
    const generate = wrap(async ({ streaming }) => {
      streaming.reportPart?.({ type: 'start', partIndex: 0, kind: 'thinking' });
      streaming.reportPart?.({
        type: 'delta',
        partIndex: 0,
        sequence: 1,
        delta: { kind: 'thinking', thinking: 'Plan the call.' },
      });
      streaming.reportPart?.({ type: 'complete', partIndex: 0, part: thinkingPart });
      return {
        content: '',
        parts: [thinkingPart],
        toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'Paris' } }],
      };
    });

    const response = await generate(streamingContext(conversation));

    const [row] = conversation.getMessages();
    expect(row?.role).toBe('assistant');
    expect(row?.content).toEqual([thinkingPart]);
    expect(conversation.getStreamingMessage()).toBeUndefined();
    expect(response.messageAppended).toBe(true);
    expect(response.messageId).toBe(row?.id);
    expect(response.parts).toEqual([thinkingPart]);
  });

  it('reports the step row id and parts through a run', async () => {
    const conversation = new Conversation();
    let call = 0;
    const generate = wrap(async ({ streaming }) => {
      call++;
      if (call === 1) {
        streaming.reportPart?.({ type: 'start', partIndex: 0, kind: 'thinking' });
        streaming.reportPart?.({ type: 'complete', partIndex: 0, part: thinkingPart });
        return {
          content: '',
          parts: [thinkingPart],
          toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'Paris' } }],
        };
      }
      streaming.update('Sunny.');
      return { content: 'Sunny.', parts: [{ type: 'text', text: 'Sunny.' }], toolCalls: [] };
    });

    const result = await run({
      generate,
      toolbox: createWeatherToolbox(),
      conversation,
      stopWhen: noToolCalls(),
    });

    const assistantRows = result.conversation.getMessages().filter((m) => m.role === 'assistant');
    expect(assistantRows).toHaveLength(2);
    expect(result.steps[0]?.parts).toEqual([thinkingPart]);
    expect(result.steps[0]?.messageId).toBe(assistantRows[0]?.id);
    expect(result.steps[1]?.messageId).toBe(assistantRows[1]?.id);
    expect(result.parts).toEqual([thinkingPart, { type: 'text', text: 'Sunny.' }]);
  });

  it('writes the parts seen so far into the streaming row', async () => {
    const conversation = new Conversation();
    const seen: unknown[] = [];
    const generate = wrap(async ({ streaming }) => {
      streaming.reportPart?.({ type: 'start', partIndex: 0, kind: 'text' });
      streaming.reportPart?.({
        type: 'delta',
        partIndex: 0,
        sequence: 1,
        delta: { kind: 'text', text: 'Hel' },
      });
      seen.push(conversation.getStreamingMessage()?.content);
      streaming.reportPart?.({
        type: 'delta',
        partIndex: 0,
        sequence: 2,
        delta: { kind: 'text', text: 'lo' },
      });
      seen.push(conversation.getStreamingMessage()?.content);
      streaming.reportPart?.({
        type: 'complete',
        partIndex: 0,
        part: { type: 'text', text: 'Hello' },
      });
      return { content: 'Hello', parts: [{ type: 'text', text: 'Hello' }], toolCalls: [] };
    });

    await generate(streamingContext(conversation));

    expect(seen).toEqual(['Hel', 'Hello']);
    expect(conversation.getMessages()[0]?.content).toBe('Hello');
  });

  it('keeps a hand-written update-only function working: one text part from its content', async () => {
    const conversation = new Conversation();
    const generate = wrap(async ({ streaming }) => {
      streaming.update('Hello');
      streaming.update('Hello, world!');
      return textResponse('Hello, world!');
    });

    const response = await generate(streamingContext(conversation));

    expect(response.parts).toEqual([{ type: 'text', text: 'Hello, world!' }]);
    expect(conversation.getMessages()[0]?.content).toBe('Hello, world!');
  });

  it('commits no row for a response with no parts, and reports no message id', async () => {
    const conversation = new Conversation();
    const generate = wrap(async () => ({
      content: '',
      parts: [],
      toolCalls: [{ id: 'call-1', name: 'get_weather', arguments: { location: 'Paris' } }],
    }));

    const response = await generate(streamingContext(conversation));

    expect(conversation.getMessages()).toHaveLength(0);
    expect(conversation.getStreamingMessage()).toBeUndefined();
    expect(response.messageAppended).not.toBe(true);
    expect(response.messageId).toBeUndefined();
  });

  it('admits a generated media part as a managed asset before it reaches the row', async () => {
    const conversation = new Conversation();
    const admitter = createScriptedMediaAdmitter();
    const generate = wrap(async ({ streaming }) => {
      streaming.reportPart?.({ type: 'start', partIndex: 0, kind: 'image', mimeType: 'image/png' });
      streaming.reportPart?.({
        type: 'progress',
        partIndex: 0,
        sequence: 1,
        receivedBytes: 15,
        totalBytes: 15,
      });
      streaming.reportPart?.({ type: 'complete', partIndex: 0, part: inlineImage });
      return { content: '', parts: [inlineImage], toolCalls: [] };
    });

    const response = await generate(streamingContext(conversation, admitter));

    const expectedSource = { kind: 'managed-asset', assetId: 'asset-1', revision: 1 } as const;
    expect(response.parts).toEqual([{ ...inlineImage, source: expectedSource }]);
    expect(conversation.getMessages()[0]?.content).toEqual([
      { ...inlineImage, source: expectedSource },
    ]);
    expect(JSON.stringify(conversation.current)).not.toContain('UNIQUEBYTES');
    expect(admitter.admissions).toHaveLength(1);
    expect(admitter.admissions[0]?.request).toMatchObject({
      runId: 'run-1',
      step: 0,
      partIndex: 0,
      messageId: response.messageId,
    });
  });

  it('fails with a typed error and no row when the run has no admission port', async () => {
    const conversation = new Conversation();
    const generate = wrap(async ({ streaming }) => {
      streaming.reportPart?.({ type: 'start', partIndex: 0, kind: 'image' });
      streaming.reportPart?.({ type: 'complete', partIndex: 0, part: inlineImage });
      return { content: '', parts: [inlineImage], toolCalls: [] };
    });

    const thrown = await throwingRejectionOf(generate(streamingContext(conversation)));
    expect(thrown).toThrow(GeneratedMediaNotAdmittedError);
    expect(conversation.getMessages()).toHaveLength(0);
    expect(conversation.getStreamingMessage()).toBeUndefined();
  });

  it('fails the response when an admission is refused, naming the part, and leaves no row', async () => {
    const conversation = new Conversation();
    const admitter = createScriptedMediaAdmitter({ mode: 'reject' });
    const generate = wrap(async ({ streaming }) => {
      streaming.reportPart?.({ type: 'start', partIndex: 0, kind: 'image' });
      streaming.reportPart?.({ type: 'complete', partIndex: 0, part: inlineImage });
      return {
        content: '',
        parts: [inlineImage],
        toolCalls: [],
        usage: { prompt: 4, completion: 2, total: 6 },
      };
    });

    let error: unknown;
    try {
      await generate(streamingContext(conversation, admitter));
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(GeneratedMediaNotAdmittedError);
    const admissionError = error as GeneratedMediaNotAdmittedError;
    expect(admissionError.reason).toBe('admission-failed');
    expect(admissionError.partIndex).toBe(0);
    expect(admissionError.rejectionCode).toBe('per-part-limit-exceeded');
    expect(admissionError.usage).toEqual({ prompt: 4, completion: 2, total: 6 });
    expect(conversation.getMessages()).toHaveLength(0);
    expect(conversation.getStreamingMessage()).toBeUndefined();
  });

  it('aborts and settles an open admission when the stream fails between part completion and availability', async () => {
    const conversation = new Conversation();
    const admitter = createScriptedMediaAdmitter({ mode: 'manual' });
    const generate = wrap(async ({ streaming }) => {
      streaming.reportPart?.({ type: 'start', partIndex: 0, kind: 'image' });
      streaming.reportPart?.({ type: 'complete', partIndex: 0, part: inlineImage });
      await Promise.resolve();
      throw new Error('connection lost');
    });

    const thrown = await throwingRejectionOf(generate(streamingContext(conversation, admitter)));
    expect(thrown).toThrow('connection lost');
    expect(admitter.admissions).toHaveLength(1);
    expect(admitter.admissions[0]?.aborted).toBe(true);
    expect(admitter.admissions[0]?.settlement?.outcome).toBe('aborted');
    expect(conversation.getMessages()).toHaveLength(0);
  });

  it('aborts the admission when the run is cancelled between completion and availability', async () => {
    const conversation = new Conversation();
    const admitter = createScriptedMediaAdmitter({ mode: 'manual' });
    const controller = new AbortController();
    const generate = wrap(async ({ streaming }) => {
      streaming.reportPart?.({ type: 'start', partIndex: 0, kind: 'image' });
      streaming.reportPart?.({ type: 'complete', partIndex: 0, part: inlineImage });
      controller.abort();
      return { content: '', parts: [inlineImage], toolCalls: [] };
    });

    let error: unknown;
    try {
      await generate(streamingContext(conversation, admitter, controller));
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(GeneratedMediaNotAdmittedError);
    expect((error as GeneratedMediaNotAdmittedError).rejectionCode).toBe('aborted');
    expect(admitter.admissions[0]?.settlement?.outcome).toBe('aborted');
    expect(conversation.getMessages()).toHaveLength(0);
  });

  it('replaces the streamed row when a response hook changes the settled response', async () => {
    const conversation = new Conversation();
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateResponse', async () => ({ content: '[redacted]', toolCalls: [] }));
    const generate = wrap(async ({ streaming }) => {
      streaming.reportPart?.({ type: 'start', partIndex: 0, kind: 'thinking' });
      streaming.reportPart?.({ type: 'complete', partIndex: 0, part: thinkingPart });
      streaming.reportPart?.({ type: 'start', partIndex: 1, kind: 'text' });
      streaming.reportPart?.({
        type: 'delta',
        partIndex: 1,
        sequence: 1,
        delta: { kind: 'text', text: 'secret answer' },
      });
      streaming.reportPart?.({
        type: 'complete',
        partIndex: 1,
        part: { type: 'text', text: 'secret answer' },
      });
      return {
        content: 'secret answer',
        parts: [thinkingPart, { type: 'text', text: 'secret answer' }],
        toolCalls: [],
      };
    });

    const result = await run({
      generate,
      toolbox: createWeatherToolbox(),
      conversation,
      hooks,
      stopWhen: noToolCalls(),
    });

    const rows = result.conversation.getMessages().filter((m) => m.role === 'assistant');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe('[redacted]');
    expect(result.steps[0]?.messageId).toBe(rows[0]?.id);
    expect(result.steps[0]?.parts).toEqual([{ type: 'text', text: '[redacted]' }]);
    expect(JSON.stringify(result.conversation.current)).not.toContain('secret answer');
    expect(JSON.stringify(result.conversation.current)).not.toContain('sig-1');
  });
});
