import { createTestToolbox, createTool, createToolbox } from '@corvidae/armorer';
import { Conversation } from '@corvidae/conversationalist';
import { HookRegistry } from '@corvidae/lifecycle';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { assertDefined } from './assert-defined';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import type { StepAbortedEvent } from '../src/events';
import type { OperativeHookMap } from '../src/hooks';
import { createMockGenerate, createRunRecorder } from '../src/test/index';
import type { GenerateResponse } from '../src/types';
const run = (options: Parameters<typeof createActiveRun>[0]) => createActiveRun(options).result;

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function weatherToolCall(location = 'Denver') {
  return { name: 'get_weather', arguments: { location } };
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

describe('per-step abort granularity', () => {
  it('each step gets its own signal', async () => {
    const capturedSignals: (AbortSignal | undefined)[] = [];

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done'),
    ]);

    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('prepareStep', async ({ signal }) => {
      capturedSignals.push(signal);
      return undefined;
    });

    await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(capturedSignals).toHaveLength(2);
    expect(capturedSignals[0]).toBeInstanceOf(AbortSignal);
    expect(capturedSignals[1]).toBeInstanceOf(AbortSignal);
    expect(capturedSignals[0]).not.toBe(capturedSignals[1]);
  });

  it('step abort does not abort the entire run', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Seattle')]),
      textResponse('Done'),
    ]);

    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('prepareStep', async ({ step, abortStep }) => {
      if (step === 0) {
        abortStep?.('skip this step');
      }
      return undefined;
    });

    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.finishReason).not.toBe('aborted');
    expect(result.steps.length).toBeGreaterThanOrEqual(1);
  });

  it('emits step.aborted event when a step is aborted', async () => {
    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Seattle')]),
      textResponse('Done'),
    ]);

    const toolbox = createToolbox([weatherTool]);

    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('prepareStep', async ({ step, abortStep }) => {
      if (step === 0) {
        abortStep?.('skip first');
      }
      return undefined;
    });

    const activeRun = createActiveRun({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const stepAbortedEvents = recorder.events.filter((event) => event.type === 'step.aborted');
    expect(stepAbortedEvents).toHaveLength(1);
    expect((assertDefined(stepAbortedEvents[0]).detail as StepAbortedEvent).step).toBe(0);
    expect((assertDefined(stepAbortedEvents[0]).detail as StepAbortedEvent).reason).toBe(
      'skip first',
    );
  });

  it('run-level abort still aborts step signals', async () => {
    const controller = new AbortController();
    const capturedSignals: (AbortSignal | undefined)[] = [];

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done'),
    ]);

    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('prepareStep', async ({ signal }) => {
      capturedSignals.push(signal);
      controller.abort('run cancelled');
      return undefined;
    });

    await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      signal: controller.signal,
      hooks,
    });

    expect(capturedSignals).toHaveLength(1);
    expect(capturedSignals[0]!.aborted).toBe(true);
  });

  it('step signal is passed to toolbox.execute', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const toolbox = createTestToolbox([weatherTool]);
    const originalExecute = toolbox.execute.bind(toolbox);
    (toolbox as any).execute = async (...args: any[]) => {
      receivedSignal = args[1]?.signal;
      return (originalExecute as (...callArgs: any[]) => Promise<unknown>)(...args);
    };

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done'),
    ]);

    await run({
      generate,
      toolbox,
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      signal: controller.signal,
    });

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal).not.toBe(controller.signal);
  });

  it('step signal differs per step in generate function', async () => {
    const capturedSignals: (AbortSignal | undefined)[] = [];

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done'),
    ]);

    const originalGenerate = generate;
    const wrappedGenerate: typeof generate = Object.assign(
      async (...args: Parameters<typeof generate>) => {
        capturedSignals.push(args[0].signal);
        return originalGenerate(...args);
      },
      { calls: generate.calls, callCount: generate.callCount },
    );

    await run({
      generate: wrappedGenerate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    expect(capturedSignals).toHaveLength(2);
    expect(capturedSignals[0]).toBeInstanceOf(AbortSignal);
    expect(capturedSignals[1]).toBeInstanceOf(AbortSignal);
    expect(capturedSignals[0]).not.toBe(capturedSignals[1]);
  });

  it('step abort during tool execution skips afterToolExecution and continues the run', async () => {
    let capturedAbortStep: ((reason?: string) => void) | undefined;

    const abortingTool = createTool({
      name: 'aborting_tool',
      description: 'Aborts the step during execution',
      input: z.object({}),
      execute: async () => {
        capturedAbortStep?.('abort during tool execution');
        return { done: true };
      },
    });

    const generate = createMockGenerate([
      toolCallResponse([{ name: 'aborting_tool', arguments: {} }]),
      toolCallResponse([weatherToolCall('Seattle')]),
      textResponse('Done'),
    ]);

    const afterToolLog: number[] = [];

    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('prepareStep', async ({ abortStep }) => {
      capturedAbortStep = abortStep;
      return undefined;
    });
    hooks.on('afterToolExecution', async ({ step }) => {
      afterToolLog.push(step);
    });

    const result = await run({
      generate,
      toolbox: createTestToolbox([abortingTool, weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.finishReason).toBe('stop-condition');
    // Step 0 aborted during tool execution — afterToolExecution should be skipped for it
    expect(afterToolLog).not.toContain(0);
    expect(afterToolLog).toContain(1);
  });

  it('aborted step skips afterToolExecution and onStep', async () => {
    const log: string[] = [];

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      toolCallResponse([weatherToolCall('Seattle')]),
      textResponse('Done'),
    ]);

    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('beforeToolExecution', async ({ step, toolCalls }) => {
      log.push(`beforeToolExecution:${step}`);
      return toolCalls;
    });
    hooks.on('afterToolExecution', async ({ step }) => {
      log.push(`afterToolExecution:${step}`);
    });
    hooks.on('onStep', async ({ step }) => {
      log.push(`onStep:${step}`);
    });
    hooks.on('prepareStep', async ({ step, abortStep }) => {
      if (step === 0) {
        abortStep?.('skip');
      }
      return undefined;
    });

    await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(log).not.toContain('afterToolExecution:0');
    expect(log).not.toContain('onStep:0');
    expect(log).not.toContain('beforeToolExecution:0');

    expect(log).toContain('beforeToolExecution:1');
    expect(log).toContain('afterToolExecution:1');
    expect(log).toContain('onStep:1');
    expect(log).toContain('onStep:2');
  });
});
