import { SpanStatusCode } from '@opentelemetry/api';
import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';
import { assertDefined } from './assert-defined';

import { noToolCalls } from '../src/conditions/predicates.ts';
import { createActiveRun } from '../src/create-run.ts';
import { instrumentRun } from '../src/index.ts';
import type { GenerateResponse, TokenUsage } from '../src/types.ts';
import { RecordingTracer } from './instrumentation-fixtures';

function textResponse(content: string, usage?: TokenUsage): GenerateResponse {
  return { content, toolCalls: [], usage };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
  usage?: TokenUsage,
): GenerateResponse {
  return { content, toolCalls, usage };
}

function findSpan(tracer: RecordingTracer, name: string) {
  return tracer.spans.find((s) => s.name === name);
}

describe('instrumentRun failure and cleanup', () => {
  it('sets ERROR status on run span and sweeps open spans when generate throws', async () => {
    const tracer = new RecordingTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => {
        throw new Error('LLM service unavailable');
      },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const runSpan = findSpan(tracer, 'invoke_agent')!;
    expect(runSpan).toBeDefined();
    expect(runSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(runSpan.status.message).toBe('Run failed (generate/UNKNOWN)');
    expect(runSpan.attributes['error.type']).toBe('Error');
    expect(runSpan.attributes['operative.error.kind']).toBe('generate');
    expect(runSpan.attributes['operative.error.code']).toBe('UNKNOWN');
    expect(runSpan.exceptions).toEqual([{ name: 'Error' }]);
    expect(runSpan.ended).toBe(true);

    // All open spans should be swept (ended)
    for (const span of tracer.spans) {
      expect(span.ended).toBe(true);
    }
  });

  it('sets ERROR status on the run span when the run stops at its step limit (COR-1627)', async () => {
    const tracer = new RecordingTracer();
    const noopTool = createTool({
      name: 'noop',
      description: 'does nothing',
      input: z.object({}),
      execute: async () => ({ ok: true }),
    });

    const activeRun = createActiveRun({
      generate: async () => toolCallResponse([{ name: 'noop', arguments: {} }]),
      toolbox: createTestToolbox([noopTool]),
      conversation: new Conversation(),
      maximumSteps: 2,
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });
    const result = await activeRun.result;
    activeRun.complete();
    unsubscribe();

    expect(result.finishReason).toBe('maximum-steps');
    const runSpan = findSpan(tracer, 'invoke_agent')!;
    expect(runSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(runSpan.status.message).toBe('Run failed (policy/MAXIMUM_STEPS)');
    expect(runSpan.attributes['operative.error.code']).toBe('MAXIMUM_STEPS');
    expect(runSpan.attributes['operative.error.kind']).toBe('policy');
    expect(runSpan.ended).toBe(true);
  });

  it('sets abort reason on run span and sweeps open spans when aborted', async () => {
    const tracer = new RecordingTracer();
    const toolbox = createTestToolbox([]);
    const generateStarted = Promise.withResolvers<void>();
    const generateCanFinish = Promise.withResolvers<void>();

    const activeRun = createActiveRun({
      generate: async () => {
        generateStarted.resolve();
        await generateCanFinish.promise;
        return textResponse('Should not finish');
      },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      maximumSteps: 10,
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });
    await generateStarted.promise;
    activeRun.abort('user cancelled');
    generateCanFinish.resolve();
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const runSpan = findSpan(tracer, 'invoke_agent')!;
    expect(runSpan).toBeDefined();
    expect(runSpan.attributes['operative.abort_reason']).toBe('aborted');
    expect(runSpan.attributes['operative.error.kind']).toBe('abort');
    expect(runSpan.attributes['operative.error.code']).toBe('ABORTED');
    expect(runSpan.attributes['error.type']).toBe('AbortAgentRunError');
    expect(runSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(runSpan.status.message).toBe('Run aborted (abort/ABORTED)');
    expect(runSpan.exceptions).toHaveLength(1);
    expect(runSpan.exceptions[0]).toEqual({ name: 'AbortAgentRunError' });
    expect(runSpan.ended).toBe(true);

    // All spans should be ended
    for (const span of tracer.spans) {
      expect(span.ended).toBe(true);
    }
  });

  it('sweeps open tool spans when toolbox.execute throws', async () => {
    const tracer = new RecordingTracer();

    // Create a tool whose execution throws a raw error that the toolbox propagates
    const crashTool = createTool({
      name: 'crash_tool',
      description: 'A tool that crashes',
      input: z.object({}),
      execute: async () => {
        throw new Error('toolbox crash');
      },
    });

    const toolbox = createTestToolbox([crashTool]);

    // Override execute to throw instead of returning an error result
    toolbox.execute = async () => {
      // Call the original, but if the tool errors, rethrow as an unhandled error
      throw new Error('toolbox-level crash');
    };

    const activeRun = createActiveRun({
      generate: async (context) => {
        if (context.step === 0) {
          return toolCallResponse([{ name: 'crash_tool', arguments: {} }]);
        }
        return textResponse('Done');
      },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      maximumSteps: 10,
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    // The tools span should have been created by tools.executing
    // and ended by endAllOpenSpans (called from run.error handler)
    const toolsSpan = findSpan(tracer, 'tool_calls');
    expect(toolsSpan).toBeDefined();
    expect(toolsSpan!.ended).toBe(true);

    // All spans should be ended
    for (const span of tracer.spans) {
      expect(span.ended).toBe(true);
    }
  });

  it('adds a retry event to the generate span', async () => {
    const tracer = new RecordingTracer();
    const toolbox = createTestToolbox([]);
    let callCount = 0;

    const activeRun = createActiveRun({
      generate: async () => {
        callCount++;
        if (callCount === 1) throw new Error('transient');
        return textResponse('Recovered');
      },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      retry: { attempts: 3 },
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const generateSpan = findSpan(tracer, 'generate')!;
    expect(generateSpan).toBeDefined();
    const retryEvents = generateSpan.events.filter((e) => e.name === 'generate.retry');
    expect(retryEvents).toHaveLength(1);
    expect(assertDefined(retryEvents[0]).attributes?.['retry.attempt']).toBe(1);
  });

  it('stops span creation after unsubscribe is called', async () => {
    const tracer = new RecordingTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Hello'),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });
    // Immediately unsubscribe before the loop executes (loop is deferred via microtask)
    unsubscribe();

    await activeRun.result;
    activeRun.complete();

    // No spans should have been created (unsubscribe was called before any events fired)
    expect(tracer.spans).toHaveLength(0);
  });

  it('endAllOpenSpans sweeps a generate span still in progress on unsubscribe', async () => {
    const tracer = new RecordingTracer();
    const toolbox = createTestToolbox([]);
    let resolveGenerate!: (value: GenerateResponse) => void;
    const generateStarted = Promise.withResolvers<void>();

    const activeRun = createActiveRun({
      generate: async () => {
        generateStarted.resolve();
        return new Promise<GenerateResponse>((resolve) => {
          resolveGenerate = resolve;
        });
      },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });

    // Wait until generate.started has fired and the span is in the map
    await generateStarted.promise;
    await Promise.resolve();

    // Unsubscribe while the generate span is still open
    unsubscribe();

    const generateSpan = findSpan(tracer, 'generate')!;
    expect(generateSpan).toBeDefined();
    expect(generateSpan.ended).toBe(true);

    // Let generate complete so the run finishes cleanly
    resolveGenerate(textResponse('Hello'));
    await activeRun.result;
    activeRun.complete();
  });

  it('does not throw when called without a tracer option', async () => {
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Hello'),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    // Should not throw even without a tracer
    const unsubscribe = instrumentRun(activeRun);
    await activeRun.result;
    activeRun.complete();
    unsubscribe();
  });
});
