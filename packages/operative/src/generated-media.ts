import type { MediaContent, MultiModalContent } from 'conversationalist';

import { GeneratedMediaNotAdmittedError } from './errors';
import { type InlineMediaContent, inlineMediaParts } from './response-parts';
import type { CleanupAcknowledgement, ClosedOptions } from './types';

export type { InlineMediaContent } from './response-parts';

/** The `managed-asset` member of a content source: what a generated media part becomes. */
export type ManagedAssetReference = Extract<MediaContent['source'], { kind: 'managed-asset' }>;

/**
 * One generated media part, handed to the admission port. Before admission an adapter's
 * media part carries an `inline` source and only there; the port turns it into a managed
 * asset and the part never carries inline bytes again.
 */
export interface GeneratedMediaAdmissionRequest {
  readonly part: InlineMediaContent;
  readonly runId: string | undefined;
  readonly step: number;
  /** The part's position in the row it will be committed to. */
  readonly partIndex: number;
  /** The id of the row the part belongs to, when it is already known (a streaming row). */
  readonly messageId: string | undefined;
  /** Aborts when the step or run is cancelled, so the admission settles instead of hanging. */
  readonly signal: AbortSignal;
}

/** How one admission ended. `aborted` is a cancellation, not a verdict on the part. */
export type GeneratedMediaSettlement =
  | {
      readonly outcome: 'available';
      readonly source: ManagedAssetReference;
      /** The media type the asset was detected as; replaces the adapter's declared one. */
      readonly mimeType?: string | undefined;
    }
  | { readonly outcome: 'rejected'; readonly code: string; readonly message: string }
  | { readonly outcome: 'aborted'; readonly reason: string };

/** The started work of one admission, as the port returns it. */
export interface GeneratedMediaAdmission {
  /** The pending reference, known as soon as the port accepts the part. */
  readonly source: ManagedAssetReference;
  /** Resolves when the asset is available, rejected or aborted. Never rejects. */
  settled(): Promise<GeneratedMediaSettlement>;
  /** Aborts the admission. Idempotent, never throws. */
  abort(reason?: string): void;
  /** Resolves once the admission has fully settled. Never rejects. */
  closed(options?: ClosedOptions): Promise<CleanupAcknowledgement>;
}

/**
 * The injected media-admission port (the `contentSourceResolver` precedent). Bureau builds
 * it from its asset service, scoped to the run's owning principal; Operative owns the run
 * identity, the tracking and the cleanup fold. `admit` may reject when the part is refused
 * before the admission starts.
 */
export interface GeneratedMediaAdmitter {
  admit(request: GeneratedMediaAdmissionRequest): Promise<GeneratedMediaAdmission>;
  /**
   * Admits one response's generated parts as one batch that shares the policy's aggregate
   * budgets (byte and duration ceilings across the parts), as the asset service's `admitAll`
   * does, so individually valid parts cannot exceed an aggregate limit together. A port without
   * it is called once per part. A streaming wrapper admits each part as it completes and so
   * cannot batch; only a response admitted after `generate` returns can.
   */
  admitAll?(
    requests: readonly GeneratedMediaAdmissionRequest[],
  ): Promise<readonly GeneratedMediaAdmission[]>;
}

/** What a hook, adapter or streaming wrapper passes in: the step supplies the rest. */
export interface StepMediaAdmissionRequest {
  readonly part: InlineMediaContent;
  readonly partIndex: number;
  readonly messageId?: string | undefined;
}

/**
 * The step-bound admitter the loop puts on `GenerateContext`. It fills the run id, the
 * step and the step's signal, hands every admission to the run's tracker so cleanup can
 * wait for it, and fails with a typed error when the run carries no port. It is applied by
 * the loop after every `beforeGenerate` handler, so a hook cannot replace it.
 */
export interface StepGeneratedMediaAdmitter {
  admit(request: StepMediaAdmissionRequest): Promise<GeneratedMediaAdmission>;
  /** Admits several parts of one response as one batch; falls back to one call per part. */
  admitAll(requests: readonly StepMediaAdmissionRequest[]): Promise<GeneratedMediaAdmission[]>;
}

export function createStepGeneratedMediaAdmitter(options: {
  readonly port: GeneratedMediaAdmitter | undefined;
  readonly runId: string | undefined;
  readonly step: number;
  readonly signal: AbortSignal;
  readonly track?: ((admission: GeneratedMediaAdmission) => void) | undefined;
}): StepGeneratedMediaAdmitter {
  const refusal = (request: StepMediaAdmissionRequest, error: unknown): Error => {
    if (error instanceof GeneratedMediaNotAdmittedError) return error;
    return new GeneratedMediaNotAdmittedError({
      reason: 'admission-failed',
      step: options.step,
      partIndex: request.partIndex,
      messageId: request.messageId,
      modality: request.part.type,
      detail: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  };
  const noPort = (request: StepMediaAdmissionRequest): GeneratedMediaNotAdmittedError =>
    new GeneratedMediaNotAdmittedError({
      reason: 'no-admitter',
      step: options.step,
      partIndex: request.partIndex,
      messageId: request.messageId,
      modality: request.part.type,
    });
  const portRequest = (request: StepMediaAdmissionRequest): GeneratedMediaAdmissionRequest => ({
    part: request.part,
    runId: options.runId,
    step: options.step,
    partIndex: request.partIndex,
    messageId: request.messageId,
    signal: options.signal,
  });

  return {
    async admit(request) {
      if (options.port === undefined) throw noPort(request);
      let admission: GeneratedMediaAdmission;
      try {
        admission = await options.port.admit(portRequest(request));
      } catch (error) {
        throw refusal(request, error);
      }
      options.track?.(admission);
      return admission;
    },

    async admitAll(requests) {
      const first = requests[0];
      if (first === undefined) return [];
      const { port } = options;
      if (port === undefined) throw noPort(first);
      // A port with a batch call shares one aggregate budget across the parts; one without is
      // called once per part. A part refused before it starts leaves the started ones aborted.
      if (port.admitAll !== undefined) {
        let admissions: readonly GeneratedMediaAdmission[];
        try {
          admissions = await port.admitAll(requests.map(portRequest));
        } catch (error) {
          throw refusal(first, error);
        }
        for (const admission of admissions) options.track?.(admission);
        return [...admissions];
      }
      const started = await Promise.allSettled(requests.map((request) => this.admit(request)));
      const failure = started.find((result) => result.status === 'rejected');
      if (failure !== undefined) {
        const open = started.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : [],
        );
        for (const admission of open) admission.abort('A sibling admission was refused');
        await Promise.allSettled(open.map((admission) => admission.settled()));
        throw failure.reason;
      }
      return started.map(
        (result) => (result as PromiseFulfilledResult<GeneratedMediaAdmission>).value,
      );
    },
  };
}

/**
 * Waits for a started admission to settle and returns the same part with its settled
 * `managed-asset` source. A rejected admission throws a {@link GeneratedMediaNotAdmittedError}
 * naming the part; an aborted one throws the same error with the rejection code `aborted`,
 * which the loop reads as a cancellation when its signal has fired.
 */
export async function settleMediaAdmission(
  admission: GeneratedMediaAdmission,
  part: InlineMediaContent,
  context: { readonly step: number; readonly partIndex: number; readonly messageId?: string },
): Promise<MediaContent> {
  const settlement = await admission.settled();
  if (settlement.outcome === 'available') {
    return {
      ...part,
      source: settlement.source,
      ...(settlement.mimeType === undefined ? {} : { mimeType: settlement.mimeType }),
    };
  }
  throw new GeneratedMediaNotAdmittedError({
    reason: 'admission-failed',
    step: context.step,
    partIndex: context.partIndex,
    messageId: context.messageId,
    modality: part.type,
    rejectionCode: settlement.outcome === 'rejected' ? settlement.code : 'aborted',
    detail: settlement.outcome === 'rejected' ? settlement.message : settlement.reason,
  });
}

/** Admits one generated media part and waits for it to settle; see {@link settleMediaAdmission}. */
export async function admitMediaPart(
  admitter: StepGeneratedMediaAdmitter | undefined,
  part: InlineMediaContent,
  context: { readonly step: number; readonly partIndex: number; readonly messageId?: string },
): Promise<MediaContent> {
  if (admitter === undefined) {
    throw new GeneratedMediaNotAdmittedError({
      reason: 'no-admitter',
      step: context.step,
      partIndex: context.partIndex,
      messageId: context.messageId,
      modality: part.type,
    });
  }
  const admission = await admitter.admit({
    part,
    partIndex: context.partIndex,
    messageId: context.messageId,
  });
  return settleMediaAdmission(admission, part, context);
}

/**
 * Admits every part that still carries inline bytes, as one batch, and returns the parts with
 * each replaced by its managed-asset form. A part already managed is left alone, so settling a
 * response twice never admits twice. When one admission is refused, the others are aborted and
 * awaited to settlement before the first failure is rethrown, so a failed part never leaves a
 * sibling running or an asset pending.
 */
export async function admitInlineMedia(
  admitter: StepGeneratedMediaAdmitter | undefined,
  parts: readonly MultiModalContent[],
  context: { readonly step: number; readonly messageId?: string | undefined },
): Promise<readonly MultiModalContent[]> {
  const pending = inlineMediaParts(parts);
  if (pending.length === 0) return parts;
  const settleContext = (index: number) => ({
    step: context.step,
    partIndex: index,
    ...(context.messageId === undefined ? {} : { messageId: context.messageId }),
  });
  if (admitter === undefined) {
    const { index, part } = pending[0]!;
    throw new GeneratedMediaNotAdmittedError({
      reason: 'no-admitter',
      step: context.step,
      partIndex: index,
      messageId: context.messageId,
      modality: part.type,
    });
  }
  const admissions = await admitter.admitAll(
    pending.map(({ index, part }) => ({
      part,
      partIndex: index,
      messageId: context.messageId,
    })),
  );
  let firstFailure: unknown;
  let refused = false;
  const settled = await Promise.allSettled(
    admissions.map((admission, position) =>
      settleMediaAdmission(
        admission,
        pending[position]!.part,
        settleContext(pending[position]!.index),
      ).catch((error: unknown) => {
        if (!refused) {
          refused = true;
          firstFailure = error;
          for (const sibling of admissions) sibling.abort('A sibling admission was refused');
        }
        throw error;
      }),
    ),
  );
  // The first refusal in time is the cause; siblings it aborted only echo it.
  if (refused) throw firstFailure;
  const next = [...parts];
  for (const [position, { index }] of pending.entries()) {
    next[index] = (settled[position] as PromiseFulfilledResult<MediaContent>).value;
  }
  return next;
}
