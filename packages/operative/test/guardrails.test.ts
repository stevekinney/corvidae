import { createTestToolbox, createTool } from 'armorer';
import { Conversation } from 'conversationalist';
import { HookRegistry } from '@lostgradient/lifecycle';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { assertDefined } from './assert-defined';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import type { ResponseValidatedEvent } from '../src/events';
import type { OperativeHookMap } from '../src/hooks';
import { createRunRecorder } from '../src/test/index';
import type { GenerateResponse } from '../src/types';
const run = (options: Parameters<typeof createActiveRun>[0]) => createActiveRun(options).result;

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

function weatherToolCall(location = 'Denver') {
  return { name: 'get_weather', arguments: { location } };
}

describe('validateResponse guardrail', () => {
  it('modifies content when returning a new response', async () => {
    let callCount = 0;
    const generate = async () => {
      callCount++;
      return textResponse('raw content');
    };

    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateResponse', async (response) => {
      return { ...response, content: response.content.toUpperCase() };
    });

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.content).toBe('RAW CONTENT');
  });

  it('passes through when returning void', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateResponse', async () => {
      // Return void — no modification
    });

    const result = await run({
      generate: async () => textResponse('unchanged'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.content).toBe('unchanged');
  });

  it('terminates the loop when throwing', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateResponse', async () => {
      throw new Error('Response rejected');
    });

    const result = await run({
      generate: async () => textResponse('bad content'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.finishReason).toBe('error');
  });

  it('receives correct step context', async () => {
    const contexts: Array<{ step: number; hasConversation: boolean }> = [];

    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateResponse', async (_response, context) => {
      contexts.push({
        step: context.step,
        hasConversation: context.conversation instanceof Conversation,
      });
    });

    await run({
      generate: async () => textResponse('Hello'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(contexts).toHaveLength(1);
    expect(assertDefined(contexts[0]).step).toBe(0);
    expect(assertDefined(contexts[0]).hasConversation).toBe(true);
  });

  it('emits response.validated event when response is modified', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateResponse', async (response) => {
      return { ...response, content: 'modified' };
    });

    const activeRun = createActiveRun({
      generate: async () => textResponse('original'),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const validatedEvents = recorder.events.filter((e) => e.type === 'response.validated');
    expect(validatedEvents).toHaveLength(1);
    const detail = assertDefined(validatedEvents[0]).detail as ResponseValidatedEvent;
    expect(detail.original.content).toBe('original');
    expect(detail.validated.content).toBe('modified');
  });
});

describe('validateToolResult guardrail', () => {
  it('modifies tool result content', async () => {
    let callIndex = 0;
    const generate = async () => {
      callIndex++;
      if (callIndex === 1) return toolCallResponse([weatherToolCall('Denver')]);
      return textResponse('Done');
    };

    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateToolResult', async (toolResult) => {
      return { ...toolResult, content: 'REDACTED' };
    });

    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(assertDefined(assertDefined(result.steps[0]).results[0]).content).toBe('REDACTED');
  });

  it('passes through when returning void', async () => {
    let callIndex = 0;
    const generate = async () => {
      callIndex++;
      if (callIndex === 1) return toolCallResponse([weatherToolCall('Denver')]);
      return textResponse('Done');
    };

    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateToolResult', async () => {
      // Return void — no modification
    });

    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(assertDefined(result.steps[0]).results).toHaveLength(1);
  });

  it.each([
    ['synchronous collection', false],
    ['asynchronous collection', true],
  ] as const)('terminates the loop when throwing with %s', async (_name, collectAsync) => {
    let callIndex = 0;
    const generate = async () => {
      callIndex++;
      if (callIndex === 1) return toolCallResponse([weatherToolCall('Denver')]);
      return textResponse('Done');
    };

    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateToolResult', async () => {
      throw new Error('Tool result rejected');
    });

    const result = await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      collectAsync,
      hooks,
    });

    expect(result.finishReason).toBe('error');
  });

  it('receives correct context with toolCalls and results', async () => {
    const contextData: Array<{ toolCallCount: number; resultCount: number }> = [];

    let callIndex = 0;
    const generate = async () => {
      callIndex++;
      if (callIndex === 1) return toolCallResponse([weatherToolCall('Denver')]);
      return textResponse('Done');
    };

    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateToolResult', async (_result, context) => {
      contextData.push({
        toolCallCount: context.toolCalls.length,
        resultCount: context.results.length,
      });
    });

    await run({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(contextData).toHaveLength(1);
    expect(assertDefined(contextData[0]).toolCallCount).toBe(1);
    expect(assertDefined(contextData[0]).resultCount).toBe(1);
  });

  it('emits tool-result.validated event when result is modified', async () => {
    let callIndex = 0;
    const generate = async () => {
      callIndex++;
      if (callIndex === 1) return toolCallResponse([weatherToolCall('Denver')]);
      return textResponse('Done');
    };

    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('validateToolResult', async (toolResult) => {
      return { ...toolResult, content: 'validated' };
    });

    const activeRun = createActiveRun({
      generate,
      toolbox: createTestToolbox([weatherTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    const recorder = createRunRecorder(activeRun);
    await activeRun.result;

    const validatedEvents = recorder.events.filter((e) => e.type === 'tool-result.validated');
    expect(validatedEvents).toHaveLength(1);
  });
});
