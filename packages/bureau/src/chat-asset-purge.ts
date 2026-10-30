/**
 * COR-1934 — what a chat delete removes from the managed assets.
 *
 * A file a person sent in a chat, or an agent generated in it, is an asset: a record of media
 * facts and holders, and the bytes in asset storage. The asset is its owner's, not the chat's, so
 * until now a chat delete only released the chat's claims, and an asset nothing held then lived
 * until the asset policy's retention expired it, which by default is never (owner decision: a chat
 * delete deletes the assets it leaves unreferenced).
 *
 * The chat's assets are named before it is deleted (`DeletedChat.assets`): its rows are gone by the
 * time the purge runs, and its claims are released by then, so neither can say which assets it
 * held. Each is deleted only if nothing else holds it, decided inside the delete itself
 * (`unlessReferenced`): an asset a second chat also references, or one under a legal or audit
 * hold, is kept. A deleted asset's bytes go at the next garbage collection, which this runs, since
 * an asset service with no collection interval would otherwise keep them for ever.
 */
import type { AssetService } from './assets/types';

/** An asset a chat held, with the principal that owns it, which is the one that may delete it. */
export interface ChatAsset {
  readonly assetId: string;
  readonly ownerId: string;
}

/** Rejection codes that mean the asset stays: something else holds it, or it is not this owner's or is gone. */
const KEPT_CODES: ReadonlySet<string> = new Set(['held', 'source-not-available']);

/**
 * Deletes the assets nothing else holds. Rejects after trying them all when one could not be
 * deleted, or the collection that removes the bytes failed, so the pass that called it stays owed.
 */
export async function purgeChatAssets(
  service: AssetService,
  assets: readonly ChatAsset[],
): Promise<void> {
  if (assets.length === 0) return;
  const failures: string[] = [];
  for (const { assetId, ownerId } of assets) {
    try {
      const result = await service
        .delete(assetId, { id: ownerId }, { unlessReferenced: true })
        .result();
      if (result.outcome === 'aborted') failures.push(`asset "${assetId}": ${result.reason}`);
      if (result.outcome === 'failed' && !KEPT_CODES.has(result.rejection.code)) {
        failures.push(`asset "${assetId}": ${result.rejection.code}`);
      }
    } catch (error: unknown) {
      failures.push(
        `asset "${assetId}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const collected = await service.collectGarbage().result();
  if (collected.outcome !== 'completed') failures.push('garbage collection did not complete');
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} assets of the chat could not be deleted: ${failures.join('; ')}`,
    );
  }
}
