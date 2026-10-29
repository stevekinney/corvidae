import { HookRegistry } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, type MultiModalContent } from 'conversationalist';
import { z } from 'zod';
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
import {
  ProviderContractError,
  ProviderError,
  shouldRetryProviderError,
} from '../src/providers/errors';
import { withStreaming } from '../src/streaming';
import { withEnhancedStreaming } from '../src/streaming/enhanced-streaming';
import { createMockGenerate, createRunRecorder } from '../src/test/index';
import { createScriptedMediaAdmitter } from '../src/testing/generated-media.test-support';
import type { GenerateResponse, RunOptions } from '../src/types';

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
