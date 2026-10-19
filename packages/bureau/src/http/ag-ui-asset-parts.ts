/**
 * Which parts of a message are managed assets, read the one way the AG-UI mount needs it twice:
 * from the parts a `generate.completed` event carries (JSON, so untyped), and from the parts of a
 * stored assistant row.
 *
 * @module ag-ui-asset-parts
 */

import type { AssetPartReference } from './ag-ui-vocabulary.ts';

/** The media part types that can hold a managed asset. */
const MEDIA_TYPES: ReadonlySet<string> = new Set(['image', 'audio', 'video', 'document', 'file']);

/** The media type an asset part names when it declared none. */
export const UNKNOWN_MEDIA_TYPE = 'application/octet-stream';

/**
 * The managed assets among `parts`, in ascending `index`, each with its position in `parts`. A
 * value that is not an array, and any part that is not a media part with a `managed-asset` source,
 * contributes nothing.
 */
export function assetPartsOf(parts: unknown): AssetPartReference[] {
  if (!Array.isArray(parts)) return [];
  const references: AssetPartReference[] = [];
  for (const [index, part] of (parts as unknown[]).entries()) {
    if (typeof part !== 'object' || part === null) continue;
    const { type, source, mimeType } = part as Record<string, unknown>;
    if (typeof type !== 'string' || !MEDIA_TYPES.has(type)) continue;
    if (typeof source !== 'object' || source === null) continue;
    const { kind, assetId } = source as Record<string, unknown>;
    if (kind !== 'managed-asset' || typeof assetId !== 'string') continue;
    references.push({
      index,
      assetId,
      mediaType: typeof mimeType === 'string' && mimeType !== '' ? mimeType : UNKNOWN_MEDIA_TYPE,
    });
  }
  return references;
}
