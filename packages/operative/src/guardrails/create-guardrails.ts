import type {
  BeforeToolExecutionHook,
  GenerateResponse,
  StepContext,
  ToolExecutionResultContext,
  ValidateToolResultHook,
} from '../types';
import { guardrailPartitions } from './guardrail-entries';
import { inputGuardrailHook } from './input-guardrail';
import { createOutputGuardrail } from './output-guardrail';
import { createSessionTaintTracker } from './session-taint';
import { createToolCallGuardrail } from './tool-call-guardrail';
import { toolResultGuardrailHook } from './tool-result-guardrail';
import type {
  GuardrailHooks,
  GuardrailsOptions,
  InputGuardrailAction,
  InputGuardrailOptions,
  OutputGuardrailAction,
  OutputGuardrailOptions,
} from './types';

/** The order the input detectors' actions are applied in: the furthest-reaching first. */
const INPUT_ACTIONS: readonly InputGuardrailAction[] = ['tripwire', 'block', 'sanitize', 'warn'];

/** The order the output validators' actions are applied in: the furthest-reaching first. */
const OUTPUT_ACTIONS: readonly OutputGuardrailAction[] = ['tripwire', 'block', 'redact', 'warn'];

/** Default confidence threshold for tainting a session. */
export const DEFAULT_TAINT_THRESHOLD = 0.9;

/**
 * Creates coordinated guardrail hooks (input, tool result, and output) with session tainting.
 *
 * The factory wires together input detectors, output validators, and a session taint
 * tracker. The input detectors read user messages before a generate call (`prepareStep`) and
 * every tool result before the model is shown it (`validateToolResult`, COR-2103). When a
 * high-confidence detection occurs, the session becomes tainted and escalated
 * detectors/validators are added to subsequent checks.
 *
 * The tool-call validators (`tools`, COR-2104) judge each tool call before it runs
 * (`beforeToolExecution`).
 *
 * `mode: 'tripwire'` switches the input, output and tool-call guardrails to the
 * OpenAI-tripwire model: a tripped detector/validator throws a
 * `GuardrailTripwireError` (hard-halting the run) instead of substituting a
 * blocked/sanitized/redacted response. It overrides `input.action` /
 * `output.action` / `tools.action` regardless of what they were individually set to, so
 * callers don't have to set the action on each.
 *
 * A detector or validator may carry an action of its own (`{ guardrail, action }`, COR-2104),
 * which it keeps under either mode. The guardrails of each action run apart, the
 * furthest-reaching first (`tripwire`, then `block`, then `sanitize` or `redact`, then `warn`), and
 * the first that answers decides the step, so a detector set to warn never lets through what a
 * blocking one refuses.
 *
 * Returns `{ prepareStep, validateToolResult, validateResponse, beforeToolExecution }` hooks ready
 * for use in `RunOptions`, and the session's taint tracker.
 */
export function createGuardrails(options: GuardrailsOptions): GuardrailHooks {
  const { input, output, tools, taint, mode = 'validate' } = options;
  // A group's action under the mode; an entry with an action of its own keeps it (COR-2104).
  const inputActionOf = (action: InputGuardrailAction | undefined): InputGuardrailAction =>
    mode === 'tripwire' ? 'tripwire' : (action ?? 'block');
  const outputActionOf = (action: OutputGuardrailAction | undefined): OutputGuardrailAction =>
    mode === 'tripwire' ? 'tripwire' : (action ?? 'block');

  const taintThreshold = taint?.taintThreshold ?? DEFAULT_TAINT_THRESHOLD;
  const taintTracker = createSessionTaintTracker(taint);

  // Build the prepareStep hook
  const prepareStep = async (context: StepContext): Promise<void | GenerateResponse> => {
    if (!input) return;

    const onTriggered: InputGuardrailOptions['onTriggered'] = (event) => {
      // Wire taint: if confidence exceeds threshold, taint the session
      if (event.confidence >= taintThreshold) {
        taintTracker.taint({
          reason: event.detail ?? `Detection by ${event.detector}`,
          detector: event.detector,
          category: event.category,
          confidence: event.confidence,
          step: context.step,
          provenance: event.provenance,
        });
      }

      // Tell the run, so a validate-mode firing shows in its activity. A tripwire does not: the
      // halt it causes is the run's `run.tripwire` event.
      if (event.action !== 'tripwire') {
        context.reportGuardrail?.({
          guardrailName: event.detector,
          category: event.category,
          phase: 'input',
          confidence: event.confidence,
          action: event.action,
        });
      }

      // Forward to user's onTriggered if provided
      input.onTriggered?.(event);
    };

    // One guardrail per action (COR-2104), the furthest-reaching first, each with a fresh detector
    // set: the group's own action also runs the escalated detectors from taint, and answers for
    // media no detector reads. The first that answers decides the step.
    const partitions = guardrailPartitions(
      input.detectors,
      inputActionOf(input.action),
      INPUT_ACTIONS,
      taintTracker.getDetectors(),
    );
    for (const partition of partitions) {
      const hook = inputGuardrailHook(
        {
          ...input,
          detectors: partition.members,
          action: partition.action,
          getSessionTainted: () => taintTracker.isTainted(),
          onTriggered,
        },
        partition.own,
      );
      const answer = await hook(context);
      if (answer !== undefined) return answer;
    }
  };

  // Build the validateResponse hook
  const validateResponse = async (
    response: GenerateResponse,
    context: StepContext,
  ): Promise<GenerateResponse | void> => {
    const onTriggered: OutputGuardrailOptions['onTriggered'] = (event) => {
      // A validator that failed blocked the reply unjudged, and that taints as any block does
      // (COR-2300). Other output findings do not taint.
      if (event.category === 'detector-failure') {
        taintTracker.taint({
          reason: event.detail ?? `Failure of ${event.validator}`,
          detector: event.validator,
          category: event.category,
          confidence: event.confidence,
          step: context.step,
        });
      }
      if (event.action !== 'tripwire') {
        context.reportGuardrail?.({
          guardrailName: event.validator,
          category: event.category,
          phase: 'output',
          confidence: event.confidence,
          action: event.action,
        });
      }
      output?.onTriggered?.(event);
    };

    // One guardrail per action (COR-2104), the furthest-reaching first; the escalated validators
    // from taint take the group's own action. A block ends the step's checks, since what replaces
    // the response is the guardrail's own message; a redaction is checked by the rest.
    const partitions = guardrailPartitions(
      output?.validators ?? [],
      outputActionOf(output?.action),
      OUTPUT_ACTIONS,
      taintTracker.getValidators(),
    );
    let current = response;
    let replaced = false;
    for (const partition of partitions) {
      if (partition.members.length === 0) continue;
      const hook = createOutputGuardrail({
        ...output,
        validators: partition.members,
        action: partition.action,
        onTriggered,
      });
      const answer = await hook(current, context);
      if (answer === undefined) continue;
      current = answer;
      replaced = true;
      if (partition.action === 'block') break;
    }
    return replaced ? current : undefined;
  };

  // Build the validateToolResult hook: the input detectors, over what a tool answered.
  const validateToolResult: ValidateToolResultHook = async (
    result,
    context: ToolExecutionResultContext,
  ) => {
    if (!input) return;
    const onTriggered: InputGuardrailOptions['onTriggered'] = (event) => {
      // A result the guardrail refuses taints the session whatever its confidence: the tool
      // reached content a detector would not let through. A tripwire refuses the result too, and
      // on a path where the run goes on past it (a durable child wait, COR-2299) the session must
      // hold the taint. A warning taints as an input does.
      const refused =
        event.action === 'block' || event.action === 'sanitize' || event.action === 'tripwire';
      if (refused || event.confidence >= taintThreshold) {
        taintTracker.taint({
          reason: event.detail ?? `Detection by ${event.detector}`,
          detector: event.detector,
          category: event.category,
          confidence: event.confidence,
          step: context.step,
          provenance: event.provenance,
        });
      }
      if (event.action !== 'tripwire') {
        context.reportGuardrail?.({
          guardrailName: event.detector,
          category: event.category,
          phase: 'tool-result',
          confidence: event.confidence,
          action: event.action,
        });
      }
      input.onTriggered?.(event);
    };

    // One guardrail per action (COR-2104), the furthest-reaching first; the first that replaces
    // the result decides. The group's own action answers for a body no detector can decode,
    // wherever some detector reads the result.
    const partitions = guardrailPartitions(
      input.detectors,
      inputActionOf(input.action),
      INPUT_ACTIONS,
      taintTracker.getDetectors(),
    );
    const anyDetector = partitions.some((partition) => partition.members.length > 0);
    for (const partition of partitions) {
      const hook = toolResultGuardrailHook(
        {
          detectors: partition.members,
          action: partition.action,
          mode: input.mode,
          getSessionTainted: () => taintTracker.isTainted(),
          onTriggered,
        },
        partition.own && anyDetector,
      );
      const answer = await hook(result, context);
      if (answer !== undefined) return answer;
    }
    return undefined;
  };

  // Build the beforeToolExecution hook: the tool-call validators, over each call before it runs.
  const beforeToolExecution: BeforeToolExecutionHook = async (context) => {
    if (!tools || tools.validators.length === 0) return context.toolCalls;
    const hook = createToolCallGuardrail({
      ...tools,
      action: mode === 'tripwire' ? 'tripwire' : tools.action,
      getSessionTainted: () => taintTracker.isTainted(),
      onTriggered: (event) => {
        // A call the guardrail refuses taints the session, as a refused tool result does (COR-2300).
        if (event.action === 'block' || event.confidence >= taintThreshold) {
          taintTracker.taint({
            reason: event.detail ?? `Detection by ${event.validator}`,
            detector: event.validator,
            category: event.category,
            confidence: event.confidence,
            step: context.step,
          });
        }
        if (event.action !== 'tripwire') {
          context.reportGuardrail?.({
            guardrailName: event.validator,
            category: event.category,
            phase: 'tool-call',
            confidence: event.confidence,
            action: event.action,
          });
        }
        tools.onTriggered?.(event);
      },
    });
    return hook(context);
  };

  // COR-2105 — a taint is persisted by an `onTainted` that may be asynchronous. A tripwire throws
  // right after the taint, so each hook that can taint waits for the write before it returns or
  // throws, and a halt cannot outrun it.
  const settling =
    <Arguments extends unknown[], Result>(hook: (...args: Arguments) => Promise<Result>) =>
    async (...args: Arguments): Promise<Result> => {
      try {
        return await hook(...args);
      } finally {
        await taintTracker.settled();
      }
    };

  return {
    prepareStep: settling(prepareStep),
    validateToolResult: settling(validateToolResult),
    validateResponse: settling(validateResponse),
    beforeToolExecution: settling(beforeToolExecution),
    taint: taintTracker,
  };
}
