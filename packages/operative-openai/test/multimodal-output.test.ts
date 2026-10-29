import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, type MultiModalContent } from 'conversationalist';
import { z } from 'zod';

import type {
  GenerateContext,
  LivePartEvent,
  StreamEvent,
  StreamingHandle,
} from '@lostgradient/operative/provider-kit';
import { ProviderContractError } from '@lostgradient/operative/provider-kit';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createOpenAIProvider, createOpenAIProviderStream } from '../src/openai';
import { normalizeOpenAIStream } from '../src/streaming/normalize-openai';
import {
  createMockOpenAIClient,
  createMockOpenAIStreamingClient,
} from '../src/test/openai-mock-clients';

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

type OpenAIMessage = NonNullable<
  Parameters<typeof createMockOpenAIClient>[0][number]['choices'][number]
>['message'];

function completion(
  message: OpenAIMessage,
  usage = { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
) {
  return { choices: [{ message, finish_reason: 'stop' }], usage };
}

function chunksFor(message: Record<string, unknown>) {
  const chunks: Array<Record<string, unknown>> = [];
  const { content, tool_calls: toolCalls, ...rest } = message;
  if (typeof content === 'string' && content !== '') {
    const middle = Math.ceil(content.length / 2);
    chunks.push({ choices: [{ delta: { content: content.slice(0, middle) } }], usage: null });
    chunks.push({ choices: [{ delta: { content: content.slice(middle) } }], usage: null });
  }
  if (toolCalls !== undefined) {
    chunks.push({ choices: [{ delta: { tool_calls: toolCalls } }], usage: null });
  }
  for (const [key, value] of Object.entries(rest)) {
    chunks.push({ choices: [{ delta: { [key]: value } }], usage: null });
  }
  chunks.push({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } });
  return chunks;
}

async function openAIResponse(
  mode: 'non-streaming' | 'streaming',
  message: Record<string, unknown>,
) {
  if (mode === 'non-streaming') {
    const client = createMockOpenAIClient([completion(message)]);
    return createOpenAIProvider({ model: 'gpt-4o', client })(adapterContext());
  }
  const client = createMockOpenAIStreamingClient([chunksFor(message) as never]);
  const recorder = recordingHandle();
  const response = await createOpenAIProviderStream({ model: 'gpt-4o', client })(
    adapterContext(recorder.handle),
  );
  return response;
}

describe.each([['non-streaming'], ['streaming']] as const)('OpenAI output mapping (%s)', (mode) => {
  it('maps message content to one text part and keeps content equal to the text', async () => {
    const response = await openAIResponse(mode, { content: 'Hello there' });
    expect(response.parts).toEqual([textPart('Hello there')]);
    expect(response.content).toBe('Hello there');
    expect(response.metadata).not.toHaveProperty('refusal');
  });

  it('maps empty or null content to no part', async () => {
    const response = await openAIResponse(mode, {
      content: null,
      tool_calls: [
        {
          index: 0,
          id: 'call-9',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"location":"Paris"}' },
        },
      ],
    });
    expect(response.parts).toEqual([]);
    expect(response.content).toBe('');
    expect(response.toolCalls).toHaveLength(1);
  });

  it('keeps a refusal and annotations as metadata, not as lost output', async () => {
    const response = await openAIResponse(mode, {
      content: 'Partial',
      refusal: 'I cannot help with that.',
      ...(mode === 'non-streaming'
        ? { annotations: [{ type: 'url_citation', url: 'https://x.test' }] }
        : {}),
    });
    expect(response.metadata?.['refusal']).toBe('I cannot help with that.');
    if (mode === 'non-streaming') {
      expect(response.metadata?.['annotations']).toEqual([
        { type: 'url_citation', url: 'https://x.test' },
      ]);
    }
  });

  it('keeps a field the SDK does not declare in metadata, leniently', async () => {
    const response = await openAIResponse(mode, {
      content: 'Hi',
      reasoning_content: 'thinking aloud',
    });
    expect(response.metadata?.['providerExtensions']).toEqual({
      reasoning_content: 'thinking aloud',
    });
    expect(response.parts).toEqual([textPart('Hi')]);
  });

  it('refuses audio output and the deprecated function_call with the typed contract error, carrying usage', async () => {
    for (const [field, value] of [
      ['audio', { id: 'audio-1', data: 'AAAA' }],
      ['function_call', { name: 'get_weather', arguments: '{}' }],
    ] as const) {
      const error = await rejectionOf(openAIResponse(mode, { content: 'Hi', [field]: value }));
      expect(error).toBeInstanceOf(ProviderContractError);
      const contract = error as ProviderContractError;
      expect(contract).toMatchObject({
        provider: 'openai',
        blockType: field,
        reason: 'unlisted-block',
      });
      expect(contract.usage).toMatchObject({ prompt: 9, completion: 4 });
      expect(contract.retryable).toBe(false);
    }
  });
});

describe('OpenAI streaming reports text as a part', () => {
  it('starts, streams deltas with rising sequences, and completes one text part', async () => {
    const client = createMockOpenAIStreamingClient([
      chunksFor({ content: 'Hello there' }) as never,
    ]);
    const recorder = recordingHandle();

    const response = await createOpenAIProviderStream({ model: 'gpt-4o', client })(
      adapterContext(recorder.handle),
    );

    expect(recorder.events.map((event) => event.type)).toEqual([
      'start',
      'delta',
      'delta',
      'complete',
    ]);
    expect(
      recorder.events.filter((event) => event.type === 'delta').map((event) => event.sequence),
    ).toEqual([1, 2]);
    expect(recorder.events.at(-1)).toEqual({
      type: 'complete',
      partIndex: 0,
      part: textPart('Hello there'),
    });
    expect(recorder.updates).toEqual([]);
    expect(response.parts).toEqual([textPart('Hello there')]);
  });

  it('falls back to update for a handle that cannot report parts', async () => {
    const client = createMockOpenAIStreamingClient([
      chunksFor({ content: 'Hello there' }) as never,
    ]);
    const updates: string[] = [];
    const response = await createOpenAIProviderStream({ model: 'gpt-4o', client })(
      adapterContext({ messageId: 'row', update: (content) => updates.push(content) }),
    );
    expect(updates.at(-1)).toBe('Hello there');
    expect(response.parts).toEqual([textPart('Hello there')]);
  });
});

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function* iterate<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

describe('the public stream normalizers report parts and refuse unmapped output (COR-713)', () => {
  it('OpenAI: text becomes one part with start, deltas and completion; audio output yields stream:error', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'Hel' }, finish_reason: null }], usage: null },
      { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }], usage: null },
    ];
    const events = await collect(normalizeOpenAIStream(iterate(chunks as never), undefined));
    expect(
      events.filter((event) => event.type.startsWith('stream:part-')).map((event) => event.type),
    ).toEqual([
      'stream:part-start',
      'stream:part-delta',
      'stream:part-delta',
      'stream:part-complete',
    ]);
    expect(events.find((event) => event.type === 'stream:part-complete')).toMatchObject({
      part: { type: 'text', text: 'Hello' },
    });

    const refused = await collect(
      normalizeOpenAIStream(
        iterate([{ choices: [{ delta: { audio: { data: 'AAAA' } } }], usage: null }] as never),
        undefined,
      ),
    );
    expect(refused.find((event) => event.type === 'stream:error')?.error).toBeInstanceOf(
      ProviderContractError,
    );
  });
});

describe('stream normalizers (correction)', () => {
  it('OpenAI: nothing follows a stream:error for audio or function_call', async () => {
    for (const field of ['audio', 'function_call']) {
      const events = await collect(
        normalizeOpenAIStream(
          iterate([
            { choices: [{ delta: { content: 'Hi' }, finish_reason: null }], usage: null },
            { choices: [{ delta: { [field]: { x: 1 } }, finish_reason: 'stop' }], usage: null },
          ] as never),
          undefined,
        ),
      );
      expect(events.at(-1)?.type).toBe('stream:error');
      expect(events.filter((event) => event.type === 'stream:complete')).toEqual([]);
    }
  });
});
