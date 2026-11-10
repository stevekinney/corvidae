/**
 * COR-2104 — a tool-call validator reads each call's name and arguments before the call runs, and
 * its action (its own, or its group's) decides whether the call is refused, runs with a warning,
 * or halts the run.
 */
import type { ToolCall } from 'armorer/protocol';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { GuardrailTripwireError } from '../errors';
import type { ToolExecutionHookContext } from '../types';
import { createGuardrails } from './create-guardrails';
import {
  createToolCallGuardrail,
  guardrailRefusedCallMessage,
  guardrailRefusedCallResult,
} from './tool-call-guardrail';
import { GUARDRAIL_BLOCKED_CODE } from './tool-result-guardrail';
import type {
  SessionTaintedEvent,
  ToolCallGuardrailAction,
  ToolCallGuardrailTriggeredEvent,
  ToolCallValidator,
  ToolCallValidatorCall,
  ToolCallValidatorContext,
} from './types';

const REFUND: ToolCall = { id: 'call-1', name: 'refund', arguments: { amount: 150 } };
const SMALL_REFUND: ToolCall = { id: 'call-3', name: 'refund', arguments: { amount: 20 } };
const LOOKUP: ToolCall = { id: 'call-2', name: 'lookup', arguments: { order: 'A-1' } };

function refundCap(
  options: {
    name?: string;
    action?: ToolCallGuardrailAction;
    confidence?: number;
    seen?: Array<{ call: ToolCallValidatorCall; context: ToolCallValidatorContext }>;
  } = {},
): ToolCallValidator {
  return {
    name: options.name ?? 'refund-cap',
    ...(options.action === undefined ? {} : { action: options.action }),
    validate: async (call, context) => {
      options.seen?.push({ call, context });
      const amount = (call.arguments as { amount?: number }).amount ?? 0;
      return call.name === 'refund' && amount > 100
        ? {
            valid: false,
            category: 'refund-limit',
            confidence: options.confidence ?? 1,
            detail: 'over',
          }
        : { valid: true, category: 'refund-limit', confidence: 0 };
    },
  };
}

function hookContext(calls: ToolCall[]): {
  context: ToolExecutionHookContext;
  refused: Array<[string, string]>;
} {
  const refused: Array<[string, string]> = [];
  return {
    refused,
    context: {
      conversation: new Conversation(),
      step: 3,
      toolCalls: calls,
      refuse: (callId, guardrailName) => refused.push([callId, guardrailName]),
    },
  };
}

describe('createToolCallGuardrail', () => {
  it('refuses a call that breaks the rule and keeps the others (block, the default)', async () => {
    const events: ToolCallGuardrailTriggeredEvent[] = [];
    const hook = createToolCallGuardrail({
      validators: [refundCap()],
      onTriggered: (event) => events.push(event),
    });
    const { context, refused } = hookContext([REFUND, LOOKUP, SMALL_REFUND]);

    expect(await hook(context)).toEqual([LOOKUP, SMALL_REFUND]);
    expect(refused).toEqual([['call-1', 'refund-cap']]);
    expect(events).toEqual([
      {
        validator: 'refund-cap',
        category: 'refund-limit',
        confidence: 1,
        action: 'block',
        call: { id: 'call-1', name: 'refund', arguments: { amount: 150 } },
        detail: 'over',
      },
    ]);
  });

  it('lets a call through with a warning under action warn', async () => {
    const events: ToolCallGuardrailTriggeredEvent[] = [];
    const hook = createToolCallGuardrail({
      validators: [refundCap({ action: 'warn' })],
      action: 'block',
      onTriggered: (event) => events.push(event),
    });
    const { context, refused } = hookContext([REFUND, LOOKUP]);

    expect(await hook(context)).toEqual([REFUND, LOOKUP]);
    expect(refused).toEqual([]);
    expect(events.map((event) => event.action)).toEqual(['warn']);
  });

  it('throws a tool-call tripwire, refusing nothing, when any call trips', async () => {
    const hook = createToolCallGuardrail({ validators: [refundCap()], action: 'tripwire' });
    const { context, refused } = hookContext([LOOKUP, REFUND]);

    const error = await hook(context).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GuardrailTripwireError);
    expect(error).toMatchObject({
      guardrailName: 'refund-cap',
      category: 'refund-limit',
      phase: 'tool-call',
      confidence: 1,
    });
    expect(refused).toEqual([]);
  });

  it('decides a call by the furthest-reaching action, then the surest validator', async () => {
    const hook = createToolCallGuardrail({
      validators: [
        refundCap({ name: 'warns', action: 'warn', confidence: 1 }),
        refundCap({ name: 'blocks-unsure', action: 'block', confidence: 0.5 }),
        refundCap({ name: 'blocks-sure', action: 'block', confidence: 0.9 }),
      ],
    });
    const { context, refused } = hookContext([REFUND]);

    expect(await hook(context)).toEqual([]);
    expect(refused).toEqual([['call-1', 'blocks-sure']]);
  });

  it('fails closed when a validator throws: the call is refused, even under warn', async () => {
    for (const action of ['block', 'warn'] as const) {
      const hook = createToolCallGuardrail({
        action,
        validators: [
          {
            name: 'broken',
            validate: async () => {
              throw new Error('down');
            },
          },
        ],
      });
      const { context, refused } = hookContext([REFUND]);

      expect(await hook(context)).toEqual([]);
      expect(refused).toEqual([['call-1', 'broken']]);
    }
  });

  it('hands each validator its own copy of the call and the step it judges', async () => {
    const seen: Array<{ call: ToolCallValidatorCall; context: ToolCallValidatorContext }> = [];
    const mutating: ToolCallValidator = {
      name: 'mutating',
      validate: async (call) => {
        (call.arguments as { amount: number }).amount = 1;
        return { valid: true, category: 'none', confidence: 0 };
      },
    };
    const hook = createToolCallGuardrail({
      validators: [mutating, refundCap({ seen })],
      getSessionTainted: () => true,
    });
    const call: ToolCall = { id: 'call-1', name: 'refund', arguments: { amount: 150 } };
    const { context } = hookContext([call, LOOKUP]);

    await hook(context);
    expect(call.arguments).toEqual({ amount: 150 });
    expect(seen[0]?.context).toEqual({
      step: 3,
      conversationLength: 0,
      toolCallCount: 2,
      sessionTainted: true,
    });
  });

  it('refuses an action that is not block, warn or tripwire', () => {
    expect(() =>
      createToolCallGuardrail({
        validators: [{ ...refundCap(), action: 'redact' as ToolCallGuardrailAction }],
      }),
    ).toThrow(TypeError);
  });
});

describe('guardrailRefusedCallResult', () => {
  it('answers the call with a GUARDRAIL_BLOCKED permission error naming the guardrail', () => {
    const result = guardrailRefusedCallResult({ ...REFUND, providerCallId: 'p-1' }, 'refund-cap');
    expect(result).toEqual({
      callId: 'call-1',
      toolCallId: 'call-1',
      providerCallId: 'p-1',
      toolName: 'refund',
      outcome: 'error',
      content: guardrailRefusedCallMessage('refund-cap'),
      result: undefined,
      error: {
        category: 'permission',
        message: 'Tool call blocked by guardrail "refund-cap".',
        code: GUARDRAIL_BLOCKED_CODE,
        retryable: false,
      },
      errorMessage: 'Tool call blocked by guardrail "refund-cap".',
      errorCategory: 'permission',
    });
  });
});

describe('createGuardrails tool-call validators', () => {
  it('taints the session when a call is blocked, even below the taint threshold (COR-2300)', async () => {
    const taints: SessionTaintedEvent[] = [];
    const guardrails = createGuardrails({
      tools: { validators: [refundCap({ confidence: 0.4 })] },
      taint: { taintThreshold: 0.9, onTainted: (event) => taints.push(event) },
    });
    expect(guardrails.taint.isTainted()).toBe(false);
    await guardrails.beforeToolExecution(hookContext([REFUND]).context);
    expect(guardrails.taint.isTainted()).toBe(true);
    expect(taints).toEqual([expect.objectContaining({ detector: 'refund-cap', step: 3 })]);
  });

  it('does not taint the session for a warning below the threshold, or a passing call', async () => {
    const guardrails = createGuardrails({
      tools: { validators: [refundCap({ action: 'warn', confidence: 0.4 })] },
      taint: { taintThreshold: 0.9 },
    });
    await guardrails.beforeToolExecution(hookContext([REFUND, SMALL_REFUND]).context);
    expect(guardrails.taint.isTainted()).toBe(false);
  });

  it('taints the session when a validator fails closed', async () => {
    const guardrails = createGuardrails({
      tools: {
        validators: [
          {
            name: 'broken',
            validate: async () => {
              throw new Error('down');
            },
          },
        ],
      },
    });
    await guardrails.beforeToolExecution(hookContext([REFUND]).context);
    expect(guardrails.taint.isTainted()).toBe(true);
  });

  it('returns the calls unchanged without tool validators', async () => {
    const guardrails = createGuardrails({ mode: 'tripwire' });
    const { context } = hookContext([REFUND]);
    expect(await guardrails.beforeToolExecution(context)).toEqual([REFUND]);
  });

  it('mode tripwire sets the group action, not a validator’s own', async () => {
    const bare = createGuardrails({ mode: 'tripwire', tools: { validators: [refundCap()] } });
    expect(await bare.beforeToolExecution(hookContext([REFUND]).context).catch((e) => e)).toEqual(
      expect.any(GuardrailTripwireError),
    );

    const own = createGuardrails({
      mode: 'tripwire',
      tools: { validators: [refundCap({ action: 'block' })] },
    });
    const { context, refused } = hookContext([REFUND, LOOKUP]);
    expect(await own.beforeToolExecution(context)).toEqual([LOOKUP]);
    expect(refused).toEqual([['call-1', 'refund-cap']]);
  });

  it('reports a block or a warning as a tool-call firing, and a tripwire not at all', async () => {
    const firings: unknown[] = [];
    const guardrails = createGuardrails({
      mode: 'validate',
      tools: { validators: [refundCap(), refundCap({ name: 'warns', action: 'warn' })] },
    });
    const { context } = hookContext([REFUND]);
    await guardrails.beforeToolExecution({
      ...context,
      reportGuardrail: (firing) => firings.push(firing),
    });
    expect(firings).toEqual([
      {
        guardrailName: 'refund-cap',
        category: 'refund-limit',
        phase: 'tool-call',
        confidence: 1,
        action: 'block',
      },
    ]);
  });
});
