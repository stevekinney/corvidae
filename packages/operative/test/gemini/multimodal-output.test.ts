import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, type MultiModalContent } from 'conversationalist';
import { z } from 'zod';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { ProviderContractError } from '../../src/providers/errors';
import { createGeminiProvider, createGeminiProviderStream } from '../../src/providers/gemini';
import { createGeminiPartMapper } from '../../src/providers/gemini-parts';
import {
  createMockGeminiModel,
  createMockGeminiStreamingModel,
} from '../../src/providers/test/gemini-mock-clients';
import type { LivePartEvent } from '../../src/streaming/types';
import type { GenerateContext, StreamingHandle } from '../../src/types';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});
const textPart = (text: string): MultiModalContent => ({ type: 'text', text });

function adapterContext(
  streaming?: StreamingHandle,
): GenerateContext & { streaming: StreamingHandle } {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createTestToolbox([weatherTool]),
    streaming: streaming ?? { messageId: 'row', update: () => {} },
  };
}

/** A streaming handle that records every part event the adapter reports. */
function recordingHandle(): {
  handle: StreamingHandle;
  events: LivePartEvent[];
  updates: string[];
} {
  const events: LivePartEvent[] = [];
  const updates: string[] = [];
  return {
    events,
    updates,
    handle: {
      messageId: 'row',
      update: (content) => updates.push(content),
      reportPart: (event) => events.push(event),
    },
  };
}

type GeminiPart = Record<string, unknown>;

async function geminiResponse(
  mode: 'non-streaming' | 'streaming',
  parts: GeminiPart[],
  recorder = recordingHandle(),
) {
  const usageMetadata = { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11 };
  if (mode === 'non-streaming') {
    const client = createMockGeminiModel([{ candidates: [{ content: { parts } }], usageMetadata }]);
    return createGeminiProvider({ model: 'gemini-2.5-flash', client })(adapterContext());
  }
  // One part per chunk: the stream delivers what the single response would have.
  const chunks = parts.map((part, index) => ({
    candidates: [{ content: { parts: [part] } }],
    ...(index === parts.length - 1 ? { usageMetadata } : {}),
  }));
  const client = createMockGeminiStreamingModel([chunks]);
  return createGeminiProviderStream({ model: 'gemini-2.5-flash', client })(
    adapterContext(recorder.handle),
  );
}

const UNLISTED_GEMINI_PAYLOADS = [
  'fileData',
  'executableCode',
  'codeExecutionResult',
  'functionResponse',
  'toolCall',
  'toolResponse',
  'audioTranscription',
] as const;

describe.each([['non-streaming'], ['streaming']] as const)('Gemini output mapping (%s)', (mode) => {
  it('coalesces adjacent text parts into one text part, the same in both modes', async () => {
    const response = await geminiResponse(mode, [{ text: 'Hel' }, { text: 'lo' }]);
    expect(response.parts).toEqual([textPart('Hello')]);
    expect(response.content).toBe('Hello');
  });

  it('never folds thought-summary text into the answer, and says what it dropped', async () => {
    const response = await geminiResponse(mode, [
      { text: 'Weighing options', thought: true },
      { text: 'Answer' },
    ]);
    expect(response.content).toBe('Answer');
    expect(response.parts).toEqual([textPart('Answer')]);
    expect(response.metadata?.['geminiThoughtSummaries']).toEqual(['Weighing options']);
    expect(response.metadata?.['replayDataDropped']).toEqual([
      { provider: 'gemini', providerPartIndex: 0, field: 'thought' },
    ]);
  });

  it('returns normally, naming the dropped data, for a part that carries a thoughtSignature', async () => {
    const response = await geminiResponse(mode, [
      { text: 'Checking' },
      {
        functionCall: { name: 'get_weather', args: { location: 'Paris' } },
        thoughtSignature: 'c2ln',
      },
    ]);
    expect(response.toolCalls).toHaveLength(1);
    expect(response.parts).toEqual([textPart('Checking')]);
    expect(response.metadata?.['replayDataDropped']).toEqual([
      { provider: 'gemini', providerPartIndex: 1, field: 'thoughtSignature' },
    ]);
  });

  it('carries neither the signal nor thought metadata when nothing was dropped', async () => {
    const response = await geminiResponse(mode, [{ text: 'Plain' }]);
    expect(response.metadata).not.toHaveProperty('replayDataDropped');
    expect(response.metadata).not.toHaveProperty('geminiThoughtSummaries');
  });

  it('treats a modifier-only part as control, not output', async () => {
    const response = await geminiResponse(mode, [{ text: 'Hi' }, { videoMetadata: { fps: 2 } }]);
    expect(response.parts).toEqual([textPart('Hi')]);
  });

  it.each(UNLISTED_GEMINI_PAYLOADS.map((payload) => [payload] as const))(
    'refuses a %s part with the typed contract error',
    async (payload) => {
      const error = await rejectionOf(
        geminiResponse(mode, [{ text: 'Hi' }, { [payload]: { anything: true } }]),
      );
      expect(error).toBeInstanceOf(ProviderContractError);
      expect(error).toMatchObject({
        provider: 'gemini',
        blockType: payload,
        partIndex: 1,
        reason: 'unlisted-block',
        retryable: false,
      });
      expect((error as ProviderContractError).usage).toMatchObject({ prompt: 8, completion: 3 });
    },
  );

  it('refuses a key it does not know, next to a payload, naming that key', async () => {
    const error = await rejectionOf(geminiResponse(mode, [{ text: 'Hi', surprise: 1 }]));
    expect(error).toMatchObject({ blockType: 'surprise', partIndex: 0 });
  });

  it('refuses generated media whose modality the selected backend does not advertise', async () => {
    const error = await rejectionOf(
      geminiResponse(mode, [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }]),
    );
    expect(error).toBeInstanceOf(ProviderContractError);
    expect(error).toMatchObject({
      provider: 'gemini',
      reason: 'unadvertised-modality',
      blockType: 'image',
      partIndex: 0,
    });
  });
});

describe('Gemini part mapper with a backend that advertises image output', () => {
  const advertising = {
    text: { input: true, output: true, sourceForms: [] },
    image: { input: true, output: true, sourceForms: [] },
    audio: { input: true, output: false, sourceForms: [] },
    video: { input: true, output: false, sourceForms: [] },
    document: { input: true, output: false, sourceForms: [] },
    file: { input: false, output: false, sourceForms: [] },
  } as const;

  it('maps inlineData to a media part with an inline base64 source and reports it live', () => {
    const events: LivePartEvent[] = [];
    const mapper = createGeminiPartMapper({
      modalities: advertising,
      emit: (event) => events.push(event),
    });

    mapper.push({ text: 'Here you go' }, 0);
    mapper.push({ inlineData: { mimeType: 'image/png', data: 'QUJD' } }, 1);
    const mapped = mapper.finish();

    expect(mapped.violation).toBeUndefined();
    expect(mapped.parts).toEqual([
      textPart('Here you go'),
      {
        type: 'image',
        mimeType: 'image/png',
        source: { kind: 'inline', data: 'QUJD', encoding: 'base64' },
      },
    ]);
    expect(events.map((event) => [event.type, event.partIndex])).toEqual([
      ['start', 0],
      ['delta', 0],
      ['complete', 0],
      ['start', 1],
      ['complete', 1],
    ]);
  });

  it('refuses audio when only image is advertised, and an inlineData with no media type', () => {
    const audio = createGeminiPartMapper({ modalities: advertising });
    audio.push({ inlineData: { mimeType: 'audio/wav', data: 'AAAA' } }, 0);
    expect(audio.finish().violation).toMatchObject({
      reason: 'unadvertised-modality',
      blockType: 'audio',
    });

    const untyped = createGeminiPartMapper({ modalities: advertising });
    untyped.push({ inlineData: { data: 'AAAA' } }, 0);
    expect(untyped.finish().violation).toMatchObject({
      reason: 'unlisted-block',
      blockType: 'inlineData',
    });
  });
});
