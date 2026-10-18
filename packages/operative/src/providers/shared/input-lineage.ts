import type { ContentPartLineage } from 'conversationalist';

import type { GenerateResponse, JSONValue } from '../../types';

/** The `GenerateResponse.metadata` key that carries a request's media lineage. */
export const INPUT_LINEAGE_METADATA_KEY = 'inputLineage';

/** Projects lineage entries to plain JSON, dropping absent optional fields. */
export function lineageToJSON(lineage: readonly ContentPartLineage[]): JSONValue {
  return lineage.map((entry) => ({
    messageId: entry.messageId,
    partIndex: entry.partIndex,
    modality: entry.modality,
    provider: entry.provider,
    from: entry.from,
    to: entry.to,
    transform: entry.transform,
    ...(entry.providerFileId !== undefined ? { providerFileId: entry.providerFileId } : {}),
    ...(entry.originalMimeType !== undefined ? { originalMimeType: entry.originalMimeType } : {}),
    ...(entry.assetId !== undefined ? { assetId: entry.assetId } : {}),
    ...(entry.revision !== undefined ? { revision: entry.revision } : {}),
  }));
}

/**
 * Records the request's media lineage on the response, so it lands in the
 * durable transcript beside the assistant message without rewriting the user
 * message. A request that carried no media adds nothing.
 */
export function withInputLineage(
  response: GenerateResponse,
  lineage: readonly ContentPartLineage[],
): GenerateResponse {
  if (lineage.length === 0) return response;
  return {
    ...response,
    metadata: { ...response.metadata, [INPUT_LINEAGE_METADATA_KEY]: lineageToJSON(lineage) },
  };
}
