/**
 * COR-2103 — the run's input detectors, applied to what a tool answered.
 *
 * A tool's output (a fetched page, an API response) enters the conversation as a tool-result row,
 * which the input guardrail never reads: it inspects user messages. That row is how an indirect
 * prompt injection arrives, so the same detectors read it before the model is shown it.
 */
import type { JSONValue, ToolExecutionResult } from 'armorer';
import { runDetectorPipeline } from 'armorer';

import { GuardrailTripwireError } from '../errors';
import type { ValidateToolResultHook } from '../types';
import { inspectContent } from './inspectable-content';
import type { DetectorContext, GuardrailTriggeredEvent, InputDetector } from './types';

/** The `error.code` of a tool result a guardrail replaced. */
export const GUARDRAIL_BLOCKED_CODE = 'GUARDRAIL_BLOCKED';

/** Options for {@link createToolResultGuardrail}. */
export interface ToolResultGuardrailOptions {
  /** The detectors that read each piece of text the result carries. */
  detectors: InputDetector[];
  /**
   * What a detection does. `'block'` (default) and `'sanitize'` replace the result with a
   * {@link GUARDRAIL_BLOCKED_CODE} error: a tool result has no field a sanitized string could
   * stand in for without changing what the tool said, so `'sanitize'` falls back to a block.
   * `'warn'` passes the result through. `'tripwire'` throws a `GuardrailTripwireError` with phase
   * `'tool-result'`, which halts the run.
   */
  action?: ('block' | 'warn' | 'sanitize' | 'tripwire') | undefined;
  /** Called once per result a detector flagged, with provenance `'tool-result'`. */
  onTriggered?: ((event: GuardrailTriggeredEvent) => void) | undefined;
  /** Runs the detectors over a piece of text at once (`'parallel'`, default) or in order. */
  mode?: ('parallel' | 'sequential') | undefined;
  /** The session's taint state as the detectors should see it. */
  getSessionTainted?: (() => boolean) | undefined;
}

/**
 * Every piece of text a tool result shows the model: each string leaf of `content`, the text of
 * `parts` (a text part's text, and a media part's prose, locator and readable body, as the input
 * guardrail reads a user message's parts), and `error.message`.
 */
function textsOf(result: ToolExecutionResult): string[] {
  const texts: string[] = [];
  collectStrings(result.content, texts);
  if (result.parts !== undefined && result.parts.length > 0) {
    for (const field of inspectContent([...result.parts]).fields) texts.push(field.text);
  }
  const message = result.error?.message;
  if (message !== undefined && message !== '') texts.push(message);
  return texts;
}

function collectStrings(value: JSONValue | undefined, into: string[]): void {
  if (typeof value === 'string') {
    if (value !== '') into.push(value);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const entries = Array.isArray(value) ? value : Object.values(value);
  for (const entry of entries) collectStrings(entry, into);
}

/**
 * The result that stands in for one a guardrail refused: the same call, an error naming only the
 * guardrail, and nothing the tool answered — not its `content`, `parts`, raw `result`, stream, or
 * output digest. What describes the call rather than its answer (its input digest, idempotency
 * receipt, approval-binding consumption, and whether its arguments were edited) is kept, because
 * the call did run and a resumed approval or a deduplicated retry reads those.
 */
export function guardrailBlockedResult(
  result: ToolExecutionResult,
  message: string,
): ToolExecutionResult {
  return {
    callId: result.callId,
    toolCallId: result.toolCallId,
    ...(result.providerCallId === undefined ? {} : { providerCallId: result.providerCallId }),
    ...(result.inputDigest === undefined ? {} : { inputDigest: result.inputDigest }),
    ...(result.idempotency === undefined ? {} : { idempotency: result.idempotency }),
    ...(result.approvalBindingConsumed === undefined
      ? {}
      : { approvalBindingConsumed: result.approvalBindingConsumed }),
    ...(result.executedArgumentsEdited === undefined
      ? {}
      : { executedArgumentsEdited: result.executedArgumentsEdited }),
    toolName: result.toolName,
    outcome: 'error',
    content: message,
    result: undefined,
    error: { category: 'permission', message, code: GUARDRAIL_BLOCKED_CODE, retryable: false },
    errorMessage: message,
    errorCategory: 'permission',
  };
}

/** The message a refused result carries: the guardrail's name, and nothing it found. */
export function guardrailBlockedMessage(guardrailName: string): string {
  return `Tool result blocked by guardrail "${guardrailName}".`;
}

/**
 * Creates a `validateToolResult` hook that runs `detectors` over each tool result before the model
 * is shown it (see {@link ToolResultGuardrailOptions.action} for what a detection does). A result
 * whose outcome is `action_required` is a call that has not run, and is passed through unread.
 *
 * The first piece of text a detector flags decides; the rest of the result is not read further.
 * Detector errors are contained by the shared detector pipeline, as on the input side.
 */
export function createToolResultGuardrail(
  options: ToolResultGuardrailOptions,
): ValidateToolResultHook {
  const {
    detectors,
    action = 'block',
    onTriggered,
    mode = 'parallel',
    getSessionTainted,
  } = options;

  return async (result, context) => {
    // A call waiting on approval or input has not run: what it carries is the toolbox's request,
    // not a tool's answer, and replacing it would lose the pending approval.
    if (detectors.length === 0 || result.outcome === 'action_required') return;
    const detectorContext: DetectorContext = {
      step: context.step,
      conversationLength: context.conversation.getMessages().length,
      sessionTainted: getSessionTainted?.() ?? false,
      provenance: 'tool-result',
    };

    for (const text of textsOf(result)) {
      const pipeline = await runDetectorPipeline(text, detectors, detectorContext, mode);
      if (pipeline === undefined) continue;

      const event: GuardrailTriggeredEvent = {
        detector: pipeline.detectorName,
        category: pipeline.result.category,
        confidence: pipeline.result.confidence,
        action,
        input: text,
        ...(pipeline.result.detail === undefined ? {} : { detail: pipeline.result.detail }),
        provenance: 'tool-result',
      };
      onTriggered?.(event);

      if (action === 'tripwire') {
        throw new GuardrailTripwireError(
          `Tool-result guardrail tripwire: "${event.detector}" flagged the result of "${result.toolName}" (${event.category}).`,
          {
            guardrailName: event.detector,
            category: event.category,
            phase: 'tool-result',
            confidence: event.confidence,
            detail: event.detail,
          },
        );
      }
      if (action === 'warn') return;
      return guardrailBlockedResult(result, guardrailBlockedMessage(event.detector));
    }
    return;
  };
}
