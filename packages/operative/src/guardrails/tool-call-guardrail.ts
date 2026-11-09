/**
 * COR-2104 — tool-call validators, the guardrail checkpoint between a model's reply and the tools
 * it calls.
 *
 * An output validator reads the reply's text and thinking, never a tool call's arguments, so a
 * model that writes nothing alarming but calls a tool with something dangerous passes it. These
 * validators read each call before it runs.
 */
import type { ToolExecutionResult } from 'armorer';
import type { ToolCall } from 'armorer/protocol';

import { GuardrailTripwireError } from '../errors';
import type { BeforeToolExecutionHook } from '../types';
import { GUARDRAIL_BLOCKED_CODE } from './tool-result-guardrail';
import type {
  ToolCallGuardrailAction,
  ToolCallGuardrailOptions,
  ToolCallGuardrailTriggeredEvent,
  ToolCallValidationResult,
  ToolCallValidator,
  ToolCallValidatorCall,
  ToolCallValidatorContext,
} from './types';

/** The message a refused call is answered with: the guardrail's name, and nothing it found. */
export function guardrailRefusedCallMessage(guardrailName: string): string {
  return `Tool call blocked by guardrail "${guardrailName}".`;
}

/**
 * The result that answers a call a guardrail refused before it ran: a `GUARDRAIL_BLOCKED`
 * permission error naming the guardrail, paired with the call.
 */
export function guardrailRefusedCallResult(
  call: ToolCall,
  guardrailName: string,
): ToolExecutionResult {
  const message = guardrailRefusedCallMessage(guardrailName);
  return {
    callId: call.id,
    toolCallId: call.id,
    ...(call.providerCallId === undefined ? {} : { providerCallId: call.providerCallId }),
    toolName: call.name,
    outcome: 'error',
    content: message,
    result: undefined,
    error: { category: 'permission', message, code: GUARDRAIL_BLOCKED_CODE, retryable: false },
    errorMessage: message,
    errorCategory: 'permission',
  };
}

/** How far an action goes, so the furthest-reaching of several findings decides. */
const SEVERITY: Record<ToolCallGuardrailAction, number> = { warn: 1, block: 2, tripwire: 3 };

interface Finding {
  readonly validator: ToolCallValidator;
  readonly result: ToolCallValidationResult;
  readonly action: ToolCallGuardrailAction;
}

/** The finding that decides: the furthest-reaching action, and among those the surest validator. */
function decisive(findings: readonly Finding[]): Finding | undefined {
  let top: Finding | undefined;
  for (const finding of findings) {
    if (
      top === undefined ||
      SEVERITY[finding.action] > SEVERITY[top.action] ||
      (SEVERITY[finding.action] === SEVERITY[top.action] &&
        finding.result.confidence > top.result.confidence)
    ) {
      top = finding;
    }
  }
  return top;
}

/**
 * Creates a `beforeToolExecution` hook that judges each of a step's calls with `validators` before
 * any of them runs.
 *
 * Each validator's own `action`, or else `options.action` (default `'block'`), decides what its
 * finding does, and the furthest-reaching finding on a call decides for that call:
 * - `'block'`: the call is refused through `context.refuse` and left out of the returned list, so it
 *   never runs and the model is answered with a `GUARDRAIL_BLOCKED` error naming the validator. The
 *   step's other calls run.
 * - `'warn'`: the call runs, and `onTriggered` is told.
 * - `'tripwire'`: throws a `GuardrailTripwireError` with phase `'tool-call'`, which halts the run
 *   before any call of the step runs.
 *
 * A validator that throws or rejects is contained, as a detector is in the input pipeline: it finds
 * nothing. Each validator receives its own copy of a call, so it cannot change what runs. Throws
 * `TypeError` for an action that is not `block`, `warn` or `tripwire`.
 */
export function createToolCallGuardrail(
  options: ToolCallGuardrailOptions & {
    /** The session's taint state as the validators should see it. */
    readonly getSessionTainted?: (() => boolean) | undefined;
  },
): BeforeToolExecutionHook {
  const { validators, action: groupAction = 'block', onTriggered, getSessionTainted } = options;
  for (const [name, action] of [
    ['the group', groupAction],
    ...validators.map((validator) => [`"${validator.name}"`, validator.action] as const),
  ] as const) {
    if (action !== undefined && !Object.hasOwn(SEVERITY, action)) {
      throw new TypeError(
        `The tool-call guardrail action of ${name} is "${action}", which is not one of block, warn, tripwire.`,
      );
    }
  }

  return async (context) => {
    const calls = context.toolCalls;
    if (validators.length === 0 || calls.length === 0) return calls;
    const validatorContext: ToolCallValidatorContext = {
      step: context.step,
      conversationLength: context.conversation.getMessages().length,
      toolCallCount: calls.length,
      sessionTainted: getSessionTainted?.() ?? false,
    };

    const judge = async (call: ToolCall): Promise<Finding | undefined> => {
      const settled = await Promise.allSettled(
        validators.map(async (validator) => {
          const judged: ToolCallValidatorCall = {
            id: call.id,
            name: call.name,
            arguments: structuredClone(call.arguments),
          };
          return { validator, result: await validator.validate(judged, validatorContext) };
        }),
      );
      return decisive(
        settled.flatMap((outcome) =>
          outcome.status === 'fulfilled' && !outcome.value.result.valid
            ? [{ ...outcome.value, action: outcome.value.validator.action ?? groupAction }]
            : [],
        ),
      );
    };
    const verdicts = await Promise.all(
      calls.map(async (call) => ({ call, finding: await judge(call) })),
    );

    const eventOf = (call: ToolCall, finding: Finding): ToolCallGuardrailTriggeredEvent => ({
      validator: finding.validator.name,
      category: finding.result.category,
      confidence: finding.result.confidence,
      action: finding.action,
      call: { id: call.id, name: call.name, arguments: call.arguments },
      ...(finding.result.detail === undefined ? {} : { detail: finding.result.detail }),
    });

    // A tripwire anywhere in the step halts it before any call runs, the refused ones included.
    const tripped = verdicts.find(({ finding }) => finding?.action === 'tripwire');
    if (tripped?.finding !== undefined) {
      const { call, finding } = tripped;
      onTriggered?.(eventOf(call, finding));
      throw new GuardrailTripwireError(
        `Tool-call guardrail tripwire: "${finding.validator.name}" refused the call to "${call.name}" (${finding.result.category}).`,
        {
          guardrailName: finding.validator.name,
          category: finding.result.category,
          phase: 'tool-call',
          confidence: finding.result.confidence,
          detail: finding.result.detail,
        },
      );
    }

    const refused = new Set<string>();
    for (const { call, finding } of verdicts) {
      if (finding === undefined) continue;
      onTriggered?.(eventOf(call, finding));
      if (finding.action === 'block') {
        context.refuse?.(call.id, finding.validator.name);
        refused.add(call.id);
      }
    }
    return refused.size === 0 ? calls : calls.filter((call) => !refused.has(call.id));
  };
}
