import { TypedEventTarget } from '@lostgradient/lifecycle';
import { createTestToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createAgent } from '../create-agent';
import { createStepGeneratedMediaAdmitter } from '../generated-media';
import { readGenerationProfile } from '../generation-profile';
import {
  readBackendDescriptors,
  withBackendDescriptors,
} from '../providers/backend-descriptor-attachment';
import { createModelCatalog } from '../providers/model-catalog';
import { createScriptedMediaAdmitter } from '../testing/generated-media.test-support';
import type { GenerateContext, GenerateResponse, StreamingGenerateFunction } from '../types';
import { withEnhancedStreaming } from './enhanced-streaming';
import type { StreamCustomEvent, StreamEvent, StreamEventMap, StreamState } from './types';

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function makeContext(overrides?: Partial<GenerateContext>): GenerateContext {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createTestToolbox([]),
    ...overrides,
  };
}

describe('withEnhancedStreaming', () => {
  it('wraps a streaming generate function and returns a standard GenerateFunction', async () => {
    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Hello, world!');
      return textResponse('Hello, world!');
    };

    const generate = withEnhancedStreaming(streamingGenerate);
    const context = makeContext();
    const result = await generate(context);

    expect(result.content).toBe('Hello, world!');
    expect(result.messageAppended).toBe(true);
  });

  it('calls onTextDelta callback with each delta', async () => {
    const deltas: Array<{ delta: string; accumulated: string }> = [];

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Hello');
      streaming.update('Hello, world!');
      return textResponse('Hello, world!');
    };

    const generate = withEnhancedStreaming(streamingGenerate, {
      onTextDelta: (delta, accumulated) => {
        deltas.push({ delta, accumulated });
      },
    });

    const context = makeContext();
    await generate(context);

    expect(deltas).toHaveLength(2);
    expect(deltas[0]?.delta).toBe('Hello');
    expect(deltas[0]?.accumulated).toBe('Hello');
    expect(deltas[1]?.delta).toBe(', world!');
    expect(deltas[1]?.accumulated).toBe('Hello, world!');
  });

  it('calls onToolCallStart when tool calls are in the response', async () => {
    const toolStarts: string[] = [];

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Searching...');
      return {
        content: 'Searching...',
        toolCalls: [{ name: 'get_weather', arguments: { location: 'Denver' } }],
      };
    };

    const generate = withEnhancedStreaming(streamingGenerate, {
      onToolCallStart: (toolName) => {
        toolStarts.push(toolName);
      },
    });

    const context = makeContext();
    await generate(context);

    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0]).toBe('get_weather');
  });

  it('emits events on eventTarget when provided', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const receivedEvents: string[] = [];

    eventTarget.addEventListener(
      'stream:text-delta',
      (event: StreamCustomEvent<'stream:text-delta'>) => {
        receivedEvents.push(`text:${event.detail.content}`);
      },
    );

    eventTarget.addEventListener('stream:complete', () => {
      receivedEvents.push('complete');
    });

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Hi');
      return textResponse('Hi');
    };

    const generate = withEnhancedStreaming(streamingGenerate, { eventTarget });
    const context = makeContext();
    await generate(context);

    expect(receivedEvents).toContain('text:Hi');
    expect(receivedEvents).toContain('complete');
  });

  it('cancels streaming message on error', async () => {
    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Partial...');
      throw new Error('Connection lost');
    };

    const generate = withEnhancedStreaming(streamingGenerate);
    const context = makeContext();

    let thrownError: unknown;
    try {
      await generate(context);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toBe('Connection lost');

    const streamingMessage = context.conversation.getStreamingMessage();
    expect(streamingMessage).toBeUndefined();
  });

  it('emits stream:error on eventTarget when an error occurs', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const errors: unknown[] = [];

    eventTarget.addEventListener('stream:error', (event: StreamCustomEvent<'stream:error'>) => {
      errors.push(event.detail.error);
    });

    const streamingGenerate: StreamingGenerateFunction = async () => {
      throw new Error('LLM failed');
    };

    const generate = withEnhancedStreaming(streamingGenerate, { eventTarget });
    const context = makeContext();

    let thrownError: unknown;
    try {
      await generate(context);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toBe('LLM failed');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it('tracks state through the stream via state machine', async () => {
    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Part 1');
      streaming.update('Part 1 Part 2');
      return {
        content: 'Part 1 Part 2',
        toolCalls: [],
        usage: { prompt: 10, completion: 20, total: 30 },
      };
    };

    const eventTarget = new TypedEventTarget<StreamEventMap>();
    let finalState: unknown;

    eventTarget.addEventListener(
      'stream:complete',
      (event: StreamCustomEvent<'stream:complete'>) => {
        finalState = event.detail.state;
      },
    );

    const generate = withEnhancedStreaming(streamingGenerate, { eventTarget });
    const context = makeContext();
    await generate(context);

    expect(finalState).toBeDefined();
  });

  it('works with existing withStreaming behavior preserved', async () => {
    const conversation = new Conversation();

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Hello');
      streaming.update('Hello, world!');
      return textResponse('Hello, world!');
    };

    const generate = withEnhancedStreaming(streamingGenerate);
    const result = await generate(makeContext({ conversation }));

    expect(result.content).toBe('Hello, world!');
    expect(result.messageAppended).toBe(true);

    // The streaming message should be finalized (not still streaming)
    const streamingMessage = conversation.getStreamingMessage();
    expect(streamingMessage).toBeUndefined();
  });

  it('calls onToolCallDelta when provided', async () => {
    const toolDeltas: Array<{ toolName: string; partialArgs: string }> = [];

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Calling tool');
      return {
        content: 'Calling tool',
        toolCalls: [{ name: 'search', arguments: { query: 'test' } }],
      };
    };

    const generate = withEnhancedStreaming(streamingGenerate, {
      onToolCallDelta: (toolName, partialArgs) => {
        toolDeltas.push({ toolName, partialArgs });
      },
    });

    const context = makeContext();
    await generate(context);

    // onToolCallDelta is called for each tool call in the response
    // The response contains pre-formed tool calls, so we emit one delta with the full args
    if (toolDeltas.length > 0) {
      expect(toolDeltas[0]?.toolName).toBe('search');
    }
  });
});

/**
 * AB-186 — `liveToolCalls` lets a `StreamingGenerateFunction` report tool-call
 * events through `StreamingHandle.report` while the provider response is still
 * open. Everything here is about the wrapper contract; the Anthropic and OpenAI
 * adapters that drive `report` in production are covered end-to-end in
 * `test/provider-live-tool-call-streaming.test.ts`.
 */
describe('withEnhancedStreaming live tool calls', () => {
  function recordEvents(eventTarget: TypedEventTarget<StreamEventMap>): StreamEvent[] {
    const events: StreamEvent[] = [];

    function record(type: keyof StreamEventMap): void {
      eventTarget.addEventListener(type, (event) => {
        events.push(event.detail);
      });
    }

    record('stream:block-start');
    record('stream:block-delta');
    record('stream:block-complete');
    record('stream:text-delta');
    record('stream:tool-call-start');
    record('stream:tool-call-delta');
    record('stream:tool-call-complete');

    return events;
  }

  /** Narrows recorded events to one variant so its payload can be asserted. */
  function eventsOfType<K extends StreamEvent['type']>(
    events: StreamEvent[],
    type: K,
  ): Array<Extract<StreamEvent, { type: K }>> {
    return events.filter(
      (event): event is Extract<StreamEvent, { type: K }> => event.type === type,
    );
  }

  /** A streaming function that reports one tool call live, then resolves. */
  const reportingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
    streaming.update('Checking');
    streaming.report?.({
      type: 'stream:tool-call-start',
      toolName: 'get_weather',
      blockId: 'toolu_01',
    });
    streaming.report?.({
      type: 'stream:tool-call-delta',
      toolName: 'get_weather',
      blockId: 'toolu_01',
      partialArguments: '{"location":',
    });
    streaming.report?.({
      type: 'stream:tool-call-delta',
      toolName: 'get_weather',
      blockId: 'toolu_01',
      partialArguments: '{"location":"Denver"}',
    });
    return {
      content: 'Checking',
      toolCalls: [{ id: 'toolu_01', name: 'get_weather', arguments: { location: 'Denver' } }],
    };
  };

  it('does not install the report channel unless liveToolCalls is enabled', async () => {
    let reportChannel: unknown = 'unset';

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      reportChannel = streaming.report;
      streaming.update('Hi');
      return textResponse('Hi');
    };

    await withEnhancedStreaming(streamingGenerate)(makeContext());

    expect(reportChannel).toBeUndefined();
  });

  it('leaves event order and payloads unchanged when liveToolCalls is off', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordEvents(eventTarget);

    await withEnhancedStreaming(reportingGenerate, { eventTarget })(makeContext());

    // Reported events are dropped on the floor; the wrapper reconstructs the
    // tool-call events from the resolved response exactly as it always has,
    // including the `tool-${name}-${index}-${messageId}` block id format.
    const toolStart = events.find((event) => event.type === 'stream:tool-call-start');
    expect(toolStart?.blockId).toMatch(/^tool-get_weather-0-/);

    expect(events.map((event) => event.type)).toEqual([
      'stream:block-start',
      'stream:text-delta',
      'stream:block-delta',
      'stream:block-complete',
      'stream:block-start',
      'stream:tool-call-start',
      'stream:block-delta',
      'stream:tool-call-delta',
      'stream:block-complete',
      'stream:tool-call-complete',
    ]);

    const toolDelta = events.find((event) => event.type === 'stream:tool-call-delta');
    expect(toolDelta?.partialArguments).toBe('{"location":"Denver"}');

    const toolComplete = events.find((event) => event.type === 'stream:tool-call-complete');
    expect(toolComplete?.arguments).toEqual({ location: 'Denver' });
  });

  it('forwards a reported tool-call event before the generate promise resolves', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const observed: string[] = [];
    const seenBeforeResolve: string[] = [];

    eventTarget.addEventListener('stream:tool-call-start', () => observed.push('start'));

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.report?.({
        type: 'stream:tool-call-start',
        toolName: 'get_weather',
        blockId: 'toolu_01',
      });
      seenBeforeResolve.push(...observed);
      return { content: '', toolCalls: [{ name: 'get_weather', arguments: {} }] };
    };

    await withEnhancedStreaming(streamingGenerate, { eventTarget, liveToolCalls: true })(
      makeContext(),
    );

    expect(seenBeforeResolve).toEqual(['start']);
  });

  it('keeps the reported block id across start, delta, and the synthesized completion', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordEvents(eventTarget);
    const toolStarts: string[] = [];
    const toolDeltas: string[] = [];

    await withEnhancedStreaming(reportingGenerate, {
      eventTarget,
      liveToolCalls: true,
      onToolCallStart: (toolName) => toolStarts.push(toolName),
      onToolCallDelta: (_toolName, partialArgs) => toolDeltas.push(partialArgs),
    })(makeContext());

    expect(events.map((event) => event.type)).toEqual([
      'stream:block-start',
      'stream:text-delta',
      'stream:block-delta',
      'stream:block-start',
      'stream:tool-call-start',
      'stream:block-delta',
      'stream:tool-call-delta',
      'stream:block-delta',
      'stream:tool-call-delta',
      'stream:block-complete',
      'stream:block-complete',
      'stream:tool-call-complete',
    ]);

    const toolEvents = events.filter(
      (event) =>
        event.type === 'stream:tool-call-start' ||
        event.type === 'stream:tool-call-delta' ||
        event.type === 'stream:tool-call-complete',
    );
    expect(toolEvents.every((event) => event.blockId === 'toolu_01')).toBe(true);

    // The wrapper diffs accumulated arguments into incremental block deltas,
    // the same way it does for text.
    const toolBlockDeltas = eventsOfType(events, 'stream:block-delta').filter(
      (event) => event.block.id === 'toolu_01',
    );
    expect(toolBlockDeltas.map((event) => event.delta)).toEqual(['{"location":', '"Denver"}']);

    expect(toolStarts).toEqual(['get_weather']);
    expect(toolDeltas).toEqual(['{"location":', '{"location":"Denver"}']);
  });

  it('keeps the text block payload correct when a tool block opens mid-text', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordEvents(eventTarget);

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Part 1');
      streaming.report?.({
        type: 'stream:tool-call-start',
        toolName: 'get_weather',
        blockId: 'toolu_01',
      });
      // A second text delta arrives while the tool block is the most recently
      // started one — the text events must still describe the text block.
      streaming.update('Part 1 Part 2');
      return { content: 'Part 1 Part 2', toolCalls: [] };
    };

    await withEnhancedStreaming(streamingGenerate, { eventTarget, liveToolCalls: true })(
      makeContext(),
    );

    const textBlockDeltas = eventsOfType(events, 'stream:block-delta').filter(
      (event) => event.block.type === 'text',
    );
    expect(textBlockDeltas.map((event) => event.delta)).toEqual(['Part 1', ' Part 2']);
  });

  it('reconstructs tool-call events when the streaming function reports none', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordEvents(eventTarget);

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.update('Checking');
      return {
        content: 'Checking',
        toolCalls: [{ name: 'get_weather', arguments: { location: 'Denver' } }],
      };
    };

    await withEnhancedStreaming(streamingGenerate, { eventTarget, liveToolCalls: true })(
      makeContext(),
    );

    const toolStart = events.find((event) => event.type === 'stream:tool-call-start');
    expect(toolStart?.blockId).toMatch(/^tool-get_weather-0-/);
  });

  it('carries reported tool-call blocks into the final stream state', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    let finalState: StreamState | undefined;

    eventTarget.addEventListener(
      'stream:complete',
      (event: StreamCustomEvent<'stream:complete'>) => {
        finalState = event.detail.state;
      },
    );

    await withEnhancedStreaming(reportingGenerate, { eventTarget, liveToolCalls: true })(
      makeContext(),
    );

    expect(finalState?.toolCalls).toHaveLength(1);
    expect(finalState?.toolCalls[0]).toMatchObject({
      id: 'toolu_01',
      toolName: 'get_weather',
      partialArguments: '{"location":"Denver"}',
      complete: true,
    });
  });

  it('synthesizes no completion for a reported block the response dropped', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordEvents(eventTarget);

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.report?.({
        type: 'stream:tool-call-start',
        toolName: 'get_weather',
        blockId: 'toolu_01',
      });
      // The adapter drops a caller-truncated tool call from the response.
      return { content: '', toolCalls: [] };
    };

    await withEnhancedStreaming(streamingGenerate, { eventTarget, liveToolCalls: true })(
      makeContext(),
    );

    expect(events.filter((event) => event.type === 'stream:tool-call-start')).toHaveLength(1);
    expect(events.some((event) => event.type === 'stream:tool-call-complete')).toBe(false);
  });

  it('implicitly starts a block when a delta is reported without a start', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordEvents(eventTarget);

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      // `report` is public surface, so a hand-written streaming function can
      // report out of order. The wrapper must not emit a payload describing a
      // block that was never opened.
      streaming.report?.({
        type: 'stream:tool-call-delta',
        toolName: 'get_weather',
        blockId: 'toolu_01',
        partialArguments: '{"location":"Denver"}',
      });
      return {
        content: '',
        toolCalls: [{ name: 'get_weather', arguments: { location: 'Denver' } }],
      };
    };

    await withEnhancedStreaming(streamingGenerate, { eventTarget, liveToolCalls: true })(
      makeContext(),
    );

    expect(events.map((event) => event.type)).toEqual([
      'stream:block-start',
      'stream:tool-call-start',
      'stream:block-delta',
      'stream:tool-call-delta',
      'stream:block-complete',
      'stream:tool-call-complete',
    ]);

    const blockStart = eventsOfType(events, 'stream:block-start')[0];
    expect(blockStart?.block).toMatchObject({
      id: 'toolu_01',
      type: 'tool-call',
      toolName: 'get_weather',
    });

    const blockDelta = eventsOfType(events, 'stream:block-delta')[0];
    expect(blockDelta?.block.id).toBe('toolu_01');
    expect(blockDelta?.delta).toBe('{"location":"Denver"}');
  });

  it('takes the completion tool name from the resolved response', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordEvents(eventTarget);

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      // A start reported before the adapter knew the final name.
      streaming.report?.({ type: 'stream:tool-call-start', toolName: '', blockId: 'toolu_01' });
      return { content: '', toolCalls: [{ name: 'get_weather', arguments: {} }] };
    };

    await withEnhancedStreaming(streamingGenerate, { eventTarget, liveToolCalls: true })(
      makeContext(),
    );

    expect(eventsOfType(events, 'stream:tool-call-complete')[0]).toMatchObject({
      toolName: 'get_weather',
      blockId: 'toolu_01',
    });
  });

  it('falls back to the reported name when the response leaves the tool unnamed', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordEvents(eventTarget);

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.report?.({
        type: 'stream:tool-call-start',
        toolName: 'get_weather',
        blockId: 'toolu_01',
      });
      return { content: '', toolCalls: [{ name: '', arguments: {} }] };
    };

    await withEnhancedStreaming(streamingGenerate, { eventTarget, liveToolCalls: true })(
      makeContext(),
    );

    expect(eventsOfType(events, 'stream:tool-call-complete')[0]?.toolName).toBe('get_weather');
  });

  it('pairs completions by call id when starts fire out of response order', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordEvents(eventTarget);

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      // OpenAI can hold one parallel call's start waiting for its name while a
      // later index's name has already arrived, so live start order need not
      // match the order the response lists the calls in. Pairing by ordinal
      // would hand each call's arguments to the other one's block.
      streaming.report?.({
        type: 'stream:tool-call-start',
        toolName: 'get_time',
        blockId: 'call_second',
      });
      streaming.report?.({
        type: 'stream:tool-call-start',
        toolName: 'get_weather',
        blockId: 'call_first',
      });
      return {
        content: '',
        toolCalls: [
          { id: 'call_first', name: 'get_weather', arguments: { location: 'Denver' } },
          { id: 'call_second', name: 'get_time', arguments: { zone: 'MST' } },
        ],
      };
    };

    await withEnhancedStreaming(streamingGenerate, { eventTarget, liveToolCalls: true })(
      makeContext(),
    );

    expect(
      eventsOfType(events, 'stream:tool-call-complete').map((event) => ({
        blockId: event.blockId,
        toolName: event.toolName,
        arguments: event.arguments,
      })),
    ).toEqual([
      { blockId: 'call_first', toolName: 'get_weather', arguments: { location: 'Denver' } },
      { blockId: 'call_second', toolName: 'get_time', arguments: { zone: 'MST' } },
    ]);
  });

  it('reconstructs response tool calls the streaming function never reported', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordEvents(eventTarget);

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      // Only the first of two calls is reported live. The second must still be
      // announced rather than vanishing because the live path ran at all.
      streaming.report?.({
        type: 'stream:tool-call-start',
        toolName: 'get_weather',
        blockId: 'call_first',
      });
      return {
        content: '',
        toolCalls: [
          { id: 'call_first', name: 'get_weather', arguments: { location: 'Denver' } },
          { name: 'get_time', arguments: { zone: 'MST' } },
        ],
      };
    };

    await withEnhancedStreaming(streamingGenerate, { eventTarget, liveToolCalls: true })(
      makeContext(),
    );

    const starts = eventsOfType(events, 'stream:tool-call-start');
    expect(starts.map((event) => event.toolName)).toEqual(['get_weather', 'get_time']);
    expect(starts[1]?.blockId).toMatch(/^tool-get_time-1-/);

    expect(
      eventsOfType(events, 'stream:tool-call-complete').map((event) => event.toolName),
    ).toEqual(['get_weather', 'get_time']);
  });

  it('carries an unreported tool call into the final stream state', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    let finalState: StreamState | undefined;

    eventTarget.addEventListener(
      'stream:complete',
      (event: StreamCustomEvent<'stream:complete'>) => {
        finalState = event.detail.state;
      },
    );

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.report?.({
        type: 'stream:tool-call-start',
        toolName: 'get_weather',
        blockId: 'call_first',
      });
      return {
        content: '',
        toolCalls: [
          { id: 'call_first', name: 'get_weather', arguments: {} },
          { name: 'get_time', arguments: {} },
        ],
      };
    };

    await withEnhancedStreaming(streamingGenerate, { eventTarget, liveToolCalls: true })(
      makeContext(),
    );

    expect(finalState?.toolCalls.map((block) => block.toolName)).toEqual([
      'get_weather',
      'get_time',
    ]);
  });

  it('ignores a start that arrives after a delta already opened the block', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordEvents(eventTarget);
    let finalState: StreamState | undefined;

    eventTarget.addEventListener(
      'stream:complete',
      (event: StreamCustomEvent<'stream:complete'>) => {
        finalState = event.detail.state;
      },
    );

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      // The delta opens the block implicitly; the delayed start then arrives
      // for the same id. Opening it twice would duplicate every start event and
      // leave a second state-machine block that nothing ever completes.
      streaming.report?.({
        type: 'stream:tool-call-delta',
        toolName: 'get_weather',
        blockId: 'toolu_01',
        partialArguments: '{"location":"Denver"}',
      });
      streaming.report?.({
        type: 'stream:tool-call-start',
        toolName: 'get_weather',
        blockId: 'toolu_01',
      });
      return {
        content: '',
        toolCalls: [{ id: 'toolu_01', name: 'get_weather', arguments: { location: 'Denver' } }],
      };
    };

    await withEnhancedStreaming(streamingGenerate, { eventTarget, liveToolCalls: true })(
      makeContext(),
    );

    expect(eventsOfType(events, 'stream:tool-call-start')).toHaveLength(1);
    expect(finalState?.toolCalls).toHaveLength(1);
    expect(finalState?.toolCalls[0]).toMatchObject({ id: 'toolu_01', complete: true });
  });

  it('reconciles a provisional block name from the resolved response', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordEvents(eventTarget);
    let finalState: StreamState | undefined;

    eventTarget.addEventListener(
      'stream:complete',
      (event: StreamCustomEvent<'stream:complete'>) => {
        finalState = event.detail.state;
      },
    );

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      streaming.report?.({ type: 'stream:tool-call-start', toolName: '', blockId: 'toolu_01' });
      return {
        content: '',
        toolCalls: [{ id: 'toolu_01', name: 'get_weather', arguments: {} }],
      };
    };

    await withEnhancedStreaming(streamingGenerate, { eventTarget, liveToolCalls: true })(
      makeContext(),
    );

    // The block APIs must not keep the provisional name once the response has
    // supplied the real one — `stream:tool-call-complete` alone is not enough.
    expect(eventsOfType(events, 'stream:block-complete').at(-1)?.block.toolName).toBe(
      'get_weather',
    );
    expect(finalState?.toolCalls[0]?.toolName).toBe('get_weather');
  });

  it('does not pair a reported block with an unrelated call when order is ambiguous', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordEvents(eventTarget);

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      // Only the SECOND returned call is reported, under a synthesized block id
      // that matches no response id. Consuming it for the first unmatched call
      // would publish get_weather's arguments on get_time's block.
      streaming.report?.({
        type: 'stream:tool-call-start',
        toolName: 'get_time',
        blockId: 'tool-1',
      });
      return {
        content: '',
        toolCalls: [
          { id: 'call_weather', name: 'get_weather', arguments: { location: 'Denver' } },
          { id: 'call_time', name: 'get_time', arguments: { zone: 'MST' } },
        ],
      };
    };

    await withEnhancedStreaming(streamingGenerate, { eventTarget, liveToolCalls: true })(
      makeContext(),
    );

    // No completion may carry get_weather's arguments on the reported block.
    const completions = eventsOfType(events, 'stream:tool-call-complete');
    expect(completions.some((event) => event.blockId === 'tool-1')).toBe(false);
    for (const completion of completions) {
      if (completion.toolName === 'get_weather') {
        expect(completion.arguments).toEqual({ location: 'Denver' });
      }
      if (completion.toolName === 'get_time') {
        expect(completion.arguments).toEqual({ zone: 'MST' });
      }
    }
    expect(completions.map((event) => event.toolName)).toEqual(['get_weather', 'get_time']);
  });

  it('pairs leftovers by arrival order when no call carries an id', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordEvents(eventTarget);

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      // A provider that supplies no tool-call ids at all: identity is available
      // to nobody, the counts match, so arrival order is the forced answer.
      streaming.report?.({ type: 'stream:tool-call-start', toolName: 'a', blockId: 'tool-0' });
      streaming.report?.({ type: 'stream:tool-call-start', toolName: 'b', blockId: 'tool-1' });
      return {
        content: '',
        toolCalls: [
          { name: 'a', arguments: { n: 1 } },
          { name: 'b', arguments: { n: 2 } },
        ],
      };
    };

    await withEnhancedStreaming(streamingGenerate, { eventTarget, liveToolCalls: true })(
      makeContext(),
    );

    expect(
      eventsOfType(events, 'stream:tool-call-complete').map((event) => ({
        blockId: event.blockId,
        arguments: event.arguments,
      })),
    ).toEqual([
      { blockId: 'tool-0', arguments: { n: 1 } },
      { blockId: 'tool-1', arguments: { n: 2 } },
    ]);
  });

  it('pairs each synthesized completion with the tool call at its own ordinal', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordEvents(eventTarget);

    const streamingGenerate: StreamingGenerateFunction = async ({ streaming }) => {
      for (const [blockId, toolName, args] of [
        ['toolu_01', 'get_weather', '{"location":"Denver"}'],
        ['toolu_02', 'get_time', '{"zone":"MST"}'],
      ] as const) {
        streaming.report?.({ type: 'stream:tool-call-start', toolName, blockId });
        streaming.report?.({
          type: 'stream:tool-call-delta',
          toolName,
          blockId,
          partialArguments: args,
        });
      }

      return {
        content: '',
        toolCalls: [
          { id: 'toolu_01', name: 'get_weather', arguments: { location: 'Denver' } },
          { id: 'toolu_02', name: 'get_time', arguments: { zone: 'MST' } },
        ],
      };
    };

    await withEnhancedStreaming(streamingGenerate, { eventTarget, liveToolCalls: true })(
      makeContext(),
    );

    // Arguments only become known after the response resolves, so each
    // completion is matched to its reported block by arrival order. Getting
    // that pairing wrong would hand one tool's arguments to another's blockId.
    expect(
      eventsOfType(events, 'stream:tool-call-complete').map((event) => ({
        blockId: event.blockId,
        toolName: event.toolName,
        arguments: event.arguments,
      })),
    ).toEqual([
      { blockId: 'toolu_01', toolName: 'get_weather', arguments: { location: 'Denver' } },
      { blockId: 'toolu_02', toolName: 'get_time', arguments: { zone: 'MST' } },
    ]);

    expect(
      eventsOfType(events, 'stream:tool-call-delta').map((event) => [
        event.blockId,
        event.partialArguments,
      ]),
    ).toEqual([
      ['toolu_01', '{"location":"Denver"}'],
      ['toolu_02', '{"zone":"MST"}'],
    ]);
  });
});

describe('withEnhancedStreaming — backend-descriptor propagation (AB-64, AB-245, AB-288)', () => {
  const FIXED_NOW = () => '2026-09-02T12:00:00.000Z';

  function anthropicDescriptor() {
    const descriptor = createModelCatalog({ now: FIXED_NOW }).descriptors.find(
      (row) => row.provider === 'anthropic',
    );
    if (!descriptor)
      throw new Error('expected at least one anthropic descriptor in the seed catalog');
    return descriptor;
  }

  it("preserves the wrapped function's attached descriptors on the returned wrapper", () => {
    const descriptor = anthropicDescriptor();
    const streamingGenerate: StreamingGenerateFunction = withBackendDescriptors(
      async ({ streaming }) => {
        streaming.update('hi');
        return { content: 'hi', toolCalls: [] };
      },
      [descriptor],
    );

    const wrapped = withEnhancedStreaming(streamingGenerate);

    expect(readBackendDescriptors(wrapped)).toEqual([descriptor]);
  });

  it("reports a fixed generation profile, not opaque, for an Agent whose generate is the wrapper's output", () => {
    const descriptor = anthropicDescriptor();
    const streamingGenerate: StreamingGenerateFunction = withBackendDescriptors(
      async ({ streaming }) => {
        streaming.update('hi');
        return { content: 'hi', toolCalls: [] };
      },
      [descriptor],
    );

    const agent = createAgent({ generate: withEnhancedStreaming(streamingGenerate) });

    expect(readGenerationProfile(agent).mode).toBe('fixed');
  });
});

describe('withEnhancedStreaming part events', () => {
  const thinkingPart = { type: 'thinking', thinking: 'Plan.', signature: 'sig-1' } as const;
  const inlineImage = {
    type: 'image',
    mimeType: 'image/png',
    source: { kind: 'inline', data: 'AAAAUNIQUEBYTES', encoding: 'base64' },
  } as const;

  function recordAll(eventTarget: TypedEventTarget<StreamEventMap>): StreamEvent[] {
    const events: StreamEvent[] = [];
    const types = [
      'stream:block-start',
      'stream:block-delta',
      'stream:block-complete',
      'stream:text-delta',
      'stream:part-start',
      'stream:part-delta',
      'stream:part-progress',
      'stream:part-complete',
      'stream:part-asset-linked',
      'stream:part-asset-available',
      'stream:part-failed',
      'stream:complete',
      'stream:error',
    ] as const;
    for (const type of types) {
      eventTarget.addEventListener(type, (event) => {
        events.push(event.detail);
      });
    }
    return events;
  }

  function partEvents(events: StreamEvent[], partIndex: number): string[] {
    return events
      .filter((event) => 'partIndex' in event && event.partIndex === partIndex)
      .map((event) => event.type);
  }

  it('emits one stable start, delta, complete sequence per part, parts interleaved in order', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordAll(eventTarget);
    const generate = withEnhancedStreaming(
      async ({ streaming }) => {
        streaming.reportPart?.({ type: 'start', partIndex: 0, kind: 'thinking' });
        streaming.reportPart?.({
          type: 'delta',
          partIndex: 0,
          sequence: 1,
          delta: { kind: 'thinking', thinking: 'Plan.' },
        });
        streaming.reportPart?.({ type: 'complete', partIndex: 0, part: thinkingPart });
        streaming.reportPart?.({ type: 'start', partIndex: 1, kind: 'text' });
        streaming.reportPart?.({
          type: 'delta',
          partIndex: 1,
          sequence: 1,
          delta: { kind: 'text', text: 'Hi' },
        });
        streaming.reportPart?.({
          type: 'delta',
          partIndex: 1,
          sequence: 2,
          delta: { kind: 'text', text: '!' },
        });
        streaming.reportPart?.({
          type: 'complete',
          partIndex: 1,
          part: { type: 'text', text: 'Hi!' },
        });
        return {
          content: 'Hi!',
          parts: [thinkingPart, { type: 'text', text: 'Hi!' }],
          toolCalls: [],
        };
      },
      { eventTarget },
    );

    const response = await generate(makeContext());

    expect(partEvents(events, 0)).toEqual([
      'stream:part-start',
      'stream:part-delta',
      'stream:part-complete',
    ]);
    expect(partEvents(events, 1)).toEqual([
      'stream:part-start',
      'stream:part-delta',
      'stream:part-delta',
      'stream:part-complete',
    ]);
    const deltas = events.filter((event) => event.type === 'stream:part-delta');
    expect(deltas.map((event) => event.sequence)).toEqual([1, 1, 2]);
    expect(
      events.every((event) => !('messageId' in event) || event.messageId === response.messageId),
    ).toBe(true);

    // The legacy text channel still reports answer text only, concatenated over text parts.
    const textDeltas = events.filter((event) => event.type === 'stream:text-delta');
    expect(textDeltas.map((event) => event.accumulated)).toEqual(['Hi', 'Hi!']);
  });

  it('ignores a duplicate delta and a delta after completion', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const states: StreamState[] = [];
    eventTarget.addEventListener('stream:complete', (event) => states.push(event.detail.state));
    const generate = withEnhancedStreaming(
      async ({ streaming }) => {
        streaming.reportPart?.({ type: 'start', partIndex: 0, kind: 'text' });
        const delta = { kind: 'text', text: 'Hi' } as const;
        streaming.reportPart?.({ type: 'delta', partIndex: 0, sequence: 1, delta });
        streaming.reportPart?.({ type: 'delta', partIndex: 0, sequence: 1, delta });
        streaming.reportPart?.({
          type: 'complete',
          partIndex: 0,
          part: { type: 'text', text: 'Hi' },
        });
        streaming.reportPart?.({
          type: 'delta',
          partIndex: 0,
          sequence: 2,
          delta: { kind: 'text', text: ' late' },
        });
        return { content: 'Hi', parts: [{ type: 'text', text: 'Hi' }], toolCalls: [] };
      },
      { eventTarget },
    );

    await generate(makeContext());

    expect(states).toHaveLength(1);
    expect(states[0]?.parts[0]?.text).toBe('Hi');
    expect(states[0]?.textContent).toBe('Hi');
  });

  it('gives a media part progress and link events, and no event ever shows its bytes', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordAll(eventTarget);
    const admitter = createScriptedMediaAdmitter();
    const controller = new AbortController();
    const generate = withEnhancedStreaming(
      async ({ streaming }) => {
        streaming.reportPart?.({
          type: 'start',
          partIndex: 0,
          kind: 'image',
          mimeType: 'image/png',
        });
        streaming.reportPart?.({
          type: 'progress',
          partIndex: 0,
          sequence: 1,
          receivedBytes: 15,
          totalBytes: 15,
        });
        streaming.reportPart?.({ type: 'complete', partIndex: 0, part: inlineImage });
        return { content: '', parts: [inlineImage], toolCalls: [] };
      },
      { eventTarget },
    );

    await generate(
      makeContext({
        signal: controller.signal,
        generatedMediaAdmitter: createStepGeneratedMediaAdmitter({
          port: admitter.port,
          runId: 'run-1',
          step: 0,
          signal: controller.signal,
        }),
      }),
    );

    expect(partEvents(events, 0)).toEqual([
      'stream:part-start',
      'stream:part-progress',
      'stream:part-complete',
      'stream:part-asset-linked',
      'stream:part-asset-available',
    ]);
    expect(JSON.stringify(events)).not.toContain('UNIQUEBYTES');
    const complete = events.find((event) => event.type === 'stream:part-complete');
    expect(complete?.type === 'stream:part-complete' && 'source' in complete.part).toBe(false);
    const finalState = events.find((event) => event.type === 'stream:complete');
    expect(finalState?.type === 'stream:complete' && finalState.state.parts[0]?.part).toMatchObject(
      {
        type: 'image',
        source: { kind: 'managed-asset', assetId: 'asset-1' },
      },
    );
  });

  it('emits part-failed for a refused admission and a single stream:error, never a stream:complete', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordAll(eventTarget);
    const admitter = createScriptedMediaAdmitter({ mode: 'reject' });
    const controller = new AbortController();
    const generate = withEnhancedStreaming(
      async ({ streaming }) => {
        streaming.reportPart?.({ type: 'start', partIndex: 0, kind: 'image' });
        streaming.reportPart?.({ type: 'complete', partIndex: 0, part: inlineImage });
        return { content: '', parts: [inlineImage], toolCalls: [] };
      },
      { eventTarget },
    );

    let error: unknown;
    try {
      await generate(
        makeContext({
          signal: controller.signal,
          generatedMediaAdmitter: createStepGeneratedMediaAdmitter({
            port: admitter.port,
            runId: 'run-1',
            step: 0,
            signal: controller.signal,
          }),
        }),
      );
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeDefined();
    expect(events.map((event) => event.type)).toContain('stream:part-failed');
    expect(events.filter((event) => event.type === 'stream:error')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'stream:complete')).toHaveLength(0);
  });

  it('emits exactly one terminal event when the row cannot be finalized, and stream:complete comes last', async () => {
    const eventTarget = new TypedEventTarget<StreamEventMap>();
    const events = recordAll(eventTarget);
    const real = new Conversation();
    let failFinalize = true;
    // `finalizeStreamingMessage` is an installed, read-only member, so wrap the conversation.
    const conversation = new Proxy(real, {
      get(target, property) {
        if (property === 'finalizeStreamingMessage' && failFinalize) {
          return () => {
            throw new Error('finalize failed');
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const generate = withEnhancedStreaming(
      async ({ streaming }) => {
        streaming.update('Hi');
        return textResponse('Hi');
      },
      { eventTarget },
    );

    let error: unknown;
    try {
      await generate(makeContext({ conversation }));
    } catch (thrown) {
      error = thrown;
    }
    expect((error as Error).message).toBe('finalize failed');
    expect(events.filter((event) => event.type === 'stream:error')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'stream:complete')).toHaveLength(0);

    failFinalize = false;
    const ok: StreamEvent[] = [];
    const okTarget = new TypedEventTarget<StreamEventMap>();
    for (const type of ['stream:complete', 'stream:error', 'stream:part-complete'] as const) {
      okTarget.addEventListener(type, (event) => ok.push(event.detail));
    }
    await withEnhancedStreaming(
      async ({ streaming }) => {
        streaming.update('Hi');
        return textResponse('Hi');
      },
      { eventTarget: okTarget },
    )(makeContext());
    expect(ok.map((event) => event.type)).toEqual(['stream:part-complete', 'stream:complete']);
  });
});
