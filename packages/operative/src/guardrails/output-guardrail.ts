import type { Message } from 'conversationalist';

import { GuardrailTripwireError } from '../errors';
import type { GenerateResponse, StepContext, ValidateResponseHook } from '../types';
import { inspectContent } from './inspectable-content';
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

/** The text of one value a tool returned: a string as it is, anything else as its JSON. */
function jsonText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

/**
 * Every piece of text the model reads from `message`: its content, the media bodies the step
 * resolved for it (`resolvedSources`, keyed `<message id>:<part index>`, as the input guardrail
 * reads them), and, for a tool-result message, whose `content` is empty, the result's own
 * `content` value and `parts`.
 */
function messageTexts(message: Message, resolvedSources: StepContext['resolvedSources']): string[] {
  const resolvedFor = (partIndex: number) => resolvedSources?.get(`${message.id}:${partIndex}`);
  const texts = inspectContent(message.content, resolvedFor).fields.map((field) => field.text);
  const { toolResult } = message;
  if (toolResult !== undefined) {
    if (toolResult.content !== null && toolResult.content !== undefined) {
      texts.push(jsonText(toolResult.content));
    }
    if (toolResult.parts !== undefined) {
      texts.push(
        ...inspectContent([...toolResult.parts], resolvedFor).fields.map((field) => field.text),
      );
    }
  }
  return texts;
}

/**
 * The conversation's text as a validator reads it, built once and only when asked for. The
 * messages are the ones the step started with, so a later append does not change what it reads.
 */
function conversationTextReader(
  messages: ReadonlyArray<Message>,
  resolvedSources: StepContext['resolvedSources'],
): () => string {
  let text: string | undefined;
  return () =>
    (text ??= messages.flatMap((message) => messageTexts(message, resolvedSources)).join('\n'));
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
 *   redacted content. For a response whose content is clean and whose thinking is flagged, the
 *   flagged thinking is withheld, never edited: a thinking part carries a provider signature, so
 *   its text cannot change. A step with no tool calls returns the response with the flagged
 *   thinking parts removed. A step with tool calls keeps every part unchanged and names the
 *   flagged ones in `withheldThinking`, because a provider such as Anthropic requires a tool-use
 *   turn's thinking back complete and unmodified on the request that carries the tool results.
 *   That thinking stays in the stored conversation, where only the model reads it again, and a
 *   surface that shows the run's reasoning (Bureau's AG-UI stream) leaves it out.
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
      conversationText: conversationTextReader([...messages], context.resolvedSources),
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
        const withheld = new Set([
          ...(response.withheldThinking ?? []),
          ...failures.map((failure) => failure.target),
        ]);
        if (response.toolCalls.length > 0) {
          // The next request replays this turn's thinking byte-for-byte, so the parts stay and
          // only the observers are told to leave the flagged ones out.
          return { ...response, withheldThinking: [...withheld].toSorted((a, b) => a - b) };
        }
        return {
          ...response,
          parts: (response.parts ?? []).filter((_part, index) => !withheld.has(index)),
          withheldThinking: undefined,
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
