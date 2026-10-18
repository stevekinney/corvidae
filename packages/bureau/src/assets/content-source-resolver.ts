import type { ContentSourceResolver } from '@lostgradient/operative';

import { encodeBase64 } from './base64';
import {
  AssetAccessDeniedError,
  AssetIntegrityError,
  AssetNotFoundError,
  AssetUnavailableError,
} from './errors';
import type { AssetService } from './types';

type ResolvedSafety = 'clean' | 'flagged' | 'unknown';

/**
 * The resolver Bureau hands a run (COR-716): it projects a `managed-asset` part
 * to the form a provider accepts, reading through {@link AssetService.resolve}
 * as the run's own principal, so a run reaches only the assets that principal
 * may read.
 *
 * - Bureau-held bytes become an `inline` base64 source.
 * - A provider-fetch declaration becomes a `remote-url` source, which the
 *   provider fetches itself.
 * - `safety` comes from the asset's verdicts, read from the privileged
 *   projection on the run's behalf (the verdicts leave only as this
 *   three-state answer): every gate clean is `clean`, any flagged is `flagged`,
 *   and an asset no gate inspected is `unknown`.
 *
 * Every refusal is the typed `unavailable` result, never a throw, so the step
 * fails with a `MediaAdmissionError` naming the part before any provider call.
 * A source kind Bureau holds no bytes for (an upload, a local file, an MCP
 * resource, an A2A reference) is likewise `unavailable`.
 */
export function createAssetContentSourceResolver(
  assets: AssetService,
  principalId: string,
): ContentSourceResolver {
  return async (part) => {
    const { source } = part;
    if (source.kind !== 'managed-asset') {
      return { outcome: 'unavailable', reason: 'source-kind-not-supported' };
    }
    const reference = {
      assetId: source.assetId,
      ...(source.revision !== undefined ? { revision: source.revision } : {}),
    };
    try {
      const resolved = await assets.resolve(reference, { id: principalId });
      const safety = await readSafety(assets, source.assetId, principalId);
      const { descriptor } = resolved;
      const facts = {
        ...(descriptor.mediaType !== undefined ? { mimeType: descriptor.mediaType } : {}),
        safety,
      } as const;
      if (resolved.content.kind === 'provider-fetch') {
        return {
          outcome: 'resolved',
          source: { kind: 'remote-url', url: resolved.content.url },
          ...facts,
        };
      }
      return {
        outcome: 'resolved',
        source: { kind: 'inline', data: encodeBase64(resolved.content.bytes), encoding: 'base64' },
        byteLength: descriptor.byteLength ?? resolved.content.bytes.byteLength,
        ...facts,
      };
    } catch (error) {
      const reason = unavailableReason(error);
      if (reason === undefined) throw error;
      return { outcome: 'unavailable', reason };
    }
  };
}

async function readSafety(
  assets: AssetService,
  assetId: string,
  principalId: string,
): Promise<ResolvedSafety> {
  try {
    const descriptor = await assets.inspect(
      assetId,
      { id: principalId, privileged: true },
      { projection: 'privileged' },
    );
    if (descriptor.projection !== 'privileged' || descriptor.safety.length === 0) return 'unknown';
    return descriptor.safety.some((verdict) => verdict.verdict === 'flagged') ? 'flagged' : 'clean';
  } catch (error) {
    // The verdicts could not be read (not owner-readable, asset gone between
    // the two reads): the asset is unverified, which the guardrail's policy decides.
    if (unavailableReason(error) !== undefined) return 'unknown';
    throw error;
  }
}

function unavailableReason(error: unknown): string | undefined {
  if (error instanceof AssetNotFoundError) return 'asset-not-found';
  if (error instanceof AssetAccessDeniedError) return 'asset-access-denied';
  if (error instanceof AssetUnavailableError) return 'asset-unavailable';
  if (error instanceof AssetIntegrityError) return 'asset-integrity-failed';
  return undefined;
}
