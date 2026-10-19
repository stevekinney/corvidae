import type {
  GeneratedMediaAdmission,
  GeneratedMediaAdmissionRequest,
  GeneratedMediaAdmitter,
  GeneratedMediaSettlement,
} from '@lostgradient/operative';

import { decodeBase64 } from './base64';
import { AssetAdmissionError } from './errors';
import {
  detectMediaType,
  modalityOf,
  normalizeMediaType,
  reconcileMediaType,
} from './media-inspection';
import type {
  AssetAdmission,
  AssetAdmissionRequest,
  AssetDescriptor,
  AssetService,
  AssetWorkResult,
} from './types';

/**
 * The media-admission port Bureau hands a run (COR-713): it admits a part a model generated as a
 * managed asset, through {@link AssetService.admit} as the run's owning principal, so the part
 * leaves the provider boundary as a `managed-asset` reference and no hook, event, row or persisted
 * result ever holds the bytes.
 *
 * - The part's inline bytes (`base64` or `utf8`) are admitted with the adapter's declared media
 *   type; the asset's detected type replaces it on the settled part.
 * - Provenance is `inline`, the service's record for inline bytes, so a generated asset is not
 *   distinguishable from supplied bytes except by the admitting principal and its audit.
 * - The admission is aborted through the request's signal, and `abort` aborts it directly. An
 *   aborted pending record settles `rejected` with code `aborted`, so no descriptor stays `pending`
 *   once the work has closed.
 * - Policy ceilings (`maxInlineBytes`, `maxAssetBytes`, the media-type allow list, safety gates)
 *   refuse an oversized, disallowed or flagged generated part as a failed admission.
 */
export function createAssetGeneratedMediaAdmitter(
  assets: AssetService,
  principalId: string,
): GeneratedMediaAdmitter {
  const principal = { id: principalId };
  /** The assets this port admitted, so a retention claim is made only for what it owns. */
  const admittedAssetIds = new Set<string>();
  const track = (admission: AssetAdmission): AssetAdmission => {
    admittedAssetIds.add(admission.source.assetId);
    return admission;
  };
  return {
    async admit(request): Promise<GeneratedMediaAdmission> {
      // The single-part call reaches here from a streaming wrapper, which admits each part as it
      // completes and so cannot share one aggregate budget across the response. Rather than leave
      // a configured aggregate ceiling silently off, it refuses the part.
      const assetRequestForPart = assetRequest(request);
      refuseUnderAggregateLimit(assets, assetRequestForPart);
      const admission = track(await assets.admit(assetRequestForPart, principal));
      return wrap(admission, request);
    },
    // One response's parts share the policy's aggregate ceilings, so they go through the
    // service's batch call: part N is decided after part N-1, and a refusal starts nothing.
    async admitAll(requests): Promise<readonly GeneratedMediaAdmission[]> {
      const admissions = await assets.admitAll(requests.map(assetRequest), principal);
      return admissions.map((admission, index) => wrap(track(admission), requests[index]!));
    },
    // The row now references each generated asset, so it holds a claim on it for as long as the
    // row exists: the policy's retention floor alone would expire the asset under the row. The
    // claim is the asset service's own reference (`retain`), held under the row's id and released
    // by `releaseGeneratedAssets` when the owning session is deleted or expires.
    async retainCommitted(request) {
      for (const part of request.parts) {
        if (part.source.kind !== 'managed-asset') continue;
        const { assetId } = part.source;
        if (!admittedAssetIds.has(assetId)) continue;
        await assets.retain(assetId, principal, {
          holderId: generatedRowHolderId(request.messageId),
          until: GENERATED_ROW_CLAIM_UNTIL,
        });
      }
    },
  };
}

/**
 * A generated row's claim does not lapse by itself: it ends only when the row's lifecycle does,
 * through {@link releaseGeneratedAssets}, so its `until` is the end of the representable calendar.
 */
const GENERATED_ROW_CLAIM_UNTIL = '9999-12-31T23:59:59.999Z';

/** The holder id under which a committed row keeps the generated assets it references. */
export function generatedRowHolderId(messageId: string): string {
  return `generated-row:${messageId}`;
}

/**
 * Releases the claims the rows of a deleted or expired session held on the generated assets they
 * reference, so those assets fall back to the retention policy. Each asset is released on its own:
 * one the session's owner cannot release (a managed asset a hook supplied, or one already gone)
 * is reported to `onFailure` and never stops the rest.
 */
export async function releaseGeneratedAssets(
  assets: AssetService,
  principalId: string,
  rows: Iterable<{ readonly id: string; readonly content: unknown }>,
  onFailure: (assetId: string, error: unknown) => void,
): Promise<void> {
  for (const row of rows) {
    if (!Array.isArray(row.content)) continue;
    for (const part of row.content as ReadonlyArray<{
      source?: { kind?: string; assetId?: string };
    }>) {
      const assetId = part?.source?.kind === 'managed-asset' ? part.source.assetId : undefined;
      if (assetId === undefined) continue;
      try {
        await assets.release(assetId, { id: principalId }, generatedRowHolderId(row.id));
      } catch (error) {
        onFailure(assetId, error);
      }
    }
  }
}

/**
 * Refuses a part admitted on its own when the media type the service will count it as has an
 * aggregate limit. That type is the service's own reconciliation of the declared type with the
 * type detected from the bytes, so neither a missing or misleading declaration nor a container's
 * detected type can make this check disagree with the budget. A declaration the bytes contradict
 * is left to the service, which refuses it as a media-type mismatch.
 */
function refuseUnderAggregateLimit(assets: AssetService, request: AssetAdmissionRequest): void {
  if (request.source.kind !== 'inline') return;
  const counted = reconcileMediaType(
    request.declaredMediaType === undefined
      ? undefined
      : normalizeMediaType(request.declaredMediaType),
    detectMediaType(request.source.bytes),
  );
  if (counted === undefined) return;
  const modality = modalityOf(counted);
  const limit = assets.policy.limits.find(
    (candidate) => candidate.scope === 'aggregate' && candidate.modality === modality,
  );
  if (limit !== undefined) {
    throw new AssetAdmissionError(
      'aggregate-limit-exceeded',
      `An aggregate ${limit.modality} limit applies, and a part admitted on its own (a streamed response) cannot be counted against it.`,
    );
  }
}

function assetRequest(request: GeneratedMediaAdmissionRequest): AssetAdmissionRequest {
  const { source: inline } = request.part;
  const bytes =
    inline.encoding === 'base64'
      ? decodeBase64(inline.data)
      : new TextEncoder().encode(inline.data);
  return {
    source: { kind: 'inline', bytes },
    ...(request.part.mimeType === undefined ? {} : { declaredMediaType: request.part.mimeType }),
  };
}

/**
 * Wires the request's signal to the admission's work and removes that listener once the work
 * settles, so a long-lived step signal does not accumulate one listener per admission.
 */
function wrap(
  admission: AssetAdmission,
  request: GeneratedMediaAdmissionRequest,
): GeneratedMediaAdmission {
  const { work, source } = admission;
  const abort = () => work.abort('The run was cancelled');
  if (request.signal.aborted) abort();
  else request.signal.addEventListener('abort', abort, { once: true });
  const detach = () => request.signal.removeEventListener('abort', abort);
  void work.result().then(detach, detach);
  return {
    source,
    async settled() {
      return settlementOf(await work.result());
    },
    abort(reason) {
      work.abort(reason);
    },
    closed: (options) => work.closed(options),
  };
}

function settlementOf(result: AssetWorkResult<AssetDescriptor>): GeneratedMediaSettlement {
  if (result.outcome === 'aborted') return { outcome: 'aborted', reason: result.reason };
  if (result.outcome === 'failed') {
    return { outcome: 'rejected', code: result.rejection.code, message: result.rejection.message };
  }
  const descriptor = result.value;
  if (descriptor.state !== 'available') {
    return {
      outcome: 'rejected',
      code: descriptor.rejection?.code ?? descriptor.state,
      message: descriptor.rejection?.message ?? `The asset settled as ${descriptor.state}.`,
    };
  }
  return {
    outcome: 'available',
    source: descriptor.source,
    ...(descriptor.mediaType === undefined ? {} : { mimeType: descriptor.mediaType }),
  };
}
