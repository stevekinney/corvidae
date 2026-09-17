import { createTestToolbox, createTool } from '@repo/armorer';
import { Conversation } from '@repo/conversationalist';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { assertDefined } from './assert-defined';

import { noToolCalls } from '../src/conditions/predicates.ts';
import { createActiveRun } from '../src/create-run.ts';
import { instrumentRun } from '../src/index.ts';
import type { GenerateResponse, TokenUsage } from '../src/types.ts';
import { RecordingTracer } from './instrumentation-fixtures';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather for a location',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

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

function weatherToolCall(location = 'Denver') {
  return { name: 'get_weather', arguments: { location } };
}

function findSpan(tracer: RecordingTracer, name: string) {
  return tracer.spans.find((s) => s.name === name);
}

describe('instrumentRun tool spans', () => {
  it('ends the generate span on tools.executing for tool steps', async () => {
    const tracer = new RecordingTracer();
    const toolbox = createTestToolbox([weatherTool]);

    const activeRun = createActiveRun({
      generate: async (context) => {
        if (context.step === 0) {
          return toolCallResponse([weatherToolCall()]);
        }
        return textResponse('Done');
      },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    // The first generate span (step 0) should be ended before tools.executed
    // We can verify by checking that the generate span is ended and a tools span exists
    const generateSpans = tracer.spans.filter((s) => s.name === 'generate');
    expect(generateSpans.length).toBeGreaterThanOrEqual(1);

    // First generate span (from step 0 with tools) should be ended
    expect(assertDefined(generateSpans[0]).ended).toBe(true);

    // A tools span should exist
    const toolsSpan = findSpan(tracer, 'tool_calls');
    expect(toolsSpan).toBeDefined();
  });

  it('creates a tools span on tools.executing', async () => {
    const tracer = new RecordingTracer();
    const toolbox = createTestToolbox([weatherTool]);

    const activeRun = createActiveRun({
      generate: async (context) => {
        if (context.step === 0) {
          return toolCallResponse([weatherToolCall()]);
        }
        return textResponse('Done');
      },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const toolsSpan = findSpan(tracer, 'tool_calls')!;
    expect(toolsSpan).toBeDefined();
    expect(toolsSpan.attributes['operative.tools.count']).toBe(1);
    expect(toolsSpan.attributes['operative.tools.names']).toBe('get_weather');
  });

  it('ends the tools span on tools.executed', async () => {
    const tracer = new RecordingTracer();
    const toolbox = createTestToolbox([weatherTool]);

    const activeRun = createActiveRun({
      generate: async (context) => {
        if (context.step === 0) {
          return toolCallResponse([weatherToolCall()]);
        }
        return textResponse('Done');
      },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    const toolsSpan = findSpan(tracer, 'tool_calls')!;
    expect(toolsSpan.ended).toBe(true);
    expect(toolsSpan.attributes['operative.tools.results_count']).toBe(1);
  });

  it('ends the step span on step.completed', async () => {
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
    expect(stepSpan.ended).toBe(true);
  });

  it('produces correct span tree for a multi-step run', async () => {
    const tracer = new RecordingTracer();
    const toolbox = createTestToolbox([weatherTool]);

    const activeRun = createActiveRun({
      generate: async (context) => {
        if (context.step === 0) {
          return toolCallResponse([weatherToolCall()]);
        }
        return textResponse('The weather is nice.');
      },
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    const unsubscribe = instrumentRun(activeRun, { tracer });
    await activeRun.result;
    activeRun.complete();
    unsubscribe();

    // Expected spans: run, step.0, generate (step 0), tools, step.1, generate (step 1) = 6
    expect(tracer.spans).toHaveLength(6);

    const spanNames = tracer.spans.map((s) => s.name);
    expect(spanNames).toContain('invoke_agent');
    expect(spanNames).toContain('tool_calls');

    // The step span name is intentionally stable (not `step {n}`) to avoid
    // unbounded cardinality; the step index is carried on the attribute
    // instead, so both steps should be distinguishable there.
    const stepSpans = tracer.spans.filter((s) => s.name === 'step');
    expect(stepSpans).toHaveLength(2);
    expect(stepSpans.map((s) => s.attributes['operative.step.index'])).toEqual([0, 1]);

    const generateSpans = tracer.spans.filter((s) => s.name === 'generate');
    expect(generateSpans).toHaveLength(2);

    // All spans should be ended
    for (const span of tracer.spans) {
      expect(span.ended).toBe(true);
    }
  });
});
