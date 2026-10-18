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
import { isMediaContent, mimeTypeFitsModality, parseDataUrl } from 'conversationalist';

import { createCatalogMediaCostEstimator, sourceByteLength } from './context/media-cost';
import type { MediaCostEstimator, MediaCostOutcome, UnadmittedMediaCost } from './context/types';
import { MediaAdmissionError } from './errors';
import { RunErrorEvent } from './events';
import { readBackendDescriptors } from './providers/backend-descriptor-attachment';
import type { BackendDescriptor } from './providers/model-catalog';
import { type InputMediaRequirement, locateInputMedia } from './providers/selection';
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

/**
 * Refuses the parts past a backend's per-request cap on a modality. Counted in
 * conversation order across every located part, against the smallest cap among
 * the backends that accept the modality (the run may be served by any of them).
 */
function overCountParts(
  located: readonly LocatedMedia[],
  descriptors: readonly BackendDescriptor[],
): Map<string, UnadmittedMediaCost> {
  const refusals = new Map<string, UnadmittedMediaCost>();
  const seen = new Map<MediaContent['type'], number>();
  for (const { part, messageId, partIndex } of located) {
    const caps = descriptors
      .filter((descriptor) => descriptor.modalities[part.type].input)
      .flatMap((descriptor) =>
        descriptor.mediaCounts
          .filter((count) => count.modality === part.type)
          .map((count) => count.maxPerRequest),
      );
    const count = (seen.get(part.type) ?? 0) + 1;
    seen.set(part.type, count);
    if (caps.length > 0 && count > Math.min(...caps)) {
      refusals.set(`${messageId}:${partIndex}`, {
        messageId,
        partIndex,
        modality: part.type,
        outcome: 'unsupported',
        reason: 'media-count-exceeded',
      });
    }
  }
  return refusals;
}

/**
 * Refuses the parts past a backend's aggregate byte limit on a modality. The
 * bytes of every located part whose size is known (a resolved source counts as
 * its resolved bytes) are summed in conversation order, against the smallest
 * aggregate cap among the backends that accept the modality. A part of unknown
 * size adds nothing, so only declared sizes can trip the limit.
 */
function overAggregateParts(
  located: readonly LocatedMedia[],
  descriptors: readonly BackendDescriptor[],
  resolved: ReadonlyMap<string, ResolvedMediaSource>,
): Map<string, UnadmittedMediaCost> {
  const refusals = new Map<string, UnadmittedMediaCost>();
  const totals = new Map<MediaContent['type'], number>();
  for (const { part, messageId, partIndex } of located) {
    const key = `${messageId}:${partIndex}`;
    const entry = resolved.get(key);
    const byteLength = entry?.byteLength ?? sourceByteLength(entry?.source ?? part.source);
    if (byteLength === undefined) continue;
    const total = (totals.get(part.type) ?? 0) + byteLength;
    totals.set(part.type, total);
    const caps = descriptors
      .filter((descriptor) => descriptor.modalities[part.type].input)
      .flatMap((descriptor) =>
        descriptor.mediaLimits.flatMap((limit) =>
          limit.modality === part.type &&
          limit.scope === 'aggregate' &&
          limit.maxBytes !== undefined
            ? [limit.maxBytes]
            : [],
        ),
      );
    if (caps.length > 0 && total > Math.min(...caps)) {
      refusals.set(key, {
        messageId,
        partIndex,
        modality: part.type,
        outcome: 'unbounded',
        reason: 'media-limit-exceeded',
      });
    }
  }
  return refusals;
}

/**
 * The media requirements of a step's conversation, for backend selection: one per
 * media part, in order, described by the source each part takes once the run's
 * resolver has projected it (a managed asset is judged as the inline bytes or the
 * provider-fetched URL it resolves to, with the resolver's media type and size).
 * `undefined` when the conversation carries no media, which leaves the selection
 * request exactly as it was before media existed.
 */
export function describeStepInputMedia(
  conversation: Conversation,
  resolvedSources: ResolvedMediaSources | undefined,
): readonly InputMediaRequirement[] | undefined {
  const requirements = locateInputMedia(conversation, resolvedSources).map(
    ({ requirement }) => requirement,
  );
  return requirements.length === 0 ? undefined : requirements;
}

/** The media type a data URL's header declares, if the source is one. */
function dataUrlMimeType(source: ContentSource): string | undefined {
  return source.kind === 'data-url' ? parseDataUrl(source.url)?.mimeType : undefined;
}

/** A stable fingerprint of every media part and where it sits, to notice a change. */
export function mediaFingerprint(conversation: Conversation): string {
  return JSON.stringify(
    locateMedia(conversation).map(({ part, messageId, partIndex }) => [messageId, partIndex, part]),
  );
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
  // A media type that comes from outside the schema's reach (a data URL's own header,
  // or what a resolver reported) must fit the part's modality as a declared one does.
  for (const { part, messageId, partIndex } of located) {
    const key = `${messageId}:${partIndex}`;
    if (unavailable.has(key)) continue;
    const entry = resolved.get(key);
    const declared = [
      entry?.mimeType,
      dataUrlMimeType(part.source),
      entry === undefined ? undefined : dataUrlMimeType(entry.source),
    ];
    if (
      declared.some(
        (mimeType) => mimeType !== undefined && !mimeTypeFitsModality(part.type, mimeType),
      )
    ) {
      resolved.delete(key);
      unavailable.set(key, {
        messageId,
        partIndex,
        modality: part.type,
        outcome: 'unsupported',
        reason: 'mime-type-mismatch',
      });
    }
  }
  const resolvedSources: ResolvedMediaSources | undefined =
    resolved.size > 0 ? resolved : undefined;

  const estimate =
    deps.mediaCostEstimator ?? createCatalogMediaCostEstimator(descriptors, { resolvedSources });
  const countRefusals = overCountParts(located, descriptors);
  const aggregateRefusals = overAggregateParts(located, descriptors, resolved);
  const outcomes: MediaCostOutcome[] = located.map(({ part, messageId, partIndex }) => {
    const key = `${messageId}:${partIndex}`;
    return (
      unavailable.get(key) ??
      countRefusals.get(key) ??
      aggregateRefusals.get(key) ??
      estimate(part, { messageId, partIndex })
    );
  });

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

/**
 * Admission's safety verdict for the media a step will send (COR-716), applied to
 * every media part in the conversation, in every message, on every path: a
 * `flagged` asset is always refused, and an `unknown` one when the run's
 * `assetSafety` policy is `'block'`. It reads the resolutions admission produced,
 * not a guardrail's verdict, so it holds with no input guardrail, with one in
 * `warn` mode, and for assets that arrived in an earlier turn or from a
 * `beforeGenerate` handler. Returns the failing step outcome, or `undefined`.
 */
export function refuseUnsafeMedia(input: {
  readonly deps: StepDeps;
  readonly conversation: Conversation;
  readonly resolvedSources: ResolvedMediaSources | undefined;
  readonly step: number;
  readonly emitter: EventDispatcher | undefined;
}): StepOutcome | undefined {
  const { deps, conversation, resolvedSources, step, emitter } = input;
  if (resolvedSources === undefined) return undefined;
  const blockUnknown = deps.assetSafety?.unknown === 'block';
  const refused: UnadmittedMediaCost[] = [];
  for (const { part, messageId, partIndex } of locateMedia(conversation)) {
    const resolved = resolvedSources.get(`${messageId}:${partIndex}`);
    if (resolved === undefined) continue;
    const flagged = resolved.safety === 'flagged';
    const unverified = resolved.safety === 'unknown' && blockUnknown;
    if (!flagged && !unverified) continue;
    refused.push({
      messageId,
      partIndex,
      modality: part.type,
      outcome: 'unsupported',
      reason: flagged ? 'asset-flagged' : 'asset-unverified',
    });
  }
  if (refused.length === 0) return undefined;
  const error = new MediaAdmissionError(refused);
  emitter?.dispatch(new RunErrorEvent(step, error, 'policy'));
  return { kind: 'error', error, errorKind: 'policy' };
}
