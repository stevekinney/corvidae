import { HookRegistry, TypedEventTarget } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, type MultiModalContent } from 'conversationalist';
import { z } from 'zod';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { withCache } from '../src/cache/with-cache';
import { noToolCalls } from '../src/conditions/predicates';
import { createAgent } from '../src/create-agent';
import { createActiveRun } from '../src/create-run';
import {
  agentRunErrorToJSON,
  GeneratedMediaNotAdmittedError,
  ResponsePartsMismatchError,
} from '../src/errors';
import type { ReplayDataDroppedEvent } from '../src/events';
import type { OperativeHookMap } from '../src/hooks';
import { executeLoop } from '../src/loop';
import { createAnthropicProvider, createAnthropicProviderStream } from '../src/providers/anthropic';
import {
  ProviderContractError,
  ProviderError,
  shouldRetryProviderError,
} from '../src/providers/errors';
import { createGeminiProvider, createGeminiProviderStream } from '../src/providers/gemini';
import { createGeminiPartMapper } from '../src/providers/gemini-parts';
import { createOpenAIProvider, createOpenAIProviderStream } from '../src/providers/openai';
import { normalizeAnthropicStream } from '../src/providers/streaming/normalize-anthropic';
import { normalizeOpenAIStream } from '../src/providers/streaming/normalize-openai';
import {
  createMockAnthropicClient,
  createMockAnthropicStreamingClient,
  createMockGeminiModel,
  createMockGeminiStreamingModel,
  createMockOpenAIClient,
  createMockOpenAIStreamingClient,
} from '../src/providers/test/mock-clients';
import { withStreaming } from '../src/streaming';
import { withEnhancedStreaming } from '../src/streaming/enhanced-streaming';
import type { LivePartEvent, StreamEvent, StreamEventMap } from '../src/streaming/types';
import { createMockGenerate, createRunRecorder } from '../src/test/index';
import { createScriptedMediaAdmitter } from '../src/testing/generated-media.test-support';
import type { GenerateContext, GenerateResponse, RunOptions, StreamingHandle } from '../src/types';
import {
  anthropicStreamEventsFor,
  citedTextBlock,
  type RecordedAnthropicBlock,
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

let callCounter = 0;
/** A fresh tool call each time: a conversation rejects a duplicate tool-call id. */
const weatherCall = (): { id: string; name: string; arguments: { location: string } } => ({
  id: `call-${++callCounter}`,
  name: 'get_weather',
  arguments: { location: 'Paris' },
});

/** Serializes for a bytes-leak check: skips live conversations and survives cycles. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (key, nested: unknown) => {
    if (key === 'conversation') return undefined;
    if (typeof nested === 'object' && nested !== null) {
      if (seen.has(nested)) return undefined;
      seen.add(nested);
    }
    return nested;
  });
}
const thinkingPart: MultiModalContent = {
  type: 'thinking',
  thinking: 'I should check the weather.',
  signature: 'sig-abc',
};
const textPart = (text: string): MultiModalContent => ({ type: 'text', text });
const inlineImage: MultiModalContent = {
  type: 'image',
  mimeType: 'image/png',
  source: { kind: 'inline', data: 'AAAAUNIQUEBYTES', encoding: 'base64' },
};

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

describe('multimodal output errors', () => {
  it('ProviderContractError names the provider, block type, part index and billed usage', () => {
    const usage = { prompt: 3, completion: 5, total: 8 };
    const error = new ProviderContractError({
      provider: 'gemini',
      reason: 'unlisted-block',
      blockType: 'executableCode',
      partIndex: 2,
      usage,
    });

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.provider).toBe('gemini');
    expect(error.reason).toBe('unlisted-block');
    expect(error.blockType).toBe('executableCode');
    expect(error.partIndex).toBe(2);
    expect(error.usage).toEqual(usage);
    expect(error.retryable).toBe(false);
    expect(shouldRetryProviderError(error)).toBe(false);
    expect(error.message).toContain('executableCode');
    expect(error.message).toContain('gemini');
  });

  it('GeneratedMediaNotAdmittedError is a policy error with its own code and names the part', () => {
    const error = new GeneratedMediaNotAdmittedError({
      reason: 'no-admitter',
      step: 1,
      partIndex: 0,
      messageId: 'row-1',
      modality: 'image',
    });

    expect(error.kind).toBe('policy');
    expect(error.code).toBe('GENERATED_MEDIA_NOT_ADMITTED');
    expect(error.reason).toBe('no-admitter');
    expect(error.message).toContain('image');
    expect(error.message).toContain('part 0');
    expect(agentRunErrorToJSON(error).code).toBe('GENERATED_MEDIA_NOT_ADMITTED');
  });

  it('ResponsePartsMismatchError is a contract error with its own code', () => {
    const error = new ResponsePartsMismatchError({
      step: 2,
      source: 'afterGenerate',
      contentLength: 3,
      textPartsLength: 9,
    });

    expect(error.kind).toBe('contract');
    expect(error.code).toBe('RESPONSE_PARTS_MISMATCH');
    expect(error.source).toBe('afterGenerate');
    expect(error.message).toContain('afterGenerate');
  });
});

describe('result parts', () => {
  it('derives one text part from a caller-supplied generate that returns only content', async () => {
    const result = await run(
      baseOptions(createMockGenerate([{ content: 'Hello', toolCalls: [] }])),
    );

    expect(result.steps[0]?.parts).toEqual([textPart('Hello')]);
    expect(result.steps[0]?.content).toBe('Hello');
    expect(result.parts).toEqual([textPart('Hello')]);
    expect(result.content).toBe('Hello');
  });

  it('derives no parts from empty content, and commits no row for the step', async () => {
    const result = await run(
      baseOptions(
        createMockGenerate([
          { content: '', toolCalls: [weatherCall()] },
          { content: 'Done', toolCalls: [] },
        ]),
      ),
    );

    expect(result.steps[0]?.parts).toEqual([]);
    expect(result.steps[0]?.messageId).toBeUndefined();
  });

  it('makes RunResult.parts run-wide, in step order', async () => {
    const result = await run(
      baseOptions(
        createMockGenerate([
          { content: 'Checking.', toolCalls: [weatherCall()] },
          { content: 'Sunny.', toolCalls: [] },
        ]),
      ),
    );

    expect(result.steps.map((step) => step.parts)).toEqual([
      [textPart('Checking.')],
      [textPart('Sunny.')],
    ]);
    expect(result.parts).toEqual([textPart('Checking.'), textPart('Sunny.')]);
    expect(result.content).toBe('Sunny.');
  });

  it('includes an onMaximumSteps replacement row in RunResult.parts', async () => {
    const result = await run(
      baseOptions(
        createMockGenerate([
          { content: 'One.', toolCalls: [weatherCall()] },
          { content: 'Two.', toolCalls: [weatherCall()] },
        ]),
        { maximumSteps: 2, stopWhen: undefined, onMaximumSteps: async () => 'Summary.' },
      ),
    );

    expect(result.finishReason).toBe('maximum-steps');
    expect(result.parts).toEqual([textPart('One.'), textPart('Two.'), textPart('Summary.')]);
    expect(result.content).toBe('Summary.');
  });

  it('does not repeat the last step when the final row is not a replacement', async () => {
    const result = await run(
      baseOptions(createMockGenerate([{ content: 'Only.', toolCalls: [] }]), {
        maximumSteps: 1,
        stopWhen: undefined,
        onMaximumSteps: async () => undefined,
      }),
    );

    expect(result.parts).toEqual([textPart('Only.')]);
  });

  it('names the committed row in StepResult.messageId', async () => {
    const result = await run(
      baseOptions(
        createMockGenerate([
          { content: 'Checking.', toolCalls: [weatherCall()] },
          { content: 'Sunny.', toolCalls: [] },
        ]),
      ),
    );

    const assistantRows = result.conversation.getMessages().filter((m) => m.role === 'assistant');
    expect(result.steps.map((step) => step.messageId)).toEqual(assistantRows.map((m) => m.id));
  });

  it('commits a thinking-then-tool step as a row, where it used to be lost', async () => {
    const responses: GenerateResponse[] = [
      { content: '', parts: [thinkingPart], toolCalls: [weatherCall()] },
      { content: 'Sunny.', toolCalls: [] },
    ];
    const requestRoles: string[][] = [];
    let call = 0;

    const result = await run(
      baseOptions(async (context) => {
        requestRoles.push(context.conversation.getMessages().map((message) => message.role));
        return responses[call++]!;
      }),
    );

    const [firstAssistant] = result.conversation
      .getMessages()
      .filter((m) => m.role === 'assistant');
    expect(firstAssistant?.content).toEqual([thinkingPart]);
    expect(result.steps[0]?.parts).toEqual([thinkingPart]);
    expect(result.steps[0]?.messageId).toBe(firstAssistant?.id);
    // The next request sees the thinking row before the tool call.
    expect(requestRoles[1]).toEqual(['assistant', 'tool-call', 'tool-result']);
  });

  it('hands stop conditions and validation hooks the step parts', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    const seen: unknown[] = [];
    hooks.on('validateResponse', async (response) => {
      seen.push(['validate', response.parts]);
    });
    const result = await run(
      baseOptions(createMockGenerate([{ content: 'Hi', parts: [textPart('Hi')], toolCalls: [] }]), {
        hooks,
        stopWhen: (step) => {
          seen.push(['stop', step.parts, step.messageId !== undefined]);
          return true;
        },
      }),
    );

    expect(result.finishReason).toBe('stop-condition');
    expect(seen).toEqual([
      ['validate', [textPart('Hi')]],
      ['stop', [textPart('Hi')], true],
    ]);
  });
});

describe('hooks are authoritative', () => {
  const thinkingAndText: GenerateResponse = {
    content: 'secret answer',
    parts: [thinkingPart, textPart('secret answer')],
    toolCalls: [],
  };

  it('leaves only the redacted text in the parts, the row and the next request', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateResponse', async () => ({ content: '[redacted]', toolCalls: [] }));
    const generate = createMockGenerate([thinkingAndText]);

    const result = await run(baseOptions(generate, { hooks }));

    expect(result.steps[0]?.parts).toEqual([textPart('[redacted]')]);
    expect(result.parts).toEqual([textPart('[redacted]')]);
    const rows = result.conversation.getMessages().filter((m) => m.role === 'assistant');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe('[redacted]');
    expect(JSON.stringify(result.conversation.current)).not.toContain('secret answer');
    expect(JSON.stringify(result.conversation.current)).not.toContain('sig-abc');
  });

  it('applies the same rule to an afterGenerate hook', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('afterGenerate', async () => ({ content: 'swapped', toolCalls: [] }));

    const result = await run(baseOptions(createMockGenerate([thinkingAndText]), { hooks }));

    expect(result.steps[0]?.parts).toEqual([textPart('swapped')]);
  });

  it('fails the step with the typed error when a hook returns stale parts', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateResponse', async (response) => ({ ...response, content: 'changed' }));

    const result = await run(baseOptions(createMockGenerate([thinkingAndText]), { hooks }));

    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(ResponsePartsMismatchError);
    expect((result.error as ResponsePartsMismatchError).source).toBe('validateResponse');
    expect(result.usage).toEqual({ prompt: 0, completion: 0, total: 0 });
  });

  it('does not retry or recover a parts mismatch through onError', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    let errorHookCalls = 0;
    hooks.on('afterGenerate', async (context) => ({ ...context.response, content: 'changed' }));
    hooks.on('onError', async () => {
      errorHookCalls++;
      return 'retry';
    });
    const generate = createMockGenerate([thinkingAndText, thinkingAndText]);

    const result = await run(baseOptions(generate, { hooks }));

    expect(result.error).toBeInstanceOf(ResponsePartsMismatchError);
    expect(errorHookCalls).toBe(0);
    expect(generate.callCount).toBe(1);
  });

  it('keeps the parts of a response that passes every hook unchanged', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateResponse', async () => undefined);
    hooks.on('afterGenerate', async () => undefined);

    const result = await run(baseOptions(createMockGenerate([thinkingAndText]), { hooks }));

    expect(result.steps[0]?.parts).toEqual(thinkingAndText.parts);
  });

  it('derives parts for a prepareStep response that returns only content', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('prepareStep', async () => ({ content: 'From the hook', toolCalls: [] }));
    const generate = createMockGenerate([]);

    const result = await run(baseOptions(generate, { hooks }));

    expect(generate.callCount).toBe(0);
    expect(result.steps[0]?.parts).toEqual([textPart('From the hook')]);
  });

  it('admits an inline media part a prepareStep response carries', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('prepareStep', async () => ({
      content: '',
      parts: [inlineImage],
      toolCalls: [],
    }));
    const admitter = createScriptedMediaAdmitter();

    const result = await run(
      baseOptions(createMockGenerate([]), { hooks, generatedMediaAdmitter: admitter.port }),
    );

    expect(result.steps[0]?.parts).toMatchObject([
      { type: 'image', source: { kind: 'managed-asset', assetId: 'asset-1' } },
    ]);
    expect(JSON.stringify(result.conversation.current)).not.toContain('UNIQUEBYTES');
  });
});

describe('generated media', () => {
  const imageResponse: GenerateResponse = {
    content: '',
    parts: [inlineImage],
    toolCalls: [],
    usage: { prompt: 5, completion: 3, total: 8 },
  };

  it('admits an inline image as a managed asset before any hook, event or row sees it', async () => {
    const admitter = createScriptedMediaAdmitter();
    const hooks = new HookRegistry<OperativeHookMap>();
    const inlineSightings: string[] = [];
    const watch = (label: string, value: unknown): void => {
      if (JSON.stringify(value).includes('UNIQUEBYTES')) inlineSightings.push(label);
    };
    hooks.on('afterGenerate', async (context) => {
      watch('afterGenerate', context.response);
    });
    hooks.on('validateResponse', async (response) => {
      watch('validateResponse', response);
    });
    hooks.on('onLLMOutput', async (context) => {
      watch('onLLMOutput', context.response);
    });

    const run_ = createActiveRun(
      baseOptions(createMockGenerate([imageResponse]), {
        hooks,
        generatedMediaAdmitter: admitter.port,
        runId: 'run-1',
      }),
    );
    const recorder = createRunRecorder(run_);
    const result = await run_.result;

    const source = { kind: 'managed-asset', assetId: 'asset-1', revision: 1 } as const;
    expect(result.steps[0]?.parts).toEqual([{ ...inlineImage, source }]);
    expect(result.parts).toEqual([{ ...inlineImage, source }]);
    const row = result.conversation.getMessages().find((m) => m.role === 'assistant');
    expect(row?.content).toEqual([{ ...inlineImage, source }]);
    expect(inlineSightings).toEqual([]);
    expect(safeStringify(recorder.events.map((event) => event.detail))).not.toContain(
      'UNIQUEBYTES',
    );
    expect(safeStringify(result)).not.toContain('UNIQUEBYTES');
    expect(admitter.admissions[0]?.request).toMatchObject({
      runId: 'run-1',
      step: 0,
      partIndex: 0,
    });
    expect(admitter.admissions[0]?.settlement?.outcome).toBe('available');
  });

  it('fails the step with a typed error when the run has no admission port', async () => {
    const result = await run(baseOptions(createMockGenerate([imageResponse])));

    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(GeneratedMediaNotAdmittedError);
    expect((result.error as GeneratedMediaNotAdmittedError).reason).toBe('no-admitter');
    expect(result.usage).toEqual({ prompt: 5, completion: 3, total: 8 });
    expect(result.conversation.getMessages()).toHaveLength(0);
  });

  it('ends the run with finishReason error, naming the part, when an admission is refused', async () => {
    const admitter = createScriptedMediaAdmitter({ mode: 'reject' });
    const result = await run(
      baseOptions(createMockGenerate([imageResponse]), { generatedMediaAdmitter: admitter.port }),
    );

    expect(result.finishReason).toBe('error');
    const error = result.error as GeneratedMediaNotAdmittedError;
    expect(error).toBeInstanceOf(GeneratedMediaNotAdmittedError);
    expect(error.reason).toBe('admission-failed');
    expect(error.partIndex).toBe(0);
    expect(error.rejectionCode).toBe('per-part-limit-exceeded');
    expect(error.message).toContain('part 0');
  });

  it('does not let onError recover a refused admission', async () => {
    const admitter = createScriptedMediaAdmitter({ mode: 'reject' });
    const hooks = new HookRegistry<OperativeHookMap>();
    let calls = 0;
    hooks.on('onError', async () => {
      calls++;
      return 'skip';
    });
    const result = await run(
      baseOptions(createMockGenerate([imageResponse]), {
        hooks,
        generatedMediaAdmitter: admitter.port,
      }),
    );

    expect(result.finishReason).toBe('error');
    expect(calls).toBe(0);
  });
});

describe('the non-fatal replay-data signal', () => {
  it('dispatches ReplayDataDroppedEvent from the generate response, before any hook can hide it', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('afterGenerate', async () => ({ content: 'hook text', toolCalls: [] }));
    const run_ = createActiveRun(
      baseOptions(
        createMockGenerate([
          {
            content: 'Hi',
            parts: [textPart('Hi')],
            toolCalls: [],
            metadata: {
              replayDataDropped: [
                { provider: 'gemini', providerPartIndex: 0, field: 'thoughtSignature' },
              ],
            },
          },
        ]),
        { hooks },
      ),
    );
    const recorder = createRunRecorder(run_);
    const result = await run_.result;

    expect(result.finishReason).toBe('stop-condition');
    const events = recorder.events.filter((event) => event.type === 'generate.replay-data-dropped');
    expect(events).toHaveLength(1);
    const event = events[0]?.detail as ReplayDataDroppedEvent;
    expect(event.step).toBe(0);
    expect(event.dropped).toEqual([
      { provider: 'gemini', providerPartIndex: 0, field: 'thoughtSignature' },
    ]);
  });

  it('dispatches nothing for a response without the field', async () => {
    const run_ = createActiveRun(
      baseOptions(createMockGenerate([{ content: 'Hi', toolCalls: [] }])),
    );
    const recorder = createRunRecorder(run_);
    await run_.result;

    expect(
      recorder.events.filter((event) => event.type === 'generate.replay-data-dropped'),
    ).toEqual([]);
  });
});

describe('cleanup waits for generated-media admissions', () => {
  const imageResponse: GenerateResponse = { content: '', parts: [inlineImage], toolCalls: [] };

  function admissionSignal(): { promise: Promise<void>; resolve: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, resolve: release };
  }

  it('holds the terminal result until the admission settles', async () => {
    const admitted = admissionSignal();
    const admitter = createScriptedMediaAdmitter({ mode: 'manual', onAdmit: admitted.resolve });
    const run_ = createActiveRun(
      baseOptions(createMockGenerate([imageResponse]), { generatedMediaAdmitter: admitter.port }),
    );
    let resultSettled = false;
    void run_.result.then(() => {
      resultSettled = true;
    });

    await admitted.promise;
    await Promise.resolve();
    expect(resultSettled).toBe(false);

    const [record] = admitter.admissions;
    record?.settle({ outcome: 'available', source: record.source, mimeType: 'image/png' });
    const result = await run_.result;

    expect(result.finishReason).toBe('stop-condition');
    expect(result.parts).toMatchObject([{ source: { kind: 'managed-asset' } }]);
    expect(await run_.closed()).toEqual({ status: 'completed' });
  });

  it('returns completed from closed() after a failed admission', async () => {
    const admitter = createScriptedMediaAdmitter({ mode: 'reject' });
    const run_ = createActiveRun(
      baseOptions(createMockGenerate([imageResponse]), { generatedMediaAdmitter: admitter.port }),
    );
    const result = await run_.result;

    expect(result.finishReason).toBe('error');
    expect(await run_.closed()).toEqual({ status: 'completed' });
    expect(admitter.admissions[0]?.settlement?.outcome).toBe('rejected');
  });

  it('aborts a pending admission on cancellation and leaves none pending once closed() resolves', async () => {
    const admitted = admissionSignal();
    const admitter = createScriptedMediaAdmitter({ mode: 'manual', onAdmit: admitted.resolve });
    const run_ = createActiveRun(
      baseOptions(createMockGenerate([imageResponse]), { generatedMediaAdmitter: admitter.port }),
    );

    await admitted.promise;
    run_.abort('stop');
    const result = await run_.result;
    const acknowledgement = await run_.closed({ signal: new AbortController().signal });

    expect(result.finishReason).toBe('aborted');
    expect(admitter.admissions[0]?.aborted).toBe(true);
    expect(admitter.admissions[0]?.settlement?.outcome).toBe('aborted');
    expect(acknowledgement).toEqual({ status: 'completed' });
  });

  it('returns unresolved with unknown-effect when an admission outcome cannot be confirmed', async () => {
    const admitter = createScriptedMediaAdmitter({
      closedOutcome: { status: 'unresolved', reason: 'persistence-failed' },
    });
    const run_ = createActiveRun(
      baseOptions(createMockGenerate([imageResponse]), { generatedMediaAdmitter: admitter.port }),
    );
    await run_.result;

    expect(await run_.closed()).toEqual({ status: 'unresolved', reason: 'unknown-effect' });
  });

  it('returns unresolved with timed-out when the caller signal aborts before the admission settles', async () => {
    const admitted = admissionSignal();
    const admitter = createScriptedMediaAdmitter({
      mode: 'manual',
      ignoreAbort: true,
      onAdmit: admitted.resolve,
    });
    const run_ = createActiveRun(
      baseOptions(createMockGenerate([imageResponse]), { generatedMediaAdmitter: admitter.port }),
    );

    await admitted.promise;
    run_.abort('stop');
    const caller = new AbortController();
    const closing = run_.closed({ signal: caller.signal });
    caller.abort();

    expect(await closing).toEqual({ status: 'unresolved', reason: 'timed-out' });
    expect(admitter.admissions[0]?.settlement).toBeUndefined();
  });
});

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

describe('createAgent carries the media-admission port to its runs', () => {
  it('admits a generated image through the agent option', async () => {
    const admitter = createScriptedMediaAdmitter();
    const agent = createAgent({
      generate: createMockGenerate([{ content: '', parts: [inlineImage], toolCalls: [] }]),
      generatedMediaAdmitter: admitter.port,
    });

    const result = await agent.run('Draw').result();

    expect(result.parts).toMatchObject([{ type: 'image', source: { kind: 'managed-asset' } }]);
    expect(admitter.admissions).toHaveLength(1);
  });
});

describe('a run with an id commits parts under the ids a streaming client was shown', () => {
  const thinkingToolStep: GenerateResponse = {
    content: '',
    parts: [thinkingPart],
    toolCalls: [{ id: 'call-a', name: 'get_weather', arguments: { location: 'Paris' } }],
  };

  it('names a thinking-only row <runId>:step:<n>, and the first tool call after it', async () => {
    const result = await run(
      baseOptions(createMockGenerate([thinkingToolStep, { content: 'Sunny.', toolCalls: [] }]), {
        runId: 'run-7',
      }),
    );

    const ids = result.conversation.getMessages().map((message) => [message.role, message.id]);
    expect(ids).toEqual([
      ['assistant', 'run-7:step:0'],
      ['tool-call', 'run-7:step:0:call:call-a'],
      ['tool-result', 'run-7:step:0:result:call-a'],
      ['assistant', 'run-7:step:1'],
    ]);
    expect(result.steps.map((step) => step.messageId)).toEqual(['run-7:step:0', 'run-7:step:1']);
  });

  it('keeps the same row id when a hook replaces a streamed row', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateResponse', async () => ({ content: '[redacted]', toolCalls: [] }));
    const generate = withStreaming(async ({ streaming }) => {
      streaming.reportPart?.({ type: 'start', partIndex: 0, kind: 'text' });
      streaming.reportPart?.({
        type: 'delta',
        partIndex: 0,
        sequence: 1,
        delta: { kind: 'text', text: 'secret' },
      });
      streaming.reportPart?.({ type: 'complete', partIndex: 0, part: textPart('secret') });
      return { content: 'secret', parts: [textPart('secret')], toolCalls: [] };
    });

    const result = await run(baseOptions(generate, { hooks, runId: 'run-8' }));

    const rows = result.conversation
      .getMessages()
      .filter((message) => message.role === 'assistant');
    expect(rows.map((row) => [row.id, row.content])).toEqual([['run-8:step:0', '[redacted]']]);
    expect(result.steps[0]?.messageId).toBe('run-8:step:0');
  });

  it('commits an onMaximumSteps replacement under the next step id and reports it run-wide', async () => {
    const result = await run(
      baseOptions(createMockGenerate([{ content: 'One.', toolCalls: [weatherCall()] }]), {
        runId: 'run-9',
        maximumSteps: 1,
        stopWhen: undefined,
        onMaximumSteps: async () => 'Summary.',
      }),
    );
    const rows = result.conversation
      .getMessages()
      .filter((message) => message.role === 'assistant');
    expect(rows.map((row) => row.id)).toEqual(['run-9:step:0', 'run-9:step:1']);
    expect(result.parts).toEqual([textPart('One.'), textPart('Summary.')]);
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

describe('a cached streamed response never rewinds a historical row (correction)', () => {
  it('appends a fresh row and keeps every later turn when a hook changes the cached content', async () => {
    const store = textValueStore(new MemoryStorage());
    const streaming = withStreaming(async ({ streaming: handle }) => {
      handle.update('cached answer');
      return { content: 'cached answer', toolCalls: [] };
    });
    const cached = withCache(streaming, { store, keyStrategy: () => 'same-key' });
    const conversation = new Conversation();

    conversation.appendUserMessage('first question');
    await run(baseOptions(cached, { conversation }));
    conversation.appendUserMessage('second question');

    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateResponse', async () => ({ content: 'edited', toolCalls: [] }));
    const result = await run(baseOptions(cached, { conversation, hooks }));

    const rows = result.conversation
      .getMessages()
      .map((message) => [message.role, message.content]);
    expect(rows).toEqual([
      ['user', 'first question'],
      ['assistant', 'cached answer'],
      ['user', 'second question'],
      ['assistant', 'edited'],
    ]);
    expect(result.steps[0]?.messageId).toBe(result.conversation.getMessages().at(-1)?.id);
  });

  it('appends a fresh row for a cached streamed response a hook leaves unchanged', async () => {
    const store = textValueStore(new MemoryStorage());
    const cached = withCache(
      withStreaming(async ({ streaming: handle }) => {
        handle.update('cached answer');
        return { content: 'cached answer', toolCalls: [] };
      }),
      { store, keyStrategy: () => 'same-key' },
    );
    const conversation = new Conversation();
    conversation.appendUserMessage('first question');
    await run(baseOptions(cached, { conversation }));
    conversation.appendUserMessage('second question');

    const result = await run(baseOptions(cached, { conversation }));

    expect(result.conversation.getMessages().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });
});

describe('a cached streamed response names no row of this step, with and without a run id (correction 2)', () => {
  async function replay(runId: string | undefined) {
    const store = textValueStore(new MemoryStorage());
    const cached = withCache(
      withStreaming(async ({ streaming: handle }) => {
        handle.update('cached answer');
        return { content: 'cached answer', toolCalls: [] };
      }),
      { store, keyStrategy: () => 'same-key' },
    );
    const conversation = new Conversation();
    conversation.appendUserMessage('first question');
    await executeLoop(baseOptions(cached, { conversation }));
    conversation.appendUserMessage('second question');
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateResponse', async () => ({ content: 'edited', toolCalls: [] }));
    const result = await executeLoop(
      baseOptions(cached, {
        conversation,
        hooks,
        ...(runId === undefined ? {} : { runId }),
      }),
    );
    return result.conversation.getMessages();
  }

  it('with no run id, appends an unnamed row and keeps every later turn', async () => {
    const rows = await replay(undefined);

    expect(rows.map((row) => [row.role, row.content])).toEqual([
      ['user', 'first question'],
      ['assistant', 'cached answer'],
      ['user', 'second question'],
      ['assistant', 'edited'],
    ]);
    expect(rows.at(-1)?.id).not.toContain(':step:');
  });

  it('with a run id, appends the row under its derived id and keeps every later turn', async () => {
    const rows = await replay('run-cache');

    expect(rows.map((row) => row.content)).toEqual([
      'first question',
      'cached answer',
      'second question',
      'edited',
    ]);
    expect(rows.at(-1)?.id).toBe('run-cache:step:0');
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

describe('the generated parts of one response are admitted together (correction)', () => {
  const secondImage: MultiModalContent = {
    type: 'image',
    mimeType: 'image/png',
    source: { kind: 'inline', data: 'BBBBSECONDBYTES', encoding: 'base64' },
  };
  const twoImages: GenerateResponse = {
    content: '',
    parts: [inlineImage, secondImage],
    toolCalls: [],
  };

  it('hands a batch-capable port every inline part in one admitAll call', async () => {
    const admitter = createScriptedMediaAdmitter({ batch: true });

    const result = await run(
      baseOptions(createMockGenerate([twoImages]), { generatedMediaAdmitter: admitter.port }),
    );

    expect(result.finishReason).toBe('stop-condition');
    expect(admitter.batches).toEqual([2]);
    expect(admitter.admissions.map((record) => record.request.partIndex)).toEqual([0, 1]);
    expect(result.parts).toMatchObject([
      { source: { assetId: 'asset-1' } },
      { source: { assetId: 'asset-2' } },
    ]);
  });

  it('falls back to one admit per part for a port with no batch call', async () => {
    const admitter = createScriptedMediaAdmitter();
    await run(
      baseOptions(createMockGenerate([twoImages]), { generatedMediaAdmitter: admitter.port }),
    );
    expect(admitter.batches).toEqual([]);
    expect(admitter.admissions).toHaveLength(2);
  });

  it('aborts the sibling admissions when one is rejected, then waits for them to settle', async () => {
    const admitter = createScriptedMediaAdmitter({
      modeAt: (position) => (position === 0 ? 'reject' : 'manual'),
    });

    const result = await run(
      baseOptions(createMockGenerate([twoImages]), { generatedMediaAdmitter: admitter.port }),
    );

    expect(result.finishReason).toBe('error');
    expect((result.error as GeneratedMediaNotAdmittedError).partIndex).toBe(0);
    expect(admitter.admissions[1]?.aborted).toBe(true);
    expect(admitter.admissions[1]?.settlement?.outcome).toBe('aborted');
  });
});

describe('a read-only output hook cannot reach the admitted parts (correction)', () => {
  it('gives onLLMOutput a copy: pushing inline media or editing a part changes nothing', async () => {
    const admitter = createScriptedMediaAdmitter();
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('onLLMOutput', async (context) => {
      const parts = context.response.parts as MultiModalContent[];
      try {
        parts.push(inlineImage);
      } catch {
        // A frozen copy refuses the write; either way the settled response must be unchanged.
      }
      try {
        (parts[0] as { source: unknown }).source = {
          kind: 'inline',
          data: 'EVIL',
          encoding: 'base64',
        };
      } catch {
        // Likewise.
      }
    });

    const result = await run(
      baseOptions(createMockGenerate([{ content: '', parts: [inlineImage], toolCalls: [] }]), {
        hooks,
        generatedMediaAdmitter: admitter.port,
      }),
    );

    expect(result.finishReason).toBe('stop-condition');
    expect(result.parts).toMatchObject([{ type: 'image', source: { kind: 'managed-asset' } }]);
    expect(result.parts).toHaveLength(1);
    expect(safeStringify(result)).not.toContain('EVIL');
    expect(safeStringify(result)).not.toContain('UNIQUEBYTES');
  });
});

describe('a validateResponse hook that mutates the response in place (correction 3)', () => {
  it('has inline media it adds admitted exactly as a returned replacement would be', async () => {
    const admitter = createScriptedMediaAdmitter();
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateResponse', async (response) => {
      (response.parts as MultiModalContent[]).push(inlineImage);
      return response;
    });

    const result = await run(
      baseOptions(
        createMockGenerate([
          { content: 'Hi', parts: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
        ]),
        { hooks, generatedMediaAdmitter: admitter.port },
      ),
    );

    expect(result.finishReason).toBe('stop-condition');
    expect(result.parts).toMatchObject([
      { type: 'text', text: 'Hi' },
      { type: 'image', source: { kind: 'managed-asset' } },
    ]);
    expect(safeStringify(result)).not.toContain('UNIQUEBYTES');
  });

  it('refuses inline media it adds when there is no admitter, as a replacement would be', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateResponse', async (response) => {
      (response.parts as MultiModalContent[]).push(inlineImage);
      return response;
    });

    const result = await run(
      baseOptions(
        createMockGenerate([
          { content: 'Hi', parts: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
        ]),
        { hooks },
      ),
    );

    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(GeneratedMediaNotAdmittedError);
  });

  it('fails the step when it changes the text in place and leaves stale parts', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateResponse', async (response) => {
      (response as { content: string }).content = 'changed';
      return response;
    });

    const result = await run(
      baseOptions(
        createMockGenerate([
          { content: 'Hi', parts: [{ type: 'text', text: 'Hi' }], toolCalls: [] },
        ]),
        { hooks },
      ),
    );

    expect(result.finishReason).toBe('error');
    expect(result.error).toBeInstanceOf(ResponsePartsMismatchError);
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

describe('streamed sibling admissions (correction 3)', () => {
  const secondImage = { ...inlineImage, mimeType: 'image/jpeg' } as MultiModalContent;
  const wrappers = [
    ['withStreaming', withStreaming],
    ['withEnhancedStreaming', withEnhancedStreaming],
  ] as const;

  it.each(wrappers)(
    'fails promptly and aborts the earlier admission when a later one is rejected (%s)',
    async (_name, wrapper) => {
      const admitter = createScriptedMediaAdmitter({
        modeAt: (position) => (position === 0 ? 'manual' : 'reject'),
      });
      const images = [inlineImage, secondImage];
      const generate = wrapper(async ({ streaming }) => {
        for (const [partIndex, part] of images.entries()) {
          streaming.reportPart?.({ type: 'start', partIndex, kind: 'image' });
          streaming.reportPart?.({ type: 'complete', partIndex, part });
        }
        return { content: '', parts: images, toolCalls: [] };
      });

      const result = await run(baseOptions(generate, { generatedMediaAdmitter: admitter.port }));

      expect(result.finishReason).toBe('error');
      expect(result.error).toBeInstanceOf(GeneratedMediaNotAdmittedError);
      expect(admitter.admissions[0]?.aborted).toBe(true);
      expect(admitter.admissions[1]?.settlement?.outcome).toBe('rejected');
    },
  );
});

describe('retaining the assets a committed row references (correction 3)', () => {
  it('tells the port about the committed row and its managed parts once', async () => {
    const admitter = createScriptedMediaAdmitter({ retention: 'record' });

    const result = await run(
      baseOptions(
        createMockGenerate([
          {
            content: 'Here.',
            parts: [{ type: 'text', text: 'Here.' }, inlineImage],
            toolCalls: [],
          },
        ]),
        { generatedMediaAdmitter: admitter.port, runId: 'run-keep' },
      ),
    );

    expect(result.finishReason).toBe('stop-condition');
    expect(admitter.retained).toHaveLength(1);
    expect(admitter.retained[0]).toMatchObject({
      runId: 'run-keep',
      messageId: 'run-keep:step:0',
      parts: [{ type: 'image', source: { kind: 'managed-asset', assetId: 'asset-1' } }],
    });
    expect(result.steps[0]?.messageId).toBe('run-keep:step:0');
  });

  it('is not called for a row with no media', async () => {
    const admitter = createScriptedMediaAdmitter({ retention: 'record' });

    await run(
      baseOptions(createMockGenerate([{ content: 'Plain.', toolCalls: [] }]), {
        generatedMediaAdmitter: admitter.port,
      }),
    );

    expect(admitter.retained).toEqual([]);
  });

  it('fails the step when the port cannot keep the asset the row points at', async () => {
    const admitter = createScriptedMediaAdmitter({ retention: 'fail' });

    const result = await run(
      baseOptions(createMockGenerate([{ content: '', parts: [inlineImage], toolCalls: [] }]), {
        generatedMediaAdmitter: admitter.port,
      }),
    );

    expect(result.finishReason).toBe('error');
    expect((result.error as Error).message).toContain('retention unavailable');
  });
});
