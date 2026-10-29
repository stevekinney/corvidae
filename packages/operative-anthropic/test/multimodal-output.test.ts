import { HookRegistry, TypedEventTarget } from '@lostgradient/lifecycle';
import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import {
  type OperativeHookMap,
  type RunOptions,
  type StreamEventMap,
  createActiveRun,
  noToolCalls,
  withEnhancedStreaming,
  withStreaming,
} from '@lostgradient/operative';
import {
  type GenerateContext,
  type StreamEvent,
  type StreamingHandle,
  ProviderContractError,
} from '@lostgradient/operative/provider-kit';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createAnthropicProvider, createAnthropicProviderStream } from '../src/anthropic';
import { normalizeAnthropicStream } from '../src/streaming/normalize-anthropic';
import {
  createMockAnthropicClient,
  createMockAnthropicStreamingClient,
} from '../src/test/anthropic-mock-clients';
import {
  type RecordedAnthropicBlock,
  anthropicStreamEventsFor,
  citedTextBlock,
  redactedThinkingBlock,
  serverToolBlocks,
  thinkingBlock,
  toolUseBlock,
} from './multimodal-fixtures';

const run = (options: Parameters<typeof createActiveRun>[0]) => createActiveRun(options).result;

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function baseOptions(
  generate: RunOptions['generate'],
  extra: Partial<RunOptions> & { stopWhen?: unknown } = {},
): Parameters<typeof createActiveRun>[0] {
  return {
    generate,
    toolbox: createTestToolbox([weatherTool]),
    conversation: new Conversation(),
    stopWhen: noToolCalls(),
    ...extra,
  } as Parameters<typeof createActiveRun>[0];
}

type AnthropicMode = 'non-streaming' | 'withStreaming' | 'withEnhancedStreaming';
const ANTHROPIC_MODES: ReadonlyArray<readonly [AnthropicMode]> = [
  ['non-streaming'],
  ['withStreaming'],
  ['withEnhancedStreaming'],
];

const finalTextBlock = { type: 'text', text: 'Done.' } satisfies RecordedAnthropicBlock;
const usageOf = { input_tokens: 12, output_tokens: 7 };

/** Runs two steps against recorded Anthropic output: `firstBlocks`, then a closing text answer. */
async function runAnthropic(mode: AnthropicMode, firstBlocks: readonly RecordedAnthropicBlock[]) {
  const replies = [firstBlocks, [finalTextBlock]];
  let generate: RunOptions['generate'];
  let requests: Array<{ messages: unknown }>;
  if (mode === 'non-streaming') {
    const client = createMockAnthropicClient(
      replies.map((content) => ({ content, usage: usageOf })) as never,
    );
    generate = createAnthropicProvider({ model: 'claude-sonnet-4-6', client });
    requests = client._calls;
  } else {
    const client = createMockAnthropicStreamingClient(
      replies.map((content) => anthropicStreamEventsFor(content)),
    );
    const streaming = createAnthropicProviderStream({ model: 'claude-sonnet-4-6', client });
    generate =
      mode === 'withStreaming' ? withStreaming(streaming) : withEnhancedStreaming(streaming);
    requests = client._calls;
  }
  const result = await run(baseOptions(generate));
  return { result, requests };
}

function assistantTurn(request: { messages: unknown } | undefined): unknown[] {
  const messages = request?.messages as Array<{ role: string; content: unknown }>;
  const turn = messages.find((message) => message.role === 'assistant');
  return turn?.content as unknown[];
}

describe.each(ANTHROPIC_MODES)('Anthropic replay blocks survive the loop (%s)', (mode) => {
  const scenarios: ReadonlyArray<readonly [string, RecordedAnthropicBlock[]]> = [
    ['thinking, then tool_use, with no text block', [thinkingBlock, toolUseBlock]],
    ['redacted_thinking, then tool_use', [redactedThinkingBlock, toolUseBlock]],
    [
      'thinking, text, then tool_use',
      [thinkingBlock, { type: 'text', text: 'Let me check.' }, toolUseBlock],
    ],
    ['text with citations', [citedTextBlock]],
    ['every server-tool block type and container_upload', [...serverToolBlocks, toolUseBlock]],
  ];

  it.each(scenarios)(
    'keeps %s: parts in provider order, in the row, and byte-identical on the next request',
    async (_name, blocks) => {
      const { result, requests } = await runAnthropic(mode, blocks);

      const expectedParts = blocks.filter((block) => block['type'] !== 'tool_use');
      expect(result.finishReason).toBe('stop-condition');
      expect(result.steps[0]?.parts).toEqual(expectedParts as never);
      const text = expectedParts
        .filter((block) => block['type'] === 'text')
        .map((block) => block['text'])
        .join('');
      expect(result.steps[0]?.content).toBe(text);

      const [row] = result.conversation.getMessages().filter((m) => m.role === 'assistant');
      expect(row?.id).toBe(result.steps[0]?.messageId);
      expect(row?.content).toEqual(
        expectedParts.length === 1 &&
          expectedParts[0]?.['type'] === 'text' &&
          !('citations' in expectedParts[0])
          ? (expectedParts[0]['text'] as string)
          : (expectedParts as never),
      );

      if (blocks.some((block) => block['type'] === 'tool_use')) {
        // The request that carries the tool result holds each block exactly as the API returned it,
        // with thinking before tool_use in the same assistant turn.
        expect(JSON.stringify(assistantTurn(requests[1]))).toBe(JSON.stringify(blocks));
      }
    },
  );

  it('keeps the usage the response reported', async () => {
    const { result } = await runAnthropic(mode, [thinkingBlock, toolUseBlock]);
    expect(result.steps[0]?.usage).toMatchObject({ prompt: 12, completion: 7 });
  });
});

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

describe('an unmapped provider block fails the run, is accounted, and is not retried', () => {
  const unlisted = { type: 'tool_search_tool_result', tool_use_id: 'x', content: [] };

  it.each(ANTHROPIC_MODES)(
    'Anthropic %s: throws the typed error with provider, block type, position and usage',
    async (mode) => {
      const error = await rejectionOf(
        mode === 'non-streaming'
          ? createAnthropicProvider({
              model: 'claude-sonnet-4-6',
              client: createMockAnthropicClient([
                { content: [{ type: 'text', text: 'Hi' }, unlisted], usage: usageOf },
              ] as never),
            })(adapterContext())
          : createAnthropicProviderStream({
              model: 'claude-sonnet-4-6',
              client: createMockAnthropicStreamingClient([
                anthropicStreamEventsFor([{ type: 'text', text: 'Hi' }, unlisted]),
              ]),
            })(adapterContext()),
      );

      expect(error).toBeInstanceOf(ProviderContractError);
      expect(error).toMatchObject({
        provider: 'anthropic',
        blockType: 'tool_search_tool_result',
        partIndex: 1,
        reason: 'unlisted-block',
        retryable: false,
      });
      expect((error as ProviderContractError).usage).toMatchObject({ prompt: 12, completion: 7 });
    },
  );

  it('Anthropic streaming: an unknown delta type is refused after the stream drains', async () => {
    const events = anthropicStreamEventsFor([{ type: 'text', text: 'Hi' }]);
    events.splice(3, 0, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'mystery_delta' },
    });
    const error = await rejectionOf(
      createAnthropicProviderStream({
        model: 'claude-sonnet-4-6',
        client: createMockAnthropicStreamingClient([events]),
      })(adapterContext()),
    );
    expect(error).toMatchObject({ blockType: 'mystery_delta', partIndex: 0 });
    expect((error as ProviderContractError).usage).toMatchObject({ completion: 7 });
  });

  it('is accounted in the run usage and never retried, with no shouldRetry set', async () => {
    const client = createMockAnthropicClient([
      { content: [unlisted], usage: usageOf },
      { content: [{ type: 'text', text: 'recovered' }], usage: usageOf },
    ] as never);

    const result = await run(
      baseOptions(createAnthropicProvider({ model: 'claude-sonnet-4-6', client }), {
        retry: { attempts: 3 },
      }),
    );

    expect(result.finishReason).toBe('error');
    // The loop wraps a provider error, keeping it as the cause (the ToolCallParseError precedent).
    expect((result.error as { cause?: unknown }).cause).toBeInstanceOf(ProviderContractError);
    expect(client._calls).toHaveLength(1);
    expect(result.usage).toMatchObject({ prompt: 12, completion: 7 });
  });

  it('still retries an ordinary transient failure under the same options', async () => {
    const client = createMockAnthropicClient(
      [{ content: [{ type: 'text', text: 'ok' }], usage: usageOf }] as never,
      [Object.assign(new Error('overloaded'), { status: 529 })],
    );
    const result = await run(
      baseOptions(createAnthropicProvider({ model: 'claude-sonnet-4-6', client }), {
        retry: { attempts: 2 },
      }),
    );
    expect(result.finishReason).toBe('stop-condition');
    expect(client._calls).toHaveLength(2);
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
  it('Anthropic: emits part events beside the legacy block events, with the signature on the completed thinking part', async () => {
    const events = await collect(
      normalizeAnthropicStream(
        iterate(anthropicStreamEventsFor([thinkingBlock, citedTextBlock, toolUseBlock])),
        { messageId: 'row-1' },
      ),
    );

    const partEvents = events.filter((event) => event.type.startsWith('stream:part-'));
    expect(
      partEvents.map((event) => [event.type, 'partIndex' in event ? event.partIndex : -1]),
    ).toEqual([
      ['stream:part-start', 0],
      ['stream:part-delta', 0],
      ['stream:part-delta', 0],
      ['stream:part-complete', 0],
      ['stream:part-start', 1],
      ['stream:part-delta', 1],
      ['stream:part-delta', 1],
      ['stream:part-delta', 1],
      ['stream:part-complete', 1],
    ]);
    const completed = events.filter((event) => event.type === 'stream:part-complete');
    expect(completed.map((event) => event.part)).toEqual([thinkingBlock, citedTextBlock] as never);
    expect(partEvents.every((event) => 'messageId' in event && event.messageId === 'row-1')).toBe(
      true,
    );
    // The legacy surface is unchanged: block events, text deltas, the tool call and one completion.
    expect(events.filter((event) => event.type === 'stream:tool-call-complete')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'stream:text-delta').length).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === 'stream:complete')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'stream:error')).toHaveLength(0);
  });

  it('Anthropic: an unlisted block or delta yields a stream:error carrying the typed contract error', async () => {
    const unlisted = { type: 'tool_search_tool_result', tool_use_id: 'x', content: [] };
    const events = await collect(
      normalizeAnthropicStream(
        iterate(anthropicStreamEventsFor([{ type: 'text', text: 'Hi' }, unlisted as never])),
      ),
    );
    const errors = events.filter((event) => event.type === 'stream:error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toBeInstanceOf(ProviderContractError);
    expect(errors[0]?.error).toMatchObject({ blockType: 'tool_search_tool_result', partIndex: 1 });
  });
});

describe.each(ANTHROPIC_MODES)(
  'an empty Anthropic text block is skipped the same way (%s)',
  (mode) => {
    const emptyText = { type: 'text', text: '' } satisfies RecordedAnthropicBlock;
    const hello = { type: 'text', text: 'Hello' } satisfies RecordedAnthropicBlock;

    it('commits no row and replays only the tool_use for [empty text, tool_use]', async () => {
      const { result, requests } = await runAnthropic(mode, [emptyText, toolUseBlock]);
      expect(result.steps[0]?.parts).toEqual([]);
      expect(result.steps[0]?.messageId).toBeUndefined();
      const assistantRows = result.conversation.getMessages().filter((m) => m.role === 'assistant');
      expect(assistantRows.map((row) => row.content)).toEqual(['Done.']);
      expect(JSON.stringify(assistantTurn(requests[1]))).toBe(JSON.stringify([toolUseBlock]));
    });

    it('keeps the thinking and drops the empty text for [thinking, empty text, tool_use]', async () => {
      const { result, requests } = await runAnthropic(mode, [
        thinkingBlock,
        emptyText,
        toolUseBlock,
      ]);
      expect(result.steps[0]?.parts).toEqual([thinkingBlock] as never);
      expect(JSON.stringify(assistantTurn(requests[1]))).toBe(
        JSON.stringify([thinkingBlock, toolUseBlock]),
      );
    });

    it('puts Hello at part index 0 for [empty text, Hello]', async () => {
      const { result } = await runAnthropic(mode, [emptyText, hello]);
      expect(result.steps[0]?.parts).toEqual([{ type: 'text', text: 'Hello' }]);
      expect(result.steps[0]?.content).toBe('Hello');
    });
  },
);

describe('an empty Anthropic text block leaves no hole in the part indexes of the live events', () => {
  it('numbers the parts that follow an empty text block from zero', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const indexes: number[] = [];
    eventTarget.addEventListener('stream:part-start', (event) =>
      indexes.push(event.detail.partIndex),
    );
    const client = createMockAnthropicStreamingClient([
      anthropicStreamEventsFor([
        { type: 'text', text: '' },
        thinkingBlock,
        { type: 'text', text: 'Hi' },
      ]),
    ]);
    const generate = withEnhancedStreaming(
      createAnthropicProviderStream({ model: 'claude-sonnet-4-6', client }),
      { eventTarget },
    );

    const response = await generate(adapterContext());

    expect(indexes).toEqual([0, 1]);
    expect(response.parts).toEqual([thinkingBlock, { type: 'text', text: 'Hi' }] as never);
  });

  it('the public normalizer also skips an empty text block', async () => {
    const events = await collect(
      normalizeAnthropicStream(
        iterate(anthropicStreamEventsFor([{ type: 'text', text: '' }, thinkingBlock])),
      ),
    );
    const starts = events.filter((event) => event.type === 'stream:part-start');
    expect(starts.map((event) => [event.partIndex, event.kind])).toEqual([[0, 'thinking']]);
    const completes = events.filter((event) => event.type === 'stream:part-complete');
    expect(completes.map((event) => event.partIndex)).toEqual([0]);
  });
});

describe('stream normalizers (correction)', () => {
  const toolUseStream = [
    { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking.' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
    },
    // The API opens every tool_use block with an empty partial_json.
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"location":"Paris"}' },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ];

  it('Anthropic: an ordinary tool_use stream with an empty first input_json_delta raises no error', async () => {
    const events = await collect(normalizeAnthropicStream(iterate(toolUseStream as never)));
    expect(events.filter((event) => event.type === 'stream:error')).toEqual([]);
    expect(events.filter((event) => event.type === 'stream:tool-call-complete')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('stream:complete');
  });

  it('Anthropic: nothing follows a stream:error, not even stream:complete', async () => {
    const unlisted = { type: 'tool_search_tool_result', tool_use_id: 'x', content: [] };
    const events = await collect(
      normalizeAnthropicStream(
        iterate(anthropicStreamEventsFor([{ type: 'text', text: 'Hi' }, unlisted as never])),
      ),
    );
    expect(events.at(-1)?.type).toBe('stream:error');
    expect(events.filter((event) => event.type === 'stream:complete')).toEqual([]);

    const mystery = anthropicStreamEventsFor([{ type: 'text', text: 'Hi' }]);
    mystery.splice(3, 0, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'mystery_delta' },
    });
    const afterDelta = await collect(normalizeAnthropicStream(iterate(mystery)));
    expect(afterDelta.at(-1)?.type).toBe('stream:error');
  });
});

describe('an onError retry never reissues a provider contract failure (correction)', () => {
  it('fails the step instead of calling generate again', async () => {
    const client = createMockAnthropicClient([
      {
        content: [{ type: 'tool_search_tool_result', tool_use_id: 'x', content: [] }],
        usage: usageOf,
      },
      { content: [{ type: 'text', text: 'recovered' }], usage: usageOf },
    ] as never);
    const hooks = new HookRegistry<OperativeHookMap>();
    let errorHookCalls = 0;
    hooks.on('onError', async () => {
      errorHookCalls += 1;
      return 'retry';
    });

    const result = await run(
      baseOptions(createAnthropicProvider({ model: 'claude-sonnet-4-6', client }), { hooks }),
    );

    expect(result.finishReason).toBe('error');
    expect(client._calls).toHaveLength(1);
    expect(errorHookCalls).toBe(1);
  });

  it('still honors retry for an ordinary failure', async () => {
    const client = createMockAnthropicClient(
      [{ content: [{ type: 'text', text: 'ok' }], usage: usageOf }] as never,
      [Object.assign(new Error('overloaded'), { status: 529 })],
    );
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('onError', async () => 'retry');
    const result = await run(
      baseOptions(createAnthropicProvider({ model: 'claude-sonnet-4-6', client }), { hooks }),
    );
    expect(result.finishReason).toBe('stop-condition');
    expect(client._calls).toHaveLength(2);
  });
});

describe('a truncated Anthropic stream fails typed (correction 3)', () => {
  const midBlockStream = [
    { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half an ans' } },
  ] as const;

  it.each(['withStreaming', 'withEnhancedStreaming'] as const)(
    'ends the run with a ProviderContractError, never an empty answer (%s)',
    async (mode) => {
      const client = createMockAnthropicStreamingClient([midBlockStream as never]);
      const streaming = createAnthropicProviderStream({ model: 'claude-sonnet-4-6', client });
      const generate =
        mode === 'withStreaming' ? withStreaming(streaming) : withEnhancedStreaming(streaming);

      const result = await run(baseOptions(generate));

      expect(result.finishReason).toBe('error');
      const cause = (result.error as { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(ProviderContractError);
      expect((cause as ProviderContractError).reason).toBe('truncated-stream');
      expect(client._calls).toHaveLength(1);
    },
  );

  it('also fails when a tool_use block is cut off', async () => {
    const client = createMockAnthropicStreamingClient([
      [
        { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"location":' },
        },
      ] as never,
    ]);
    const generate = withStreaming(
      createAnthropicProviderStream({ model: 'claude-sonnet-4-6', client }),
    );

    const result = await run(baseOptions(generate));

    expect(result.finishReason).toBe('error');
    const cause = (result.error as { cause?: unknown }).cause;
    expect((cause as ProviderContractError).reason).toBe('truncated-stream');
  });

  it('makes the public normalizer end in a stream:error with no stream:complete', async () => {
    const events = await collect(normalizeAnthropicStream(iterate(midBlockStream as never)));

    expect(events.at(-1)?.type).toBe('stream:error');
    expect(events.filter((event) => event.type === 'stream:complete')).toEqual([]);
    const error = (events.at(-1) as { error: unknown }).error;
    expect(error).toBeInstanceOf(ProviderContractError);
    expect((error as ProviderContractError).reason).toBe('truncated-stream');
  });

  it('still completes a stream whose blocks all stopped', async () => {
    const events = await collect(
      normalizeAnthropicStream(
        iterate(anthropicStreamEventsFor([{ type: 'text', text: 'Whole.' }]) as never),
      ),
    );

    expect(events.at(-1)?.type).toBe('stream:complete');
  });
});
