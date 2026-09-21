import { HookRegistry } from '@lostgradient/lifecycle';
import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';
import { assertDefined } from './assert-defined';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import type { OperativeHookMap } from '../src/hooks';
import { createMockGenerate } from '../src/test/index';
import type { GenerateResponse } from '../src/types';
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
  return { content, toolCalls, usage: undefined };
}

function textResponse(content: string): GenerateResponse {
  return { content, toolCalls: [], usage: undefined };
}

describe('HookRegistry integration', () => {
  it('prepareStep hook runs before each step', async () => {
    const prepareStepCalls: number[] = [];
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('prepareStep', async ({ step }) => {
      prepareStepCalls.push(step);
    });

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done'),
    ]);

    await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(prepareStepCalls).toEqual([0, 1]);
    expect(generate.callCount).toBe(2);
  });

  it('prepareStep hook can return a GenerateResponse to skip generate', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('prepareStep', async () => {
      return { content: 'Intercepted by registry', toolCalls: [] };
    });

    const generate = createMockGenerate([textResponse('Should not be called')]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(generate.callCount).toBe(0);
    expect(result.content).toBe('Intercepted by registry');
  });

  it('beforeToolExecution hook can filter tool calls', async () => {
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

    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('beforeToolExecution', async ({ toolCalls }) => {
      return toolCalls.filter((call) => {
        const args = call.arguments as { location: string };
        return args.location === 'Denver';
      });
    });

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver'), weatherToolCall('Seattle')]),
      textResponse('Done'),
    ]);

    await run({
      generate,
      toolbox: createTestToolbox([trackingTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(executedLocations).toEqual(['Denver']);
  });

  it('afterToolExecution hook receives results', async () => {
    const afterCalls: Array<{
      step: number;
      toolCallNames: string[];
      resultCount: number;
    }> = [];

    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('afterToolExecution', async ({ step, toolCalls, results }) => {
      afterCalls.push({
        step,
        toolCallNames: toolCalls.map((call) => call.name),
        resultCount: results.length,
      });
    });

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')]),
      textResponse('Done'),
    ]);

    await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(afterCalls).toHaveLength(1);
    expect(assertDefined(afterCalls[0]).step).toBe(0);
    expect(assertDefined(afterCalls[0]).toolCallNames).toEqual(['get_weather']);
    expect(assertDefined(afterCalls[0]).resultCount).toBe(1);
  });

  it('onStep hook is called after each step', async () => {
    const stepNumbers: number[] = [];
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('onStep', async (result) => {
      stepNumbers.push(result.step);
    });

    const generate = createMockGenerate([
      toolCallResponse([weatherToolCall('Denver')], 'Checking...'),
      textResponse('Done'),
    ]);

    await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(stepNumbers).toEqual([0, 1]);
  });

  it('validateResponse hook can transform the response', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('validateResponse', async (response) => {
      return { ...response, content: response.content + ' [validated]' };
    });

    const generate = createMockGenerate([textResponse('Original')]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.content).toBe('Original [validated]');
  });

  it('validateResponse registry hook errors terminate the run', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('validateResponse', async () => {
      throw new Error('registry validateResponse failed');
    });

    const result = await run({
      generate: createMockGenerate([textResponse('Original')]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.finishReason).toBe('error');
  });

  it('selectTools hook can replace the toolbox', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    const emptyToolbox = createTestToolbox([]);

    hooks.on('selectTools', async () => {
      return emptyToolbox;
    });

    const generate = createMockGenerate([textResponse('Done')]);

    const result = await run({
      generate,
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.finishReason).toBe('stop-condition');
  });

  it('beforeToolExecution registry hook errors terminate the run', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('beforeToolExecution', async () => {
      throw new Error('registry beforeToolExecution failed');
    });

    const result = await run({
      generate: createMockGenerate([toolCallResponse([weatherToolCall('Denver')])]),
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.finishReason).toBe('error');
  });

  it('afterToolExecution registry hook errors terminate the run', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    hooks.on('afterToolExecution', async () => {
      throw new Error('registry afterToolExecution failed');
    });

    const result = await run({
      generate: createMockGenerate([
        toolCallResponse([weatherToolCall('Denver')]),
        textResponse('Done'),
      ]),
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(result.finishReason).toBe('error');
  });

  describe('priority ordering', () => {
    it('higher priority handlers run first within the registry', async () => {
      const log: string[] = [];

      const hooks = new HookRegistry<OperativeHookMap>();

      hooks.on(
        'onStep',
        async () => {
          log.push('low-priority');
        },
        { priority: 1 },
      );

      hooks.on(
        'onStep',
        async () => {
          log.push('high-priority');
        },
        { priority: 10 },
      );

      hooks.on(
        'onStep',
        async () => {
          log.push('medium-priority');
        },
        { priority: 5 },
      );

      const generate = createMockGenerate([textResponse('Done')]);

      await run({
        generate,
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      });

      expect(log).toEqual(['high-priority', 'medium-priority', 'low-priority']);
    });

    it('higher priority beforeToolExecution runs first and chains', async () => {
      const log: string[] = [];

      const hooks = new HookRegistry<OperativeHookMap>();

      hooks.on(
        'beforeToolExecution',
        async ({ toolCalls }) => {
          log.push('low-priority');
          return toolCalls;
        },
        { priority: 1 },
      );

      hooks.on(
        'beforeToolExecution',
        async ({ toolCalls }) => {
          log.push('high-priority');
          return toolCalls;
        },
        { priority: 10 },
      );

      const generate = createMockGenerate([
        toolCallResponse([weatherToolCall('Denver')]),
        textResponse('Done'),
      ]);

      await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      });

      expect(log).toEqual(['high-priority', 'low-priority']);
    });
  });

  describe('validateToolResult via registry', () => {
    it('validateToolResult hook can transform results', async () => {
      const hooks = new HookRegistry<OperativeHookMap>();

      hooks.on('validateToolResult', async (result) => {
        return { ...result, content: '[redacted]' };
      });

      const generate = createMockGenerate([
        toolCallResponse([weatherToolCall('Denver')]),
        textResponse('Done'),
      ]);

      const runResult = await run({
        generate,
        toolbox: createTestToolbox([tool]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      });

      expect(assertDefined(assertDefined(runResult.steps[0]).results[0]).content).toBe(
        '[redacted]',
      );
    });
  });

  describe('error handling', () => {
    it('registry hook error terminates the loop', async () => {
      const hooks = new HookRegistry<OperativeHookMap>();

      hooks.on('onStep', async () => {
        throw new Error('registry hook failed');
      });

      const generate = createMockGenerate([textResponse('Hello')]);

      const result = await run({
        generate,
        toolbox: createTestToolbox([]),
        conversation: new Conversation(),
        stopWhen: noToolCalls(),
        hooks,
      });

      expect(result.finishReason).toBe('error');
      expect(result.error).toBeInstanceOf(Error);
    });
  });
});

// ---------------------------------------------------------------------------
// COR-1266 — every OperativeHookMap key has a real runtime dispatch site.
//
// This replaces a block of type-only "completeness" tests that registered a
// handler and then asserted `typeof hooks.run === 'function'`. Their comment
// claimed `HookRegistry.on()` "would throw at runtime (unknown key)" for a key
// not on the map — it does not. `on()` pushes into a Map and validates
// nothing, so those assertions held for any string whatsoever and passed just
// as happily for the 21 names nothing ever dispatched. A gate that returns
// green for the wrong reason is worse than a missing one, because it reads as
// evidence.
//
// What follows proves the property the old block only claimed: each key is
// OBSERVED being invoked during a real run. Exhaustiveness is enforced by the
// compiler (`Record<(typeof DISPATCHED_HOOKS)[number], true>` has to satisfy
// `Record<keyof OperativeHookMap, true>`), so adding a key to the map without
// a dispatch site fails to compile rather than slipping through unnoticed.
// ---------------------------------------------------------------------------

const DISPATCHED_HOOKS = [
  'prepareStep',
  'selectTools',
  'selectToolChoice',
  'beforeGenerate',
  'onLLMInput',
  'onLLMOutput',
  'afterGenerate',
  'validateResponse',
  'beforeToolExecution',
  'afterToolExecution',
  'validateToolResult',
  'onStep',
  'onRunStart',
  'onRunComplete',
  'beforeCompaction',
  'afterCompaction',
  'onError',
  'onRunError',
  'onRunAbort',
] as const satisfies readonly (keyof OperativeHookMap)[];

// The exhaustiveness half. A key added to `OperativeHookMap` and left out of
// `DISPATCHED_HOOKS` makes this assignment fail to compile — which is the
// point: a hook name may not enter the public map without a dispatch site and
// a scenario below that reaches it.
type DispatchedHookName = (typeof DISPATCHED_HOOKS)[number];
const _everyHookIsDispatched: Record<keyof OperativeHookMap, true> = Object.fromEntries(
  DISPATCHED_HOOKS.map((name) => [name, true]),
) as Record<DispatchedHookName, true>;
void _everyHookIsDispatched;

/**
 * Registers a recording handler on every name and returns the set actually
 * invoked. Handlers return `undefined` throughout so none of them perturbs the
 * run it is observing — a `prepareStep` returning a response would short-
 * circuit generate, and a `validateResponse` returning one would replace it.
 */
function recordEveryHook(): {
  hooks: HookRegistry<OperativeHookMap>;
  invoked: Set<string>;
} {
  const hooks = new HookRegistry<OperativeHookMap>();
  const invoked = new Set<string>();
  for (const name of DISPATCHED_HOOKS) {
    // The recorder is deliberately uniform across hooks whose signatures
    // differ. No cast is needed: every one of them tolerates an `undefined`
    // return, so the shared handler is assignable to each.
    hooks.on(name, async () => {
      invoked.add(name);
      return undefined;
    });
  }
  return { hooks, invoked };
}

describe('OperativeHookMap dispatch completeness (COR-1266)', () => {
  it('invokes the full-run hooks during a run that calls a tool and finishes', async () => {
    const { hooks, invoked } = recordEveryHook();

    await run({
      generate: createMockGenerate([toolCallResponse([weatherToolCall()]), textResponse('done')]),
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    for (const name of [
      'prepareStep',
      'selectTools',
      'selectToolChoice',
      'beforeGenerate',
      'onLLMInput',
      'onLLMOutput',
      'afterGenerate',
      'validateResponse',
      'beforeToolExecution',
      'afterToolExecution',
      'validateToolResult',
      'onStep',
      'onRunStart',
      'onRunComplete',
    ] satisfies readonly DispatchedHookName[]) {
      expect(invoked).toContain(name);
    }
  });

  it('invokes the error hooks when generate throws', async () => {
    const { hooks, invoked } = recordEveryHook();

    await run({
      generate: async () => {
        throw new Error('generate failed');
      },
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    expect(invoked).toContain('onError');
    expect(invoked).toContain('onRunError');
  });

  it('invokes the compaction hooks when the conversation exceeds its budget', async () => {
    const { hooks, invoked } = recordEveryHook();
    const conversation = new Conversation();
    conversation.appendUserMessage('A'.repeat(400));

    await run({
      generate: createMockGenerate([textResponse('done')]),
      toolbox: createTestToolbox([]),
      conversation,
      stopWhen: noToolCalls(),
      hooks,
      // A budget this small guarantees the step exceeds it, so compaction is
      // reached rather than skipped. The recorder returns `undefined` from
      // `beforeCompaction`, which is not `false`, so compaction proceeds and
      // `afterCompaction` is reached too.
      contextManagement: { maxTokens: 10, onCompact: async () => undefined },
    });

    expect(invoked).toContain('beforeCompaction');
    expect(invoked).toContain('afterCompaction');
  });

  it('invokes onRunAbort when the run is aborted', async () => {
    const { hooks, invoked } = recordEveryHook();
    const controller = new AbortController();

    const active = createActiveRun({
      generate: async () => {
        controller.abort();
        return textResponse('never observed');
      },
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      signal: controller.signal,
      hooks,
    });
    await active.result;

    expect(invoked).toContain('onRunAbort');
  });

  it('leaves no key in the map unreached by the scenarios above', async () => {
    // The union check. Without it, a name could sit in `DISPATCHED_HOOKS`,
    // satisfy the compile-time exhaustiveness assertion, and still never be
    // dispatched by any scenario here — the per-scenario assertions only
    // cover the names each one names.
    const reached = new Set<string>();

    const full = recordEveryHook();
    await run({
      generate: createMockGenerate([toolCallResponse([weatherToolCall()]), textResponse('done')]),
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks: full.hooks,
    });
    for (const name of full.invoked) reached.add(name);

    const compaction = recordEveryHook();
    const longConversation = new Conversation();
    longConversation.appendUserMessage('A'.repeat(400));
    await run({
      generate: createMockGenerate([textResponse('done')]),
      toolbox: createTestToolbox([]),
      conversation: longConversation,
      stopWhen: noToolCalls(),
      hooks: compaction.hooks,
      contextManagement: { maxTokens: 10, onCompact: async () => undefined },
    });
    for (const name of compaction.invoked) reached.add(name);

    const failing = recordEveryHook();
    await run({
      generate: async () => {
        throw new Error('generate failed');
      },
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks: failing.hooks,
    });
    for (const name of failing.invoked) reached.add(name);

    const aborting = recordEveryHook();
    const controller = new AbortController();
    const active = createActiveRun({
      generate: async () => {
        controller.abort();
        return textResponse('never observed');
      },
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      signal: controller.signal,
      hooks: aborting.hooks,
    });
    await active.result;
    for (const name of aborting.invoked) reached.add(name);

    const unreached = DISPATCHED_HOOKS.filter((name) => !reached.has(name));
    expect(unreached).toEqual([]);
  });
});

describe('run-level hook-plan introspection (COR-1270)', () => {
  it('describes the plan the run is actually executing against', async () => {
    const hooks = new HookRegistry<OperativeHookMap>({ source: 'direct' });
    hooks.on('prepareStep', async () => undefined, { id: 'direct:prepare', replay: 'safe' });
    hooks.on('onStep', async () => undefined, { id: 'direct:step' });

    const active = createActiveRun({
      generate: createMockGenerate([textResponse('done')]),
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    const plan = active.describeHookPlan();
    expect(plan?.revision).toBe(2);
    expect(plan?.entries).toEqual([
      {
        hookName: 'prepareStep',
        id: 'direct:prepare',
        priority: 0,
        replay: 'safe',
        source: 'direct',
      },
      { hookName: 'onStep', id: 'direct:step', priority: 0, replay: 'effectful', source: 'direct' },
    ]);

    await active.result;
  });

  it('reports no plan at all for a run configured without hooks', async () => {
    const active = createActiveRun({
      generate: createMockGenerate([textResponse('done')]),
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    // `undefined`, not an empty plan: "this run has no hook surface" and "this
    // run has a plan that happens to be empty" are different facts, and an
    // inspector explaining a run's behavior needs to tell them apart.
    expect(active.describeHookPlan()).toBeUndefined();

    await active.result;
  });

  it('exposes no handler to the caller through the run', async () => {
    const secret = 'sk-live-run-scoped';
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('prepareStep', async () => {
      void secret;
      return undefined;
    });

    const active = createActiveRun({
      generate: createMockGenerate([textResponse('done')]),
      toolbox: createTestToolbox([tool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });

    const serialized = JSON.stringify(active.describeHookPlan());
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('function');

    await active.result;
  });
});
