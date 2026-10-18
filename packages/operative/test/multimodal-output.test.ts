import { HookRegistry } from '@lostgradient/lifecycle';
import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, type MultiModalContent } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import {
  agentRunErrorToJSON,
  GeneratedMediaNotAdmittedError,
  ResponsePartsMismatchError,
} from '../src/errors';
import type { ReplayDataDroppedEvent } from '../src/events';
import type { OperativeHookMap } from '../src/hooks';
import {
  ProviderContractError,
  ProviderError,
  shouldRetryProviderError,
} from '../src/providers/errors';
import { createAnthropicProvider, createAnthropicProviderStream } from '../src/providers/anthropic';
import {
  createMockAnthropicClient,
  createMockAnthropicStreamingClient,
} from '../src/providers/test/mock-clients';
import { withStreaming } from '../src/streaming';
import { withEnhancedStreaming } from '../src/streaming/enhanced-streaming';
import { createOpenAIProvider, createOpenAIProviderStream } from '../src/providers/openai';
import {
  createMockOpenAIClient,
  createMockOpenAIStreamingClient,
} from '../src/providers/test/mock-clients';
import type { LivePartEvent } from '../src/streaming/types';
import { createMockGenerate, createRunRecorder } from '../src/test/index';
import { createScriptedMediaAdmitter } from '../src/testing/generated-media.test-support';
import { rejectionOf } from '../src/testing/promise-outcome.test-support.ts';
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
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
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
    generate = mode === 'withStreaming' ? withStreaming(streaming) : withEnhancedStreaming(streaming);
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

  it.each(scenarios)('keeps %s: parts in provider order, in the row, and byte-identical on the next request', async (_name, blocks) => {
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
      expectedParts.length === 1 && expectedParts[0]?.['type'] === 'text' && !('citations' in expectedParts[0])
        ? (expectedParts[0]['text'] as string)
        : (expectedParts as never),
    );

    if (blocks.some((block) => block['type'] === 'tool_use')) {
      // The request that carries the tool result holds each block exactly as the API returned it,
      // with thinking before tool_use in the same assistant turn.
      expect(JSON.stringify(assistantTurn(requests[1]))).toBe(JSON.stringify(blocks));
    }
  });

  it('keeps the usage the response reported', async () => {
    const { result } = await runAnthropic(mode, [thinkingBlock, toolUseBlock]);
    expect(result.steps[0]?.usage).toMatchObject({ prompt: 12, completion: 7 });
  });
});

function adapterContext(streaming?: StreamingHandle): GenerateContext & { streaming: StreamingHandle } {
  return {
    conversation: new Conversation(),
    step: 0,
    toolbox: createTestToolbox([weatherTool]),
    streaming: streaming ?? { messageId: 'row', update: () => {} },
  };
}

/** A streaming handle that records every part event the adapter reports. */
function recordingHandle(): { handle: StreamingHandle; events: LivePartEvent[]; updates: string[] } {
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

function completion(message: OpenAIMessage, usage = { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 }) {
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

async function openAIResponse(mode: 'non-streaming' | 'streaming', message: Record<string, unknown>) {
  if (mode === 'non-streaming') {
    const client = createMockOpenAIClient([completion(message as never)]);
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
        { index: 0, id: 'call-9', type: 'function', function: { name: 'get_weather', arguments: '{"location":"Paris"}' } },
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
      ...(mode === 'non-streaming' ? { annotations: [{ type: 'url_citation', url: 'https://x.test' }] } : {}),
    });
    expect(response.metadata?.['refusal']).toBe('I cannot help with that.');
    if (mode === 'non-streaming') {
      expect(response.metadata?.['annotations']).toEqual([{ type: 'url_citation', url: 'https://x.test' }]);
    }
  });

  it('keeps a field the SDK does not declare in metadata, leniently', async () => {
    const response = await openAIResponse(mode, { content: 'Hi', reasoning_content: 'thinking aloud' });
    expect(response.metadata?.['providerExtensions']).toEqual({ reasoning_content: 'thinking aloud' });
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
      expect(contract).toMatchObject({ provider: 'openai', blockType: field, reason: 'unlisted-block' });
      expect(contract.usage).toMatchObject({ prompt: 9, completion: 4 });
      expect(contract.retryable).toBe(false);
    }
  });
});

describe('OpenAI streaming reports text as a part', () => {
  it('starts, streams deltas with rising sequences, and completes one text part', async () => {
    const client = createMockOpenAIStreamingClient([chunksFor({ content: 'Hello there' }) as never]);
    const recorder = recordingHandle();

    const response = await createOpenAIProviderStream({ model: 'gpt-4o', client })(
      adapterContext(recorder.handle),
    );

    expect(recorder.events.map((event) => event.type)).toEqual(['start', 'delta', 'delta', 'complete']);
    expect(recorder.events.filter((event) => event.type === 'delta').map((event) => event.sequence)).toEqual([1, 2]);
    expect(recorder.events.at(-1)).toEqual({ type: 'complete', partIndex: 0, part: textPart('Hello there') });
    expect(recorder.updates).toEqual([]);
    expect(response.parts).toEqual([textPart('Hello there')]);
  });

  it('falls back to update for a handle that cannot report parts', async () => {
    const client = createMockOpenAIStreamingClient([chunksFor({ content: 'Hello there' }) as never]);
    const updates: string[] = [];
    const response = await createOpenAIProviderStream({ model: 'gpt-4o', client })(
      adapterContext({ messageId: 'row', update: (content) => updates.push(content) }),
    );
    expect(updates.at(-1)).toBe('Hello there');
    expect(response.parts).toEqual([textPart('Hello there')]);
  });
});

