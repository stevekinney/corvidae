import { runDetectorPipeline } from 'armorer';
import type { Message, MultiModalContent } from 'conversationalist';
import { isMediaContent } from 'conversationalist';

import { GuardrailTripwireError } from '../errors';
import type { GenerateResponse, PrepareStepHook, StepContext } from '../types';
import {
  inspectContent,
  type InspectableContent,
  type InspectableField,
} from './inspectable-content';
import type { DetectorContext, GuardrailTriggeredEvent, InputGuardrailOptions } from './types';

/**
 * Creates a refusal response that short-circuits the generate call.
 */
function createBlockResponse(): GenerateResponse {
  return {
    content: 'Request blocked by input guardrail: the input was flagged as a policy violation.',
    toolCalls: [],
  };
}

/** One user message the guardrail inspects this step, with what it found in it. */
interface InspectedMessage {
  /** The message's index in `conversation.getMessages()`, for redaction. */
  readonly position: number;
  readonly inspectable: InspectableContent;
  readonly assetFindings: AssetFinding[];
  /** Detector hits, by field index. */
  readonly triggered: Array<{
    index: number;
    pipeline: NonNullable<Awaited<ReturnType<typeof runDetectorPipeline>>>;
  }>;
}

/**
 * The user messages appended since the previous generation: every user message
 * after the last assistant message. Several session inputs can land at one step
 * boundary (COR-1476), and each is uninspected input until a generation answers
 * it, so inspecting only the last would let the earlier ones through.
 */
function userMessagesSinceLastGeneration(
  messages: ReadonlyArray<Message>,
): Array<{ readonly message: Message; readonly position: number }> {
  const lastAssistant = messages.findLastIndex((message) => message.role === 'assistant');
  return messages.flatMap((message, position) =>
    position > lastAssistant && message.role === 'user' ? [{ message, position }] : [],
  );
}

/**
 * Creates an input guardrail hook that inspects user messages before each generate step.
 *
 * Detectors run against every user message appended since the previous generation
 * (all user messages after the last assistant message), field by field. When a
 * detector triggers, the configured action determines the behavior:
 * - `'block'` (default): returns a `GenerateResponse` with refusal text, short-circuiting generate
 * - `'warn'`: calls `onTriggered` but allows the request through
 * - `'sanitize'`: replaces each flagged user message with the detector's sanitized version
 * - `'tripwire'`: throws a `GuardrailTripwireError`, hard-halting the run before the
 *   generate call fires (see `createGuardrails({ mode: 'tripwire' })`)
 *
 * Detector errors are caught via `Promise.allSettled` to prevent a broken detector
 * from crashing the agent loop.
 */
export function createInputGuardrail(options: InputGuardrailOptions): PrepareStepHook {
  const {
    detectors,
    action = 'block',
    onTriggered,
    mode = 'parallel',
    getSessionTainted,
    assetSafety,
  } = options;
  const unverifiedAssets = assetSafety?.unknown ?? 'allow';

  return async (context: StepContext): Promise<void | GenerateResponse> => {
    const messages = context.conversation.getMessages();
    const newUserMessages = userMessagesSinceLastGeneration(messages);
    if (newUserMessages.length === 0) return;

    const detectorContext: DetectorContext = {
      step: context.step,
      conversationLength: messages.length,
      sessionTainted: getSessionTainted?.() ?? false,
      provenance: 'user-input',
    };

    const inspected: InspectedMessage[] = [];
    for (const { message, position } of newUserMessages) {
      const inspectable = inspectContent(message.content, (partIndex) =>
        context.resolvedSources?.get(`${message.id}:${partIndex}`),
      );
      const assetFindings = findUnsafeAssets(
        context,
        message.id,
        message.content,
        unverifiedAssets,
      );
      const undecodable = inspectable.uninspectable.map((body): AssetFinding => ({
        blocking: true,
        event: (eventAction, provenance) => ({
          detector: 'content-body',
          category: 'uninspectable-content',
          confidence: 1,
          action: eventAction,
          input: body.label,
          detail: `A provider would read this media part as text, but it cannot be decoded: ${body.reason}.`,
          provenance,
        }),
      }));
      assetFindings.push(...undecodable);

      // Every field is its own detector input, so a flagged caption is found
      // whatever the rest of the message says, and a media part with no plain
      // string is still inspected through the prose and URL it carries.
      const triggered: InspectedMessage['triggered'] = [];
      for (const [index, field] of inspectable.fields.entries()) {
        const pipeline = await runDetectorPipeline(field.text, detectors, detectorContext, mode);
        if (pipeline) triggered.push({ index, pipeline });
      }
      inspected.push({ position, inspectable, assetFindings, triggered });
    }

    const assetFindings = inspected.flatMap((entry) => entry.assetFindings);
    const firstHit = inspected.find((entry) => entry.triggered.length > 0);
    const topFinding = firstHit?.triggered[0];
    if (topFinding === undefined && assetFindings.length === 0) return;

    const event: GuardrailTriggeredEvent =
      topFinding !== undefined && firstHit !== undefined
        ? {
            detector: topFinding.pipeline.detectorName,
            category: topFinding.pipeline.result.category,
            confidence: topFinding.pipeline.result.confidence,
            action,
            input: firstHit.inspectable.fields[topFinding.index]!.text,
            ...(topFinding.pipeline.result.detail === undefined
              ? {}
              : { detail: topFinding.pipeline.result.detail }),
            provenance: detectorContext.provenance,
          }
        : assetFindings[0]!.event(action, detectorContext.provenance);

    onTriggered?.(event);

    if (action === 'tripwire') {
      throw new GuardrailTripwireError(
        `Input guardrail tripwire: "${event.detector}" flagged the request (${event.category}).`,
        {
          guardrailName: event.detector,
          category: event.category,
          phase: 'input',
          confidence: event.confidence,
          detail: event.detail,
        },
      );
    }

    // Text no detector could read is refused whatever the action: warning about
    // it would send a provider content nothing inspected.
    if (action === 'warn' && !assetFindings.some((finding) => finding.blocking)) {
      return;
    }

    // An asset the safety gate flagged has no sanitized form: sanitizing
    // cannot make the bytes safe, so it falls through to a block.
    if (action === 'sanitize' && assetFindings.length === 0) {
      const rewrites: Array<{ position: number; replacements: Map<number, string> }> = [];
      let sanitizable = true;
      for (const entry of inspected) {
        if (entry.triggered.length === 0) continue;
        const replacements = new Map<number, string>();
        for (const { index, pipeline } of entry.triggered) {
          const field: InspectableField = entry.inspectable.fields[index]!;
          const sanitized = pipeline.result.sanitized;
          if (sanitized === undefined || !field.replaceable) {
            sanitizable = false;
            break;
          }
          replacements.set(index, sanitized);
        }
        if (!sanitizable) break;
        rewrites.push({ position: entry.position, replacements });
      }
      if (sanitizable) {
        // Replace each flagged user message in place, keeping every part the
        // detector did not flag: media is never collapsed to the sanitized prose.
        for (const { position, replacements } of rewrites) {
          const entry = inspected.find((candidate) => candidate.position === position)!;
          const rebuilt = entry.inspectable.rebuild(replacements);
          if (typeof rebuilt === 'string') {
            context.conversation.redactMessageAtPosition(position, rebuilt);
          } else {
            context.conversation.redactMessageAtPosition(position, { content: rebuilt });
          }
        }
        return;
      }
    }

    // Default: block (also fallback when sanitize has no sanitized text)
    return createBlockResponse();
  };
}

/** A media part the asset-safety policy refuses, described as a guardrail event. */
interface AssetFinding {
  /** Refused even when the guardrail's action is `warn`. */
  readonly blocking?: boolean;
  event(
    action: GuardrailTriggeredEvent['action'],
    provenance: GuardrailTriggeredEvent['provenance'],
  ): GuardrailTriggeredEvent;
}

function findUnsafeAssets(
  context: StepContext,
  messageId: string,
  content: string | ReadonlyArray<MultiModalContent>,
  unverifiedAssets: 'allow' | 'block',
): AssetFinding[] {
  if (typeof content === 'string' || context.resolvedSources === undefined) return [];
  const findings: AssetFinding[] = [];
  content.forEach((part, partIndex) => {
    if (!isMediaContent(part)) return;
    const resolved = context.resolvedSources?.get(`${messageId}:${partIndex}`);
    if (resolved === undefined) return;
    const flagged = resolved.safety === 'flagged';
    const unverified = resolved.safety === 'unknown' && unverifiedAssets === 'block';
    if (!flagged && !unverified) return;
    findings.push({
      event: (action, provenance) => ({
        detector: 'asset-safety',
        category: flagged ? 'unsafe-asset' : 'unverified-asset',
        confidence: 1,
        action,
        input: `${part.type} part ${partIndex}`,
        detail: flagged
          ? 'The asset safety gate flagged this media part.'
          : 'No safety verdict exists for this media part and the policy refuses unverified assets.',
        provenance,
      }),
    });
  });
  return findings;
}
