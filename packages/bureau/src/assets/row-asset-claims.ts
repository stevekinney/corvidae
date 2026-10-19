/**
 * The claim a conversation row holds on each managed asset it references (COR-713).
 *
 * The asset policy's retention floor expires an asset on its own schedule, so an asset a persisted
 * row still points at needs a reference of its own, or a later replay fails to resolve it. The
 * reference is the asset service's `retain`, and it belongs to the session that holds the row:
 * the holder is keyed by session and row, so a row copied into another session (a goal's
 * fork-from-baseline retry, `appendMessages`, a session fork) is claimed there under that
 * session's own holder, and deleting either session leaves the other's claim alone. A run with no
 * session keys its claims by run id.
 *
 * Every managed-asset reference in a row counts, user or assistant, supplied or generated, so
 * releasing a session's claims is symmetric with taking them.
 */

import { AssetAccessDeniedError, AssetNotFoundError, AssetUnavailableError } from './errors';
import type { AssetService } from './types';

/**
 * A claim does not lapse by itself: it ends only when its row's session does, through
 * {@link releaseRowAssetClaims}, so its `until` is the end of the representable calendar.
 */
const ROW_CLAIM_UNTIL = '9999-12-31T23:59:59.999Z';

/** The holder under which a session's row keeps the assets it references. */
export function sessionRowHolderId(sessionId: string, rowId: string): string {
  return `session-row:${encodeURIComponent(sessionId)}:${encodeURIComponent(rowId)}`;
}

/** The holder under which a row of a run with no session keeps the assets it references. */
export function runRowHolderId(runId: string, rowId: string): string {
  return `run-row:${encodeURIComponent(runId)}:${encodeURIComponent(rowId)}`;
}

/** The asset ids of the managed-asset sources a row's content references, once each. */
export function managedAssetIdsOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids = new Set<string>();
  for (const part of content as ReadonlyArray<{ source?: { kind?: string; assetId?: string } }>) {
    const source = part?.source;
    if (source?.kind === 'managed-asset' && typeof source.assetId === 'string') {
      ids.add(source.assetId);
    }
  }
  return [...ids];
}

/** An asset the principal cannot claim or release is not this row's to keep: skip it, quietly. */
function isNotOurs(error: unknown): boolean {
  return (
    error instanceof AssetNotFoundError ||
    error instanceof AssetAccessDeniedError ||
    error instanceof AssetUnavailableError
  );
}

/**
 * Claims, under `holderOf(row.id)`, every managed asset the rows reference. Idempotent: a claim
 * already held is not changed. An asset the principal cannot see, or that is no longer available
 * (a reference a hook supplied, or an asset already gone), is skipped; any other failure goes to
 * `onFailure` and the rest are still claimed.
 */
export async function claimRowAssets(
  assets: AssetService,
  principalId: string,
  holderOf: (rowId: string) => string,
  rows: Iterable<{ readonly id: string; readonly content: unknown }>,
  onFailure: (assetId: string, error: unknown) => void,
  alreadyClaimed?: Set<string>,
): Promise<void> {
  for (const row of rows) {
    for (const assetId of managedAssetIdsOf(row.content)) {
      const holderId = holderOf(row.id);
      const key = `${holderId}\u0000${assetId}`;
      if (alreadyClaimed?.has(key)) continue;
      try {
        await assets.retain(assetId, { id: principalId }, { holderId, until: ROW_CLAIM_UNTIL });
        alreadyClaimed?.add(key);
      } catch (error) {
        if (!isNotOurs(error)) onFailure(assetId, error);
      }
    }
  }
}

/**
 * Releases the claims the rows held, so their assets fall back to the retention policy. Each
 * asset is released on its own, and one that was never this row's to claim is skipped.
 */
export async function releaseRowAssetClaims(
  assets: AssetService,
  principalId: string,
  holderOf: (rowId: string) => string,
  rows: Iterable<{ readonly id: string; readonly content: unknown }>,
  onFailure: (assetId: string, error: unknown) => void,
  claimed?: Set<string>,
): Promise<void> {
  for (const row of rows) {
    for (const assetId of managedAssetIdsOf(row.content)) {
      const holderId = holderOf(row.id);
      claimed?.delete(`${holderId}\u0000${assetId}`);
      try {
        await assets.release(assetId, { id: principalId }, holderId);
      } catch (error) {
        if (!isNotOurs(error)) onFailure(assetId, error);
      }
    }
  }
}
