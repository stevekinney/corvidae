import type {
  GenerateResponse,
  StepContext,
  ToolExecutionResultContext,
  ValidateToolResultHook,
} from '../types';
import { createInputGuardrail } from './input-guardrail';
import { createOutputGuardrail } from './output-guardrail';
import { createSessionTaintTracker } from './session-taint';
import { createToolResultGuardrail } from './tool-result-guardrail';
import type { GuardrailHooks, GuardrailsOptions } from './types';

/** Default confidence threshold for tainting a session. */
const DEFAULT_TAINT_THRESHOLD = 0.9;

/**
 * Creates coordinated guardrail hooks (input, tool result, and output) with session tainting.
 *
 * The factory wires together input detectors, output validators, and a session taint
 * tracker. The input detectors read user messages before a generate call (`prepareStep`) and
 * every tool result before the model is shown it (`validateToolResult`, COR-2103). When a
 * high-confidence detection occurs, the session becomes tainted and escalated
 * detectors/validators are added to subsequent checks.
 *
 * `mode: 'tripwire'` switches both input and output guardrails to the
 * OpenAI-tripwire model: a tripped detector/validator throws a
 * `GuardrailTripwireError` (hard-halting the run) instead of substituting a
 * blocked/sanitized/redacted response. It overrides `input.action` /
 * `output.action` regardless of what they were individually set to, so
 * callers don't have to set the action on both.
 *
 * Returns `{ prepareStep, validateToolResult, validateResponse }` hooks ready for use in
 * `RunOptions`, and the session's taint tracker.
 */
export function createGuardrails(options: GuardrailsOptions): GuardrailHooks {
  const { input, output, taint, mode = 'validate' } = options;

  const taintThreshold = taint?.taintThreshold ?? DEFAULT_TAINT_THRESHOLD;
  const taintTracker = createSessionTaintTracker(taint);

  // Build the prepareStep hook
  const prepareStep = async (context: StepContext): Promise<void | GenerateResponse> => {
    if (!input) return;

    // Merge base detectors with any escalated detectors from taint
    const activeDetectors = [...input.detectors, ...taintTracker.getDetectors()];

    // Create a fresh guardrail with the current detector set (includes escalated if tainted)
    const hook = createInputGuardrail({
      ...input,
      detectors: activeDetectors,
      action: mode === 'tripwire' ? 'tripwire' : input.action,
      getSessionTainted: () => taintTracker.isTainted(),
      onTriggered: (event) => {
        // Wire taint: if confidence exceeds threshold, taint the session
        if (event.confidence >= taintThreshold) {
          taintTracker.taint({
            reason: event.detail ?? `Detection by ${event.detector}`,
            detector: event.detector,
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
      },
    });

    return hook(context);
  };

  // Build the validateResponse hook
  const validateResponse = async (
    response: GenerateResponse,
    context: StepContext,
  ): Promise<GenerateResponse | void> => {
    // Merge base validators with any escalated validators from taint
    const baseValidators = output?.validators ?? [];
    const activeValidators = [...baseValidators, ...taintTracker.getValidators()];

    if (activeValidators.length === 0) return;

    const hook = createOutputGuardrail({
      ...output,
      validators: activeValidators,
      action: mode === 'tripwire' ? 'tripwire' : output?.action,
      onTriggered: (event) => {
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
      },
    });

    return hook(response, context);
  };

  // Build the validateToolResult hook: the input detectors, over what a tool answered.
  const validateToolResult: ValidateToolResultHook = async (
    result,
    context: ToolExecutionResultContext,
  ) => {
    if (!input) return;
    const action = mode === 'tripwire' ? 'tripwire' : (input.action ?? 'block');
    const hook = createToolResultGuardrail({
      detectors: [...input.detectors, ...taintTracker.getDetectors()],
      action,
      mode: input.mode,
      getSessionTainted: () => taintTracker.isTainted(),
      onTriggered: (event) => {
        // A result the guardrail refuses taints the session whatever its confidence: the tool
        // reached content a detector would not let through. A warning taints as an input does.
        const refused = event.action === 'block' || event.action === 'sanitize';
        if (refused || event.confidence >= taintThreshold) {
          taintTracker.taint({
            reason: event.detail ?? `Detection by ${event.detector}`,
            detector: event.detector,
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
      },
    });
    return hook(result, context);
  };

  return { prepareStep, validateToolResult, validateResponse, taint: taintTracker };
}
