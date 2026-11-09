/**
 * COR-2104 — `ToolExecutionHookContext.refuse`: a `beforeToolExecution` hook refuses one call on
 * behalf of a guardrail. The call does not run, whatever a later hook returns; the model is
 * answered with a `GUARDRAIL_BLOCKED` error naming the guardrail; the step's other calls run; and
 * every call stays paired with one result, in the order the model made them.
 */
import {
  type HookRegistrationOptions,
  HookRegistry,
  type HookRegistryOptions,
} from '@lostgradient/lifecycle';
import { createTestToolbox, createTool } from 'armorer';
import type { ToolCall } from 'armorer/protocol';
import { describe, expect, it } from 'bun:test';
import { Conversation, type Message } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from './conditions/predicates';
import { createActiveRun } from './create-run';
import { GuardrailTripwireError } from './errors';
import { GUARDRAIL_BLOCKED_CODE } from './guardrails/tool-result-guardrail';
import type { OperativeHookMap } from './hooks';
import { createMockGenerate, createRunRecorder } from './test/index';
import type { ToolExecutionHookContext } from './types';

type BeforeHook = (context: ToolExecutionHookContext) => Promise<ToolCall[]>;

/** A hook registered with its own options, as a plugin interceptor's `{ handler, onError }` is. */
interface RegisteredHook {
  readonly handler: BeforeHook;
  readonly options?: HookRegistrationOptions;
}

async function runWith(...handlers: BeforeHook[]) {
  return runRegistered(handlers.map((handler) => ({ handler })));
}

async function runRegistered(
  registered: readonly RegisteredHook[],
  registryOptions?: HookRegistryOptions,
) {
  const executed: string[] = [];
  const tool = (name: string) =>
    createTool({
      name,
      description: name,
      input: z.object({}),
      async execute() {
        executed.push(name);
        return `${name} ran`;
      },
    });
  const hooks = new HookRegistry<OperativeHookMap>(registryOptions);
  for (const { handler, options } of registered) hooks.on('beforeToolExecution', handler, options);
  const activeRun = createActiveRun({
    generate: createMockGenerate([
      {
        content: '',
        toolCalls: [
          { id: 'call-1', name: 'first', arguments: {} },
          { id: 'call-2', name: 'second', arguments: {} },
          { id: 'call-3', name: 'third', arguments: {} },
        ],
      },
      { content: 'done', toolCalls: [] },
    ]),
    toolbox: createTestToolbox([tool('first'), tool('second'), tool('third')]),
    conversation: new Conversation(),
    stopWhen: noToolCalls(),
    hooks,
  });
  const recorder = createRunRecorder(activeRun);
  const result = await activeRun.result;
  const rows = result.conversation
    .getMessages()
    .flatMap((message: Message) => (message.toolResult === undefined ? [] : [message.toolResult]));
  return { result, executed, rows, events: recorder.events };
}

describe('refusing a tool call from beforeToolExecution', () => {
  it('drops the refused call, answers it with GUARDRAIL_BLOCKED naming the guardrail, and runs the rest', async () => {
    const { result, executed, rows } = await runWith(async (context) => {
      context.refuse?.('call-2', 'no-second');
      // Returning every call does not put the refused one back.
      return context.toolCalls;
    });

    expect(result.finishReason).toBe('stop-condition');
    expect(executed).toEqual(['first', 'third']);
    // Each call is paired with one result row; a refused call's row is written before the others
    // run, as a filtered call's always was.
    expect(rows.map((row) => row.callId).toSorted()).toEqual(['call-1', 'call-2', 'call-3']);
    const refused = rows.find((row) => row.callId === 'call-2');
    expect(refused).toMatchObject({
      outcome: 'error',
      error: { category: 'permission', code: GUARDRAIL_BLOCKED_CODE },
    });
    expect(JSON.stringify(refused)).toContain('no-second');
    expect(JSON.stringify(refused)).not.toContain('skipped by beforeToolExecution');
    // The step result keeps the model's order.
    expect(result.steps[0]?.results.map((entry) => entry.toolCallId)).toEqual([
      'call-1',
      'call-2',
      'call-3',
    ]);
  });

  it('keeps a refused call out when a later hook returns it again', async () => {
    let original: ToolCall[] = [];
    let seenByLater: string[] = [];
    const { executed, rows } = await runWith(
      async (context) => {
        original = context.toolCalls;
        context.refuse?.('call-1', 'no-first');
        return context.toolCalls;
      },
      async (context) => {
        seenByLater = context.toolCalls.map((call) => call.id);
        return original;
      },
    );

    expect(seenByLater).toEqual(['call-2', 'call-3']);
    expect(executed).toEqual(['second', 'third']);
    expect(rows.find((row) => row.callId === 'call-1')?.error?.code).toBe(GUARDRAIL_BLOCKED_CODE);
  });

  it('names the first guardrail that refused a call', async () => {
    const { rows } = await runWith(async (context) => {
      context.refuse?.('call-3', 'first-refusal');
      context.refuse?.('call-3', 'second-refusal');
      return context.toolCalls;
    });
    const refused = JSON.stringify(rows.find((row) => row.callId === 'call-3'));
    expect(refused).toContain('first-refusal');
    expect(refused).not.toContain('second-refusal');
  });

  it('ignores a call id the step does not hold', async () => {
    const { executed, rows } = await runWith(async (context) => {
      context.refuse?.('call-99', 'nothing');
      return context.toolCalls;
    });
    expect(executed).toEqual(['first', 'second', 'third']);
    expect(rows).toHaveLength(3);
  });

  it('still answers a call a hook filtered without refusing it with the skipped message', async () => {
    const { executed, rows } = await runWith(async (context) =>
      context.toolCalls.filter((call) => call.id !== 'call-2'),
    );
    expect(executed).toEqual(['first', 'third']);
    expect(rows.find((row) => row.callId === 'call-2')).toMatchObject({
      outcome: 'error',
      content: 'Tool execution skipped by beforeToolExecution hook',
    });
  });

  it('halts on a tool-call tripwire before any call runs, answering every call with a refusal', async () => {
    const { result, executed, rows, events } = await runWith(async () => {
      throw new GuardrailTripwireError('tripped', {
        guardrailName: 'refund-cap',
        category: 'refund-limit',
        phase: 'tool-call',
        confidence: 1,
      });
    });

    expect(result.finishReason).toBe('tripwire');
    expect(executed).toEqual([]);
    expect(rows.map((row) => row.callId)).toEqual(['call-1', 'call-2', 'call-3']);
    for (const row of rows) {
      expect(row.error?.code).toBe(GUARDRAIL_BLOCKED_CODE);
      expect(JSON.stringify(row)).toContain('refund-cap');
    }
    const tripwires = events.filter((event) => event.type === 'run.tripwire');
    expect(tripwires).toHaveLength(1);
    expect(tripwires[0]?.detail).toMatchObject({ phase: 'tool-call', guardrailName: 'refund-cap' });
  });

  it('still fails the step as a tool error when a hook throws anything else', async () => {
    const { result, executed, rows } = await runWith(async () => {
      throw new Error('hook broke');
    });
    expect(result.finishReason).toBe('error');
    expect(executed).toEqual([]);
    expect(rows[0]?.content).toContain('beforeToolExecution hook failed');
  });
});

describe('a beforeToolExecution hook with its own onError beside a guardrail', () => {
  const tripwire = () =>
    new GuardrailTripwireError('tripped', {
      guardrailName: 'cap',
      category: 'limit',
      phase: 'tool-call',
      confidence: 1,
    });

  it('a hook that throws with onError continue does not undo a refusal it recorded first', async () => {
    const { result, executed, rows } = await runRegistered([
      {
        handler: async (context) => {
          context.refuse?.('call-2', 'no-second');
          throw new Error('hook broke after refusing');
        },
        options: { onError: () => 'continue' },
      },
    ]);

    expect(result.finishReason).toBe('stop-condition');
    expect(executed).toEqual(['first', 'third']);
    const second = rows.find((row) => row.callId === 'call-2');
    expect(second?.error?.code).toBe(GUARDRAIL_BLOCKED_CODE);
    expect(JSON.stringify(second)).toContain('no-second');
  });

  it('a refusal recorded by an earlier hook survives a later hook that throws and continues', async () => {
    const { executed } = await runRegistered([
      {
        handler: async (context) => {
          context.refuse?.('call-1', 'no-first');
          return context.toolCalls.filter((call) => call.id !== 'call-1');
        },
      },
      {
        handler: async () => {
          throw new Error('later hook broke');
        },
        options: { onError: () => 'continue' },
      },
    ]);

    expect(executed).toEqual(['second', 'third']);
  });

  it('a guardrail tripwire still halts when a plugin interceptor with onError continue sits beside it', async () => {
    const { result, executed, rows } = await runRegistered([
      {
        // The guardrail registration sets no onError.
        handler: async () => {
          throw tripwire();
        },
        options: { priority: 10 },
      },
      {
        handler: async (context) => context.toolCalls,
        options: { onError: () => 'continue', priority: 0 },
      },
    ]);

    expect(result.finishReason).toBe('tripwire');
    expect(executed).toEqual([]);
    expect(rows.map((row) => row.callId)).toEqual(['call-1', 'call-2', 'call-3']);
  });

  it('a tripwire is never skipped by an onError continue, the hook’s own or the registry’s', async () => {
    const own = await runRegistered([
      {
        handler: async () => {
          throw tripwire();
        },
        options: { onError: () => 'continue' },
      },
    ]);
    expect(own.result.finishReason).toBe('tripwire');
    expect(own.executed).toEqual([]);

    const registry = await runRegistered(
      [
        {
          handler: async () => {
            throw tripwire();
          },
        },
      ],
      { onError: () => 'continue' },
    );
    expect(registry.result.finishReason).toBe('tripwire');
    expect(registry.executed).toEqual([]);
  });
});
