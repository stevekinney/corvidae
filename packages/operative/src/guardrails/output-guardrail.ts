import { GuardrailTripwireError } from '../errors';
import type { GenerateResponse, StepContext, ValidateResponseHook } from '../types';
import type {
  OutputGuardrailOptions,
  OutputGuardrailTriggeredEvent,
  ValidationResult,
  ValidatorContext,
} from './types';

const DEFAULT_BLOCK_MESSAGE =
  'Response blocked by output guardrail: the output was flagged as a policy violation.';

/** The text a thinking part carries, which an output validator must see as it sees the answer. */
type ThinkingText = { readonly index: number; readonly text: string };

function thinkingTextsOf(response: GenerateResponse): ThinkingText[] {
  return (response.parts ?? []).flatMap((part, index) =>
    part.type === 'thinking' && part.thinking.length > 0 ? [{ index, text: part.thinking }] : [],
  );
}

type Failure = {
  /** The index of the flagged thinking part among the response's parts, or -1 for the content. */
  readonly target: number;
  readonly result: ValidationResult;
  readonly validatorName: string;
};

function highestConfidence(failures: readonly Failure[]): Failure | undefined {
  let top: Failure | undefined;
  for (const failure of failures) {
    if (!top || failure.result.confidence > top.result.confidence) top = failure;
  }
  return top;
}

/**
 * Creates an output guardrail hook that inspects model responses after each generate step.
 *
 * Validators run against the response content and against the text of each `thinking` part
 * (COR-1806): a model's reasoning reaches the run's owner and the stored conversation, so it is
 * output the guardrail owns. When a validator flags either, the configured action determines the
 * behavior:
 * - `'block'` (default): returns a new `GenerateResponse` with refusal text, whichever text was
 *   flagged. The response's parts, thinking included, are dropped with it.
 * - `'warn'`: calls `onTriggered` but passes the original response through
 * - `'redact'`: for flagged content, returns a new `GenerateResponse` with the validator's
 *   redacted content. For a response whose content is clean and whose thinking is flagged, returns
 *   the response with the flagged thinking parts removed: a thinking part carries a provider
 *   signature that must be replayed byte-for-byte, so its text cannot be edited, only withheld.
 * - `'tripwire'`: throws a `GuardrailTripwireError`, hard-halting the run right after
 *   post-processing flags the response (see `createGuardrails({ mode: 'tripwire' })`)
 *
 * Validator errors are caught via `Promise.allSettled` to prevent a broken validator
 * from crashing the agent loop. `redacted_thinking` parts carry no readable text and are not
 * scanned.
 */
export function createOutputGuardrail(options: OutputGuardrailOptions): ValidateResponseHook {
  const {
    validators,
    action = 'block',
    onTriggered,
    blockMessage = DEFAULT_BLOCK_MESSAGE,
  } = options;

  return async (
    response: GenerateResponse,
    context: StepContext,
  ): Promise<GenerateResponse | void> => {
    const output = response.content;
    const messages = context.conversation.getMessages();
    const validatorContext: ValidatorContext = {
      step: context.step,
      conversationLength: messages.length,
      toolCallCount: response.toolCalls.length,
    };

    // Run every validator over the content and over each thinking part, in parallel.
    const thoughts = thinkingTextsOf(response);
    const targets = [{ index: -1, text: output }, ...thoughts];
    const settled = await Promise.allSettled(
      targets.flatMap((target) =>
        validators.map(async (validator) => ({
          target: target.index,
          result: await validator.validate(target.text, validatorContext),
          validatorName: validator.name,
        })),
      ),
    );

    const failures = settled.flatMap((outcome) =>
      outcome.status === 'fulfilled' && !outcome.value.result.valid ? [outcome.value] : [],
    );
    const contentFailure = highestConfidence(failures.filter((failure) => failure.target === -1));
    const topFailure = highestConfidence(failures);

    if (!topFailure) return;

    const flagged =
      topFailure.target === -1
        ? output
        : (thoughts.find((t) => t.index === topFailure.target)?.text ?? output);
    const event: OutputGuardrailTriggeredEvent = {
      validator: topFailure.validatorName,
      category: topFailure.result.category,
      confidence: topFailure.result.confidence,
      action,
      output: flagged,
      detail: topFailure.result.detail,
    };

    onTriggered?.(event);

    if (action === 'tripwire') {
      throw new GuardrailTripwireError(
        `Output guardrail tripwire: "${topFailure.validatorName}" flagged the response (${topFailure.result.category}).`,
        {
          guardrailName: topFailure.validatorName,
          category: topFailure.result.category,
          phase: 'output',
          confidence: topFailure.result.confidence,
          detail: topFailure.result.detail,
        },
      );
    }

    if (action === 'warn') {
      return;
    }

    if (action === 'redact') {
      if (contentFailure?.result.redacted) {
        return {
          content: contentFailure.result.redacted,
          toolCalls: [],
        };
      }
      if (contentFailure === undefined) {
        // Only thinking was flagged: the answer and its tool calls stand, the flagged thoughts go.
        const withheld = new Set(failures.map((failure) => failure.target));
        return {
          ...response,
          parts: (response.parts ?? []).filter((_part, index) => !withheld.has(index)),
        };
      }
    }

    // Default: block (also fallback when redact has no redacted text)
    return {
      content: blockMessage,
      toolCalls: [],
    };
  };
}
