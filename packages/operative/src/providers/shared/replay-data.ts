import type { JSONValue } from '../../types';
import type { ProviderName } from '../types.ts';

/** The `GenerateResponse.metadata` key that names provider-private replay data the adapter could not keep. */
export const REPLAY_DATA_DROPPED_METADATA_KEY = 'replayDataDropped';

/**
 * One piece of provider-private replay data a response carried but that has no
 * `MultiModalContent` representation: a Gemini part's `thoughtSignature`, or a `thought`
 * summary part. The response is still returned and usable; the loop dispatches an
 * instrumentation event and never throws, because the response is already billed.
 */
export interface DroppedReplayData {
  readonly provider: ProviderName;
  /** The position in the candidate's parts array. */
  readonly providerPartIndex: number;
  readonly field: 'thoughtSignature' | 'thought';
}

/** Builds the metadata entry for a list of dropped replay data; `undefined` when there is none. */
export function droppedReplayDataMetadata(
  dropped: readonly DroppedReplayData[],
): Record<string, JSONValue> | undefined {
  if (dropped.length === 0) return undefined;
  return {
    [REPLAY_DATA_DROPPED_METADATA_KEY]: dropped.map((entry) => ({
      provider: entry.provider,
      providerPartIndex: entry.providerPartIndex,
      field: entry.field,
    })),
  };
}

/** Reads and validates the dropped-replay-data entries from a response's metadata. */
export function readDroppedReplayData(
  metadata: Readonly<Record<string, unknown>> | undefined,
): readonly DroppedReplayData[] {
  const raw = metadata?.[REPLAY_DATA_DROPPED_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  const entries: DroppedReplayData[] = [];
  for (const candidate of raw as unknown[]) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const entry = candidate as Record<string, unknown>;
    if (
      typeof entry['provider'] === 'string' &&
      typeof entry['providerPartIndex'] === 'number' &&
      (entry['field'] === 'thoughtSignature' || entry['field'] === 'thought')
    ) {
      entries.push({
        provider: entry['provider'] as ProviderName,
        providerPartIndex: entry['providerPartIndex'],
        field: entry['field'],
      });
    }
  }
  return entries;
}
