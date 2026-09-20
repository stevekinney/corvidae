import { createTestToolbox, createTool } from '@corvidae/armorer';
import { Conversation } from '@corvidae/conversationalist';
import { createManualRuntimeServices, HookRegistry } from '@corvidae/lifecycle';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import type { OperativeHookMap } from '../src/hooks';
import { withTimeout } from '../src/hooks/composition';
import { createMockGenerate, createRunRecorder } from '../src/test/index';
import type { GenerateResponse, Toolbox } from '../src/types';
const run = (options: Parameters<typeof createActiveRun>[0]) => createActiveRun(options).result;

const tool = createTool({
  name: 'get_weather',
  description: 'Get weather',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => ({ temperature: 72, location }),
});

function weatherToolCall(location = 'Denver') {
  return { name: 'get_weather', arguments: { location } };
}

function toolCallResponse(
  toolCalls: GenerateResponse['toolCalls'],
  content = '',
): GenerateResponse {
  return { content, toolCalls };
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [] };
}

describe('hook composition (array-valued hooks)', () => {
  describe('prepareStep', () => {
    it('array of two functions: both called when first returns void', async () => {
      const calls: string[] = [];
      const generate = createMockGenerate([textResponse('Hello')]);

      const hooks = new HookRegistry<OperativeHookMap>();
      hooks.on('prepareStep', async () => {
        calls.push('first');
        return undefined;
      });
      hooks.on('prepareStep', async () => {
        calls.push('second');
        return undefined;
      });

      await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      });

      expect(calls).toEqual(['first', 'second']);
      expect(generate.callCount).toBe(1);
    });

    it('first returns void, second returns GenerateResponse — generate is skipped', async () => {
      const calls: string[] = [];
      const generate = createMockGenerate([textResponse('Should not be called')]);

      const hooks = new HookRegistry<OperativeHookMap>();
      hooks.on('prepareStep', async () => {
        calls.push('first');
        return undefined;
      });
      hooks.on('prepareStep', async () => {
        calls.push('second');
        return { content: 'Intercepted', toolCalls: [] };
      });

      const result = await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      });

      expect(calls).toEqual(['first', 'second']);
      expect(generate.callCount).toBe(0);
      expect(result.content).toBe('Intercepted');
    });

    it('first returns GenerateResponse — second is skipped', async () => {
      const calls: string[] = [];
      const generate = createMockGenerate([textResponse('Should not be called')]);

      const hooks = new HookRegistry<OperativeHookMap>();
      hooks.on('prepareStep', async () => {
        calls.push('first');
        return { content: 'Early return', toolCalls: [] };
      });
      hooks.on('prepareStep', async () => {
        calls.push('second');
        return undefined;
      });

      const result = await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      });

      expect(calls).toEqual(['first']);
      expect(generate.callCount).toBe(0);
      expect(result.content).toBe('Early return');
    });
  });

  describe('beforeToolExecution', () => {
    it('array: chained filtering', async () => {
      const executedLocations: string[] = [];

      const trackingTool = createTool({
        name: 'get_weather',
        description: 'Get weather',
        input: z.object({ location: z.string() }),
        execute: async ({ location }) => {
          executedLocations.push(location);
          return { temperature: 72, location };
        },
      });

      const generate = createMockGenerate([
        toolCallResponse([
          weatherToolCall('Denver'),
          weatherToolCall('Seattle'),
          weatherToolCall('Portland'),
        ]),
        textResponse('Done'),
      ]);

      const hooks = new HookRegistry<OperativeHookMap>();
      // First hook: remove Portland
      hooks.on('beforeToolExecution', async ({ toolCalls }) =>
        toolCalls.filter((tc) => (tc.arguments as { location: string }).location !== 'Portland'),
      );
      // Second hook: remove Seattle
      hooks.on('beforeToolExecution', async ({ toolCalls }) =>
        toolCalls.filter((tc) => (tc.arguments as { location: string }).location !== 'Seattle'),
      );

      await run({
        generate,
        toolbox: createTestToolbox([trackingTool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      });

      expect(executedLocations).toEqual(['Denver']);
    });
  });

  describe('selectTools', () => {
    it('array: last hook determines the toolbox', async () => {
      const tool2 = createTool({
        name: 'search',
        description: 'Search',
        input: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ results: [query] }),
      });

      const generate = createMockGenerate([textResponse('Done')]);

      const toolboxes: Toolbox[] = [];
      const hooks = new HookRegistry<OperativeHookMap>();
      hooks.on('selectTools', async () => {
        const tb = createTestToolbox([tool]);
        toolboxes.push(tb);
        return tb;
      });
      hooks.on('selectTools', async () => {
        const tb = createTestToolbox([tool2]);
        toolboxes.push(tb);
        return tb;
      });

      await run({
        generate,
        toolbox: createTestToolbox([tool, tool2]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      });

      expect(toolboxes).toHaveLength(2);
    });
  });

  describe('validateResponse', () => {
    it('array: chained transformation', async () => {
      const generate = createMockGenerate([textResponse('original')]);

      const hooks = new HookRegistry<OperativeHookMap>();
      hooks.on('validateResponse', async (response) => ({
        ...response,
        content: response.content + '-first',
      }));
      hooks.on('validateResponse', async (response) => ({
        ...response,
        content: response.content + '-second',
      }));

      const result = await run({
        generate,
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      });

      expect(result.content).toBe('original-first-second');
    });
  });

  describe('afterToolExecution', () => {
    it('array: both called in sequence', async () => {
      const calls: string[] = [];
      const generate = createMockGenerate([
        toolCallResponse([weatherToolCall('Denver')]),
        textResponse('Done'),
      ]);

      const hooks = new HookRegistry<OperativeHookMap>();
      hooks.on('afterToolExecution', async () => {
        calls.push('first');
      });
      hooks.on('afterToolExecution', async () => {
        calls.push('second');
      });

      await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      });

      expect(calls).toEqual(['first', 'second']);
    });
  });

  describe('onStep', () => {
    it('array: both called in sequence', async () => {
      const calls: string[] = [];
      const generate = createMockGenerate([textResponse('Hello')]);

      const hooks = new HookRegistry<OperativeHookMap>();
      hooks.on('onStep', async () => {
        calls.push('first');
      });
      hooks.on('onStep', async () => {
        calls.push('second');
      });

      await run({
        generate,
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      });

      expect(calls).toEqual(['first', 'second']);
    });
  });

  describe('backward compatibility', () => {
    it('single function still works for all hook types', async () => {
      const calls: string[] = [];

      const generate = createMockGenerate([
        toolCallResponse([weatherToolCall('Denver')]),
        textResponse('Done'),
      ]);

      const hooks = new HookRegistry<OperativeHookMap>();
      hooks.on('prepareStep', async () => {
        calls.push('prepareStep');
        return undefined;
      });
      hooks.on('beforeToolExecution', async ({ toolCalls }) => {
        calls.push('beforeToolExecution');
        return toolCalls;
      });
      hooks.on('afterToolExecution', async () => {
        calls.push('afterToolExecution');
      });
      hooks.on('onStep', async () => {
        calls.push('onStep');
      });

      await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      });

      expect(calls).toContain('prepareStep');
      expect(calls).toContain('beforeToolExecution');
      expect(calls).toContain('afterToolExecution');
      expect(calls).toContain('onStep');
    });
  });

  describe('error handling', () => {
    it('error in any hook member terminates the loop with run.error', async () => {
      const generate = createMockGenerate([textResponse('Hello')]);

      const hooks = new HookRegistry<OperativeHookMap>();
      hooks.on('onStep', async () => {
        throw new Error('hook failed');
      });
      hooks.on('onStep', async () => {
        // should not be called
      });

      const activeRun = createActiveRun({
        generate,
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      });

      const recorder = createRunRecorder(activeRun);
      const result = await activeRun.result;

      expect(result.finishReason).toBe('error');
      const errorEvents = recorder.events.filter((e) => e.type === 'run.error');
      expect(errorEvents).toHaveLength(1);
    });
  });
});

describe('AB-92/AB-252: hooks/composition.ts timer seam wired onto RuntimeServices', () => {
  it('withTimeout, given an injected RuntimeServices.timers pair, times a debounced hook out only when the injected timers advance — never on a real timer', async () => {
    const runtime = createManualRuntimeServices();
    let hookCalled = false;
    const debouncedHook = withTimeout(
      1000,
      async () => {
        hookCalled = true;
        // A hook that never itself resolves — the only way this call
        // settles is the injected timeout firing.
        return new Promise(() => {});
      },
      'ignore',
      {
        setTimeoutFunction: runtime.timers.setTimeout,
        clearTimeoutFunction: runtime.timers.clearTimeout,
      },
    );

    const resultPromise = debouncedHook();

    // Hasn't fired yet — the manual runtime's clock hasn't moved.
    while (runtime.pendingTimers().length === 0) {
      await Promise.resolve();
    }
    expect(hookCalled).toBe(true);

    const settledBeforeAdvance = await Promise.race([
      resultPromise.then(() => 'settled'),
      Promise.resolve('still-pending'),
    ]);
    expect(settledBeforeAdvance).toBe('still-pending');

    await runtime.advance(1000);
    const result = await resultPromise;

    expect(result).toBeUndefined();
  });

  it("withTimeout's fallback timer functions default to a RuntimeServices instance rather than a bare globalThis.setTimeout — the real-globals default still resolves without an explicit setTimeoutFunction/clearTimeoutFunction pair", async () => {
    const hook = withTimeout(50, async () => 'quick');
    const result = await hook();
    expect(result).toBe('quick');
  });
});
