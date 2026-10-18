import type {
  GeneratedMediaAdmission,
  GeneratedMediaAdmitter,
  GeneratedMediaSettlement,
} from '@lostgradient/operative';

import { decodeBase64 } from './base64';
import type { AssetService, AssetWorkResult, AssetDescriptor } from './types';

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
  return {
    async admit(request): Promise<GeneratedMediaAdmission> {
      const { source: inline } = request.part;
      const bytes =
        inline.encoding === 'base64'
          ? decodeBase64(inline.data)
          : new TextEncoder().encode(inline.data);
      const admission = await assets.admit(
        {
          source: { kind: 'inline', bytes },
          ...(request.part.mimeType === undefined
            ? {}
            : { declaredMediaType: request.part.mimeType }),
        },
        { id: principalId },
      );
      const { work } = admission;
      if (request.signal.aborted) work.abort('The run was cancelled');
      else {
        request.signal.addEventListener('abort', () => work.abort('The run was cancelled'), {
          once: true,
        });
      }
      return {
        source: admission.source,
        async settled() {
          return settlementOf(await work.result());
        },
        abort(reason) {
          work.abort(reason);
        },
        closed: (options) => work.closed(options),
      };
    },
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
