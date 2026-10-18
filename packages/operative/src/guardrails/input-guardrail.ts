import { runDetectorPipeline } from 'armorer';
import type { MultiModalContent } from 'conversationalist';
import { isMediaContent } from 'conversationalist';

import { GuardrailTripwireError } from '../errors';
import type { GenerateResponse, PrepareStepHook, StepContext } from '../types';
import { inspectContent, type InspectableField } from './inspectable-content';
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

/**
 * Creates an input guardrail hook that inspects user messages before each generate step.
 *
 * Detectors run against the last user message. When a detector triggers, the configured
 * action determines the behavior:
 * - `'block'` (default): returns a `GenerateResponse` with refusal text, short-circuiting generate
 * - `'warn'`: calls `onTriggered` but allows the request through
 * - `'sanitize'`: replaces the last user message with the detector's sanitized version
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
    const lastUserPosition = messages.findLastIndex((message) => message.role === 'user');
    const lastUser = lastUserPosition === -1 ? undefined : messages[lastUserPosition];
    if (!lastUser) return;

    const inspectable = inspectContent(lastUser.content, (partIndex) =>
      context.resolvedSources?.get(`${lastUser.id}:${partIndex}`),
    );
    const assetFindings = findUnsafeAssets(
      context,
      lastUser.id,
      lastUser.content,
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
    if (inspectable.fields.length === 0 && assetFindings.length === 0) return;

    const detectorContext: DetectorContext = {
      step: context.step,
      conversationLength: messages.length,
      sessionTainted: getSessionTainted?.() ?? false,
      provenance: 'user-input',
    };

    // Every field is its own detector input, so a flagged caption is found
    // whatever the rest of the message says, and a media part with no plain
    // string is still inspected through the prose and URL it carries.
    const triggered: Array<{
      index: number;
      pipeline: NonNullable<Awaited<ReturnType<typeof runDetectorPipeline>>>;
    }> = [];
    for (const [index, field] of inspectable.fields.entries()) {
      const pipeline = await runDetectorPipeline(field.text, detectors, detectorContext, mode);
      if (pipeline) triggered.push({ index, pipeline });
    }

    const topFinding = triggered[0] ?? undefined;
    if (!topFinding && assetFindings.length === 0) return;

    const event: GuardrailTriggeredEvent = topFinding
      ? {
          detector: topFinding.pipeline.detectorName,
          category: topFinding.pipeline.result.category,
          confidence: topFinding.pipeline.result.confidence,
          action,
          input: inspectable.fields[topFinding.index]!.text,
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
      const replacements = new Map<number, string>();
      let sanitizable = triggered.length > 0;
      for (const { index, pipeline } of triggered) {
        const field: InspectableField = inspectable.fields[index]!;
        const sanitized = pipeline.result.sanitized;
        if (sanitized === undefined || !field.replaceable) {
          sanitizable = false;
          break;
        }
        replacements.set(index, sanitized);
      }
      if (sanitizable) {
        // Replace the user message in place, keeping every part the detector did
        // not flag: media is never collapsed to the sanitized prose.
        const rebuilt = inspectable.rebuild(replacements);
        if (typeof rebuilt === 'string') {
          context.conversation.redactMessageAtPosition(lastUserPosition, rebuilt);
        } else {
          context.conversation.redactMessageAtPosition(lastUserPosition, { content: rebuilt });
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
