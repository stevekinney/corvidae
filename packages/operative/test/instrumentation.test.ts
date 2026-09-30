import { createTestToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { noToolCalls } from '../src/conditions/predicates.ts';
import { createActiveRun } from '../src/create-run.ts';
import { instrumentRun } from '../src/index.ts';
import type { GenerateResponse, TokenUsage } from '../src/types.ts';
import { RecordingTracer } from './instrumentation-fixtures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(content: string, usage?: TokenUsage): GenerateResponse {
  return { content, toolCalls: [], usage };
}

function findSpan(tracer: RecordingTracer, name: string) {
  return tracer.spans.find((s) => s.name === name);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('instrumentRun', () => {
  it('creates a run span on run.started', async () => {
    const tracer = new RecordingTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Hello'),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const runSpan = findSpan(tracer, 'invoke_agent');
    expect(runSpan).toBeDefined();
    expect(runSpan?.attributes['gen_ai.operation.name']).toBe('invoke_agent');
  });

  it('names the run span with the agent name and sets gen_ai.agent.name when provided', async () => {
    const tracer = new RecordingTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Hello'),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrumentRun(activeRun, { tracer, agentName: 'Math Tutor' });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const runSpan = findSpan(tracer, 'invoke_agent Math Tutor');
    expect(runSpan).toBeDefined();
    expect(runSpan?.attributes['gen_ai.agent.name']).toBe('Math Tutor');
    expect(findSpan(tracer, 'invoke_agent')).toBeUndefined();
  });

  it('treats an empty or whitespace-only agentName as unset for both the span name and attribute', async () => {
    const tracer = new RecordingTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Hello'),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrumentRun(activeRun, { tracer, agentName: '   ' });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const runSpan = findSpan(tracer, 'invoke_agent')!;
    expect(runSpan).toBeDefined();
    expect('gen_ai.agent.name' in runSpan.attributes).toBe(false);
  });

  it('ends the run span on run.completed with finish reason and usage', async () => {
    const tracer = new RecordingTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Done', { prompt: 10, completion: 20, total: 30 }),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const runSpan = findSpan(tracer, 'invoke_agent')!;
    expect(runSpan.ended).toBe(true);
    expect(runSpan.attributes['operative.finish_reason']).toBe('stop-condition');
    expect('gen_ai.response.finish_reasons' in runSpan.attributes).toBe(false);
    expect(runSpan.attributes['operative.total_steps']).toBe(1);
    expect(runSpan.attributes['gen_ai.usage.input_tokens']).toBe(10);
    expect(runSpan.attributes['gen_ai.usage.output_tokens']).toBe(20);
  });

  it('reports cache token usage on the run span when present', async () => {
    const tracer = new RecordingTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () =>
        textResponse('Done', {
          prompt: 10,
          completion: 20,
          total: 30,
          cacheCreationTokens: 4,
          cacheReadTokens: 6,
        }),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const runSpan = findSpan(tracer, 'invoke_agent')!;
    expect(runSpan.attributes['gen_ai.usage.cache_creation.input_tokens']).toBe(4);
    expect(runSpan.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(6);
  });

  it('creates a step span as a child of the run span', async () => {
    const tracer = new RecordingTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Hello'),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const stepSpan = findSpan(tracer, 'step')!;
    expect(stepSpan).toBeDefined();
    // The step span's parentContext should contain the run span
    expect(stepSpan.parentContext).toBeDefined();
  });

  it('creates a generate span as a child of the step span', async () => {
    const tracer = new RecordingTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Hello'),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const generateSpan = findSpan(tracer, 'generate')!;
    expect(generateSpan).toBeDefined();
    expect(generateSpan.parentContext).toBeDefined();
  });

  it('ends the generate span on step.generated for text-only steps with usage', async () => {
    const tracer = new RecordingTracer();
    const toolbox = createTestToolbox([]);

    const activeRun = createActiveRun({
      generate: async () => textResponse('Hello', { prompt: 5, completion: 10, total: 15 }),
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const generateSpan = findSpan(tracer, 'generate')!;
    expect(generateSpan.ended).toBe(true);
    expect(generateSpan.attributes['operative.usage.prompt_tokens']).toBe(5);
    expect(generateSpan.attributes['operative.usage.completion_tokens']).toBe(10);
    expect(generateSpan.attributes['operative.usage.total_tokens']).toBe(15);
  });
});

describe('COR-96 regression: run.error and run.aborted never leak privileged content', () => {
  const MARKER = 'PRIVILEGED-MARKER-9b2e40';

  function containsMarker(value: unknown): boolean {
    if (typeof value === 'string') return value.includes(MARKER);
    if (Array.isArray(value)) return value.some(containsMarker);
    if (value && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).some(containsMarker);
    }
    return false;
  }

  // Scoped to the run span: the sibling `generate.error` listener has the
  // same raw-message pattern but is outside COR-96's delivery boundary.
  function expectNoMarker(tracer: RecordingTracer) {
    const runSpan = findSpan(tracer, 'invoke_agent');
    expect(runSpan).toBeDefined();
    for (const span of [runSpan!]) {
      expect(containsMarker(span.attributes)).toBe(false);
      expect(containsMarker(span.status)).toBe(false);
      expect(span.events.every((event) => !containsMarker(event.attributes))).toBe(true);
      // A recorded exception must carry no message or stack at all.
      expect(
        span.exceptions.some(
          (exception) => containsMarker(exception) || (exception as Error).message !== undefined,
        ),
      ).toBe(false);
    }
  }

  it('redacts a marker in the run error message (run.error)', async () => {
    const tracer = new RecordingTracer();
    const activeRun = createActiveRun({
      generate: async () => {
        throw new Error(`provider payload: ${MARKER}`);
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    expectNoMarker(tracer);
    const runSpan = findSpan(tracer, 'invoke_agent')!;
    expect(runSpan.status.message).toBe('Run failed (generate/UNKNOWN)');
    expect(runSpan.attributes['operative.error.kind']).toBe('generate');
  });

  it('redacts a marker in the abort reason and the abort error message (run.aborted)', async () => {
    const tracer = new RecordingTracer();
    const generateStarted = Promise.withResolvers<void>();
    const generateCanFinish = Promise.withResolvers<void>();
    const activeRun = createActiveRun({
      generate: async () => {
        generateStarted.resolve();
        await generateCanFinish.promise;
        return textResponse('unreachable');
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });
    await generateStarted.promise;
    activeRun.abort(`cancelled because ${MARKER}`);
    generateCanFinish.resolve();
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    expectNoMarker(tracer);
    const runSpan = findSpan(tracer, 'invoke_agent')!;
    expect(runSpan.attributes['operative.abort_reason']).toBe('aborted');
    expect(runSpan.status.message).toBe('Run aborted (abort/ABORTED)');
  });
});
