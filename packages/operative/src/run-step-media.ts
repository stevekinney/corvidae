/**
 * Per-step media admission (COR-716).
 *
 * The invariant: every `GenerateContext` handed to the run's `generate` carries
 * a `resolvedSources` that {@link StepMediaAdmission.admit} derived from that
 * context's own conversation, immediately before the call, against the backends
 * the call can reach. A derivation is never carried across a mutation: a
 * `prepareStep` hook, a `beforeGenerate` handler, a retry mutator, and the
 * `onMaximumSteps` tail each get a fresh derivation for the conversation they
 * leave behind, so no site needs its own fingerprint of what admission saw.
 *
 * One derivation does, in order:
 *
 * 1. **Resolve.** A part whose source kind no provider lists (a managed asset,
 *    an upload, a local file, an MCP resource, an A2A reference) is projected
 *    through the run's `ContentSourceResolver`; with no resolver it is
 *    unavailable, whatever the estimator would say. The stored message keeps
 *    the original source; the projection travels beside it in
 *    `resolvedSources`. A resolution is memoized per part for the step, so the
 *    preview the input guardrail inspected and the binding derivation before
 *    the call see the same bytes and the same safety verdict, and an unchanged
 *    conversation costs no resolver call.
 * 2. **Fit.** A media type from a data URL or the resolver must fit the part's
 *    modality, as a declared one must at the schema.
 * 3. **Verdict.** Admission owns the safety verdict for every resolved part: a
 *    `flagged` asset is always refused, an `unknown` one when `assetSafety.unknown`
 *    is `'block'`. It holds with no input guardrail, with one that only warns,
 *    and for an asset that arrived in an earlier turn.
 * 4. **Backends.** Each reachable backend is judged on the whole request with
 *    `evaluateInputMedia`, the evaluator selection uses. The request is admitted
 *    when at least one backend takes every part; dispatch (routing, fallover,
 *    fallback) is then limited to those backends, through `generateAdmitsMedia`.
 *    When the generate function's descriptor union is incomplete (a dispatcher
 *    keeps a candidate with no descriptor), the described rows do not say what
 *    every reachable backend takes, so admission refuses nothing on eligibility
 *    grounds and leaves that to dispatch.
 * 5. **Cost.** Each part is costed by the run's `MediaCostEstimator`, which
 *    defaults to the catalog estimator over the admitting backends. Under an
 *    incomplete union with no custom estimator, a part the described rows
 *    cannot price is `no-estimator`: nothing can cost it.
 *
 * Any part that is not `estimated` fails the step with a
 * {@link MediaAdmissionError}, before any provider call. A conversation with no
 * media part skips all of it.
 *
 * Two mutation sites sit outside what a derivation can cover, by design:
 * a background compaction can publish a compacted history between the
 * derivation and the call (COR-808), which is safe because it only removes
 * messages and keeps their ids, so a stale map is a superset of what the
 * adapter substitutes; and a provider's own `pinnedMessages` are host
 * configuration assembled inside the provider, never user input, so they do not
 * pass admission.
 */
import type {
  ContentSource,
  Conversation,
  MediaContent,
  ResolvedMediaSource,
  ResolvedMediaSources,
} from 'conversationalist';
import { messageMediaParts, mimeTypeFitsModality, parseDataUrl } from 'conversationalist';

import { createCatalogMediaCostEstimator, sourceByteLength } from './context/media-cost';
import type { MediaCostEstimator, MediaCostOutcome, UnadmittedMediaCost } from './context/types';
import { MediaAdmissionError } from './errors';
import { RunErrorEvent } from './events';
import {
  isDescriptorUnionIncomplete,
  readBackendDescriptors,
} from './providers/backend-descriptor-attachment';
import type { BackendDescriptor } from './providers/model-catalog';
import {
  evaluateInputMedia,
  type InputMediaRequirement,
  locateInputMedia,
} from './providers/selection';
import type { EventDispatcher, StepDeps, StepOutcome } from './run-step';
import { explicitAbortReason } from './run-step-utilities';

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

/**
 * The step outcome a failed derivation becomes: an error, or an abort when the run
 * was cancelled while its media resolved. Never a skip.
 */
export type MediaRefusal = Extract<StepOutcome, { kind: 'error' | 'abort' }>;

/**
 * One step's admission. `derive` and `admit` compute the same thing; `derive`
 * throws (for a caller inside a `try` that already reports errors), `admit`
 * dispatches the `run.error` event and returns the step outcome.
 */
export interface StepMediaAdmission {
  /** Derives the media admission for `conversation` as it is now; throws on refusal. */
  derive(conversation: Conversation): Promise<StepMedia>;
  /** Like `derive`, but reports a refusal as the step's error outcome (or its abort). */
  admit(conversation: Conversation): Promise<StepMedia | MediaRefusal>;
}

interface LocatedMedia {
  readonly part: MediaContent;
  readonly messageId: string;
  readonly partIndex: number;
}

function locateMedia(conversation: Conversation): LocatedMedia[] {
  const located: LocatedMedia[] = [];
  for (const message of conversation.getMessages()) {
    if (message.hidden) continue;
    for (const { part, partIndex } of messageMediaParts(message)) {
      located.push({ part, messageId: message.id, partIndex });
    }
  }
  return located;
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

type Resolution =
  | { readonly outcome: 'resolved'; readonly source: ResolvedMediaSource }
  | { readonly outcome: 'unavailable'; readonly reason?: string | undefined };

/** A memoized resolution, valid while the part at its position is unchanged. */
interface MemoizedResolution {
  readonly identity: string;
  readonly resolution: Resolution;
}

/**
 * Settles with `promise`, or rejects with the signal's reason the moment it aborts,
 * whichever comes first. A read that ignores its signal is abandoned, not awaited, so
 * cancelling a run cannot be held up by a resolver.
 */
async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    signal.throwIfAborted();
  }
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const value = await Promise.race([promise, aborted]);
    // Checked immediately after the resolution: a read that finished as the run was
    // cancelled is not admitted.
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function unsupported(
  located: LocatedMedia,
  reason: Extract<UnadmittedMediaCost, { outcome: 'unsupported' }>['reason'],
  detail?: string,
): UnadmittedMediaCost {
  return {
    messageId: located.messageId,
    partIndex: located.partIndex,
    modality: located.part.type,
    outcome: 'unsupported',
    reason,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** The largest cap among `caps`, or `undefined` when any backend declares none (and so has no cap). */
function largestCap(caps: readonly (number | undefined)[]): number | undefined {
  return caps.every((cap): cap is number => cap !== undefined) ? Math.max(...caps) : undefined;
}

/**
 * Names the parts to blame when no backend takes the whole request. A part no
 * backend takes on its own keeps that specific reason. Among the backends that
 * take every part on its own, the parts past the largest per-request count cap
 * are `media-count-exceeded` and the parts past the largest aggregate byte cap
 * are `media-limit-exceeded`, in conversation order. When nothing singles a
 * part out, every part is refused as `no-backend-admits-media`.
 */
function refusalsWhenNoBackendAdmits(input: {
  readonly located: readonly LocatedMedia[];
  readonly requirements: readonly InputMediaRequirement[];
  readonly descriptors: readonly BackendDescriptor[];
  readonly resolvedSources: ResolvedMediaSources | undefined;
  readonly partAlone: MediaCostEstimator;
}): Map<string, UnadmittedMediaCost> {
  const { located, requirements, descriptors, resolvedSources, partAlone } = input;
  const refusals = new Map<string, UnadmittedMediaCost>();
  for (const entry of located) {
    const alone = partAlone(entry.part, { messageId: entry.messageId, partIndex: entry.partIndex });
    if (alone.outcome !== 'estimated') refusals.set(`${entry.messageId}:${entry.partIndex}`, alone);
  }
  const takingEach = descriptors.filter((descriptor) =>
    requirements.every((requirement) => evaluateInputMedia(descriptor, [requirement]).eligible),
  );
  if (takingEach.length > 0) {
    const seen = new Map<MediaContent['type'], number>();
    const totals = new Map<MediaContent['type'], number>();
    for (const entry of located) {
      const key = `${entry.messageId}:${entry.partIndex}`;
      if (refusals.has(key)) continue;
      const modality = entry.part.type;
      const count = (seen.get(modality) ?? 0) + 1;
      seen.set(modality, count);
      const countCap = largestCap(
        takingEach.map(
          (descriptor) =>
            descriptor.mediaCounts.find((cap) => cap.modality === modality)?.maxPerRequest,
        ),
      );
      if (countCap !== undefined && count > countCap) {
        refusals.set(key, unsupported(entry, 'media-count-exceeded'));
        continue;
      }
      const resolution = resolvedSources?.get(key);
      const byteLength =
        resolution?.byteLength ?? sourceByteLength(resolution?.source ?? entry.part.source);
      if (byteLength === undefined) continue;
      const total = (totals.get(modality) ?? 0) + byteLength;
      totals.set(modality, total);
      const aggregateCap = largestCap(
        takingEach.map(
          (descriptor) =>
            descriptor.mediaLimits.find(
              (limit) =>
                limit.modality === modality &&
                limit.scope === 'aggregate' &&
                limit.maxBytes !== undefined,
            )?.maxBytes,
        ),
      );
      if (aggregateCap !== undefined && total > aggregateCap) {
        refusals.set(key, {
          messageId: entry.messageId,
          partIndex: entry.partIndex,
          modality,
          outcome: 'unbounded',
          reason: 'media-limit-exceeded',
        });
      }
    }
  }
  if (refusals.size === 0) {
    for (const entry of located) {
      refusals.set(
        `${entry.messageId}:${entry.partIndex}`,
        unsupported(entry, 'no-backend-admits-media'),
      );
    }
  }
  return refusals;
}

/**
 * Creates the admission for one step. Call {@link StepMediaAdmission.admit} on
 * the conversation at the step boundary (the preview selection, budgeting, and
 * the input guardrail read) and again on the exact conversation each
 * `generate` call receives.
 */
export function createStepMediaAdmission(input: {
  readonly deps: StepDeps;
  readonly step: number;
  readonly emitter: EventDispatcher | undefined;
}): StepMediaAdmission {
  const { deps, step, emitter } = input;
  const descriptors = readBackendDescriptors(deps.generate);
  // An opaque candidate behind a dispatcher: the rows above are not everything
  // the call can reach, so eligibility is dispatch's question, not admission's.
  const unionIncomplete = isDescriptorUnionIncomplete(descriptors);
  const memo = new Map<string, MemoizedResolution>();

  async function resolve(located: LocatedMedia): Promise<Resolution> {
    const { part, messageId, partIndex } = located;
    const key = `${messageId}:${partIndex}`;
    // A non-wire part never carries bytes, so its JSON is small and names it exactly.
    // Keyed by where the part sits and the source's own JSON, never by its descriptive
    // fields: a guardrail that sanitizes a caption, alt text, or metadata changes the
    // part but not its source, and must not cause the source to be read a second time
    // (a file or resource can change between reads, sending bytes nothing inspected).
    // The source of a non-wire part names bytes without carrying them, so it is small.
    const identity = JSON.stringify(part.source);
    const remembered = memo.get(key);
    if (remembered !== undefined && remembered.identity === identity) return remembered.resolution;
    const resolver = deps.contentSourceResolver;
    const signal = deps.signal;
    const result =
      resolver === undefined
        ? undefined
        : await untilAborted(resolver(part, { messageId, partIndex, signal }), signal);
    const resolution: Resolution =
      result?.outcome === 'resolved'
        ? { outcome: 'resolved', source: result }
        : { outcome: 'unavailable', reason: result?.reason };
    memo.set(key, { identity, resolution });
    return resolution;
  }

  async function derive(conversation: Conversation): Promise<StepMedia> {
    const located = locateMedia(conversation);
    if (located.length === 0) {
      return {
        resolvedSources: undefined,
        mediaTokens: 0,
        estimate: deps.mediaCostEstimator ?? createCatalogMediaCostEstimator(descriptors),
      };
    }

    const resolved = new Map<string, ResolvedMediaSource>();
    const refusals = new Map<string, UnadmittedMediaCost>();
    const blockUnknown = deps.assetSafety?.unknown === 'block';
    for (const entry of located) {
      const key = `${entry.messageId}:${entry.partIndex}`;
      if (WIRE_SOURCE_KINDS.has(entry.part.source.kind)) continue;
      // A non-wire source with no resolver, or one the resolver cannot project,
      // is unavailable at admission whatever the estimator would say.
      const resolution = await resolve(entry);
      if (resolution.outcome === 'unavailable') {
        refusals.set(key, unsupported(entry, 'source-form-not-accepted', resolution.reason));
        continue;
      }
      resolved.set(key, resolution.source);
    }
    // A media type that comes from outside the schema's reach (a data URL's own header,
    // or what a resolver reported) must fit the part's modality as a declared one does.
    for (const entry of located) {
      const key = `${entry.messageId}:${entry.partIndex}`;
      if (refusals.has(key)) continue;
      const resolution = resolved.get(key);
      const declared = [
        resolution?.mimeType,
        dataUrlMimeType(entry.part.source),
        resolution === undefined ? undefined : dataUrlMimeType(resolution.source),
      ];
      if (
        declared.some(
          (mimeType) => mimeType !== undefined && !mimeTypeFitsModality(entry.part.type, mimeType),
        )
      ) {
        resolved.delete(key);
        refusals.set(key, unsupported(entry, 'mime-type-mismatch'));
      }
    }
    // Admission's safety verdict, for every resolved part in every message.
    for (const entry of located) {
      const key = `${entry.messageId}:${entry.partIndex}`;
      const resolution = resolved.get(key);
      if (resolution === undefined || refusals.has(key)) continue;
      if (resolution.safety === 'flagged') {
        refusals.set(key, unsupported(entry, 'asset-flagged'));
      } else if (resolution.safety === 'unknown' && blockUnknown) {
        refusals.set(key, unsupported(entry, 'asset-unverified'));
      }
    }
    const resolvedSources: ResolvedMediaSources | undefined =
      resolved.size > 0 ? resolved : undefined;

    // Each reachable backend is judged on the whole request; the request is
    // admitted when at least one takes every part, and costed against those.
    const requirements = locateInputMedia(conversation, resolvedSources).map(
      ({ requirement }) => requirement,
    );
    const admitting = unionIncomplete
      ? descriptors
      : descriptors.filter((descriptor) => evaluateInputMedia(descriptor, requirements).eligible);
    const noBackendAdmits = !unionIncomplete && descriptors.length > 0 && admitting.length === 0;
    const catalogEstimate = createCatalogMediaCostEstimator(
      admitting.length > 0 ? admitting : descriptors,
      { resolvedSources },
    );
    const estimate: MediaCostEstimator =
      deps.mediaCostEstimator ??
      (unionIncomplete
        ? (part, position) => {
            const outcome = catalogEstimate(part, position);
            return outcome.outcome === 'estimated'
              ? outcome
              : { ...position, modality: part.type, outcome: 'unbounded', reason: 'no-estimator' };
          }
        : catalogEstimate);
    // When no backend takes the whole request, blame the parts that single it
    // out, not the set; see `refusalsWhenNoBackendAdmits`.
    const blamed = noBackendAdmits
      ? refusalsWhenNoBackendAdmits({
          located,
          requirements,
          descriptors,
          resolvedSources,
          partAlone: createCatalogMediaCostEstimator(descriptors, { resolvedSources }),
        })
      : new Map<string, UnadmittedMediaCost>();
    const outcomes: MediaCostOutcome[] = located.map((entry) => {
      const key = `${entry.messageId}:${entry.partIndex}`;
      const refused = refusals.get(key) ?? blamed.get(key);
      if (refused !== undefined) return refused;
      return estimate(entry.part, { messageId: entry.messageId, partIndex: entry.partIndex });
    });

    const refused = outcomes.filter(
      (outcome): outcome is UnadmittedMediaCost => outcome.outcome !== 'estimated',
    );
    if (refused.length > 0) {
      throw new MediaAdmissionError(refused, {
        admitted: outcomes.filter((outcome) => outcome.outcome === 'estimated'),
      });
    }
    const mediaTokens = outcomes.reduce(
      (sum, outcome) => sum + (outcome.outcome === 'estimated' ? outcome.tokens : 0),
      0,
    );
    return { resolvedSources, mediaTokens, estimate };
  }

  return {
    derive,
    async admit(conversation) {
      try {
        return await derive(conversation);
      } catch (error) {
        // A cancellation during resolution ends the run as aborted (COR-104), not as a
        // policy error.
        if (deps.signal?.aborted) {
          return { kind: 'abort', reason: explicitAbortReason(deps.signal) };
        }
        emitter?.dispatch(new RunErrorEvent(step, error, 'policy'));
        return { kind: 'error', error, errorKind: 'policy' };
      }
    },
  };
}
