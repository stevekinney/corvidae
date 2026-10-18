/**
 * Per-step media admission (COR-716).
 *
 * Before a step reaches the input guardrail, context assembly, or the provider,
 * every media part in the conversation is resolved and costed:
 *
 * 1. A part whose source kind no provider lists (a managed asset, an upload, a
 *    local file, an MCP resource, an A2A reference) is projected through the
 *    run's `ContentSourceResolver`. The stored message keeps the original
 *    source; the projection travels beside it in `resolvedSources`.
 * 2. Each part is costed by the run's `MediaCostEstimator`, which defaults to a
 *    catalog estimator built from the descriptors the `generate` function
 *    carries.
 * 3. Any part that is not `estimated` fails the step with a
 *    {@link MediaAdmissionError}, before any provider call.
 *
 * A conversation with no media part skips all of it.
 */
import type {
  ContentSource,
  Conversation,
  MediaContent,
  ResolvedMediaSource,
  ResolvedMediaSources,
} from 'conversationalist';
import { isMediaContent } from 'conversationalist';

import { createCatalogMediaCostEstimator } from './context/media-cost';
import type { MediaCostEstimator, MediaCostOutcome, UnadmittedMediaCost } from './context/types';
import { MediaAdmissionError } from './errors';
import { RunErrorEvent } from './events';
import { readBackendDescriptors } from './providers/backend-descriptor-attachment';
import type { EventDispatcher, StepDeps, StepOutcome } from './run-step';

/** The source kinds a provider adapter can carry without a resolver. */
const WIRE_SOURCE_KINDS: ReadonlySet<ContentSource['kind']> = new Set([
  'inline',
  'data-url',
  'remote-url',
  'provider-file',
]);

export interface StepMedia {
  /** Resolved sources, keyed `${messageId}:${partIndex}`; `undefined` when none were needed. */
  readonly resolvedSources: ResolvedMediaSources | undefined;
  /** Tokens the conversation's media parts cost this step. */
  readonly mediaTokens: number;
  /** The estimator costing this step's parts, reusable by the context assembler. */
  readonly estimate: MediaCostEstimator;
}

interface LocatedMedia {
  readonly part: MediaContent;
  readonly messageId: string;
  readonly partIndex: number;
}

function locateMedia(conversation: Conversation): LocatedMedia[] {
  const located: LocatedMedia[] = [];
  for (const message of conversation.getMessages()) {
    if (message.hidden || typeof message.content === 'string') continue;
    message.content.forEach((part, partIndex) => {
      if (isMediaContent(part)) located.push({ part, messageId: message.id, partIndex });
    });
  }
  return located;
}

/** Whether `conversation` holds any media part a step must admit. */
export function conversationHasMedia(conversation: Conversation): boolean {
  return locateMedia(conversation).length > 0;
}

/**
 * Resolves and costs the step's media. Returns the {@link StepMedia}, or a
 * `StepOutcome` of kind `error` when any part cannot be admitted.
 */
export async function admitStepMedia(input: {
  readonly deps: StepDeps;
  readonly conversation: Conversation;
  readonly step: number;
  readonly emitter: EventDispatcher | undefined;
}): Promise<StepMedia | StepOutcome> {
  const { deps, conversation, step, emitter } = input;
  const located = locateMedia(conversation);
  const descriptors = readBackendDescriptors(deps.generate);

  if (located.length === 0) {
    return {
      resolvedSources: undefined,
      mediaTokens: 0,
      estimate: deps.mediaCostEstimator ?? createCatalogMediaCostEstimator(descriptors),
    };
  }

  const resolved = new Map<string, ResolvedMediaSource>();
  const unavailable = new Map<string, UnadmittedMediaCost>();
  if (deps.contentSourceResolver !== undefined) {
    for (const { part, messageId, partIndex } of located) {
      if (WIRE_SOURCE_KINDS.has(part.source.kind)) continue;
      let result: Awaited<ReturnType<typeof deps.contentSourceResolver>>;
      try {
        result = await deps.contentSourceResolver(part, { messageId, partIndex });
      } catch (error) {
        emitter?.dispatch(new RunErrorEvent(step, error, 'policy'));
        return { kind: 'error', error, errorKind: 'policy' };
      }
      const key = `${messageId}:${partIndex}`;
      if (result.outcome === 'resolved') {
        resolved.set(key, result);
      } else {
        unavailable.set(key, {
          messageId,
          partIndex,
          modality: part.type,
          outcome: 'unsupported',
          reason: 'source-form-not-accepted',
        });
      }
    }
  }
  const resolvedSources: ResolvedMediaSources | undefined =
    resolved.size > 0 ? resolved : undefined;

  const estimate =
    deps.mediaCostEstimator ?? createCatalogMediaCostEstimator(descriptors, { resolvedSources });
  const outcomes: MediaCostOutcome[] = located.map(
    ({ part, messageId, partIndex }) =>
      unavailable.get(`${messageId}:${partIndex}`) ?? estimate(part, { messageId, partIndex }),
  );

  const refused = outcomes.filter(
    (outcome): outcome is UnadmittedMediaCost => outcome.outcome !== 'estimated',
  );
  if (refused.length > 0) {
    const error = new MediaAdmissionError(refused);
    emitter?.dispatch(new RunErrorEvent(step, error, 'policy'));
    return { kind: 'error', error, errorKind: 'policy' };
  }
  const mediaTokens = outcomes.reduce(
    (sum, outcome) => sum + (outcome.outcome === 'estimated' ? outcome.tokens : 0),
    0,
  );
  return { resolvedSources, mediaTokens, estimate };
}
