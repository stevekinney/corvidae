/**
 * The claim a conversation row holds on each managed asset it references (COR-713).
 *
 * The asset policy's retention floor expires an asset on its own schedule, so an asset a persisted
 * row still points at needs a reference of its own, or a later replay fails to resolve it. The
 * reference is the asset service's `retain`, and it belongs to the session that holds the row:
 * the holder is keyed by session incarnation and row, so a row copied into another session (a goal's
 * fork-from-baseline retry, `appendMessages`, a session fork) is claimed there under that
 * session's own holder, and deleting either session leaves the other's claim alone. A run with no
 * session keys its claims by run id.
 *
 * Every managed-asset reference in a row counts, user or assistant, supplied or generated, so
 * releasing a session's claims is symmetric with taking them.
 */

import {
  AssetAccessDeniedError,
  AssetNotFoundError,
  AssetRecordCorruptError,
  AssetUnavailableError,
} from './errors';
import type { AssetHeldClaim, AssetService } from './types';

/**
 * A claim does not lapse by itself: it ends only when its row's session does, through
 * {@link releaseRowAssetClaims}, so its `until` is the end of the representable calendar.
 */
const ROW_CLAIM_UNTIL = '9999-12-31T23:59:59.999Z';

/**
 * The holder under which a session's row keeps the assets it references. It names the session's
 * incarnation as well as its id: a session deleted and recreated under the same id holds the same
 * row ids, and a late cleanup of the old incarnation must never release the new one's claims.
 */
export function sessionRowHolderId(sessionId: string, incarnation: string, rowId: string): string {
  return `session-row:${encodeURIComponent(sessionId)}:${encodeURIComponent(incarnation)}:${encodeURIComponent(rowId)}`;
}

/** The holder under which a row of a run with no session keeps the assets it references. */
export function runRowHolderId(runId: string, rowId: string): string {
  return `run-row:${encodeURIComponent(runId)}:${encodeURIComponent(rowId)}`;
}

/** The start of every holder id a run's rows hold, whatever their row ids. */
export function runRowHolderPrefix(runId: string): string {
  return `run-row:${encodeURIComponent(runId)}:`;
}

/** The start of every holder id one incarnation of a session's rows hold, whatever their row ids. */
export function sessionRowHolderPrefix(sessionId: string, incarnation: string): string {
  return `session-row:${encodeURIComponent(sessionId)}:${encodeURIComponent(incarnation)}:`;
}

/** The run a `run-row` holder id belongs to, or `undefined` for any other holder. */
export function runIdOfRowHolder(holderId: string): string | undefined {
  const parts = holderId.split(':');
  if (parts.length !== 3 || parts[0] !== 'run-row') return undefined;
  return decodeURIComponent(parts[1]!);
}

/** The session incarnation a `session-row` holder id belongs to, or `undefined` for any other holder. */
export function sessionOfRowHolder(
  holderId: string,
): { readonly sessionId: string; readonly incarnation: string } | undefined {
  const parts = holderId.split(':');
  if (parts.length !== 4 || parts[0] !== 'session-row') return undefined;
  return {
    sessionId: decodeURIComponent(parts[1]!),
    incarnation: decodeURIComponent(parts[2]!),
  };
}

/** A conversation row as the claim walker reads it: its content and, for a tool result, its parts. */
export interface ClaimableRow {
  readonly id: string;
  readonly content: unknown;
  readonly toolResult?: { readonly parts?: unknown } | undefined;
  /** Read for `compactionSummary`, which marks a row that stands in for rows compaction removed. */
  readonly metadata?: { readonly compactionSummary?: unknown } | undefined;
}

/**
 * Whether history compaction has replaced rows of this conversation with a summary (COR-1664).
 * Rows it removed are not in the conversation any more, so a walk over the conversation cannot
 * reach the claims they held.
 */
export function hasCompactedRows(rows: Iterable<ClaimableRow>): boolean {
  for (const row of rows) if (row.metadata?.compactionSummary === true) return true;
  return false;
}

/**
 * The asset ids of the managed-asset sources a row references, once each: in its content and in
 * a tool result's parts (COR-792), so claiming and releasing walk the same references.
 */
export function managedAssetIdsOf(row: Omit<ClaimableRow, 'id'>): string[] {
  const ids = new Set<string>();
  for (const list of [row.content, row.toolResult?.parts]) {
    if (!Array.isArray(list)) continue;
    for (const part of list as ReadonlyArray<{ source?: { kind?: string; assetId?: string } }>) {
      const source = part?.source;
      if (source?.kind === 'managed-asset' && typeof source.assetId === 'string') {
        ids.add(source.assetId);
      }
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
 * A claim failure no retry can fix: the asset's stored record is corrupt (COR-1581). Every other
 * failure (a backend error, a lost compare-and-swap, a closed service, a full store) is transient,
 * and the claim is worth trying again.
 */
export function isPermanentClaimFailure(error: unknown): boolean {
  return error instanceof AssetRecordCorruptError;
}

/** What {@link claimRowAssets} reports; both are told which row the asset was found in. */
export interface RowClaimReports {
  /** A claim that failed. Check {@link isPermanentClaimFailure} to tell a repair from a retry. */
  readonly onFailure: (assetId: string, error: unknown, rowId: string) => void;
  /** A claim skipped as not this principal's to make; skipped quietly when this is absent. */
  readonly onSkipped?: ((assetId: string, error: unknown, rowId: string) => void) | undefined;
}

/**
 * Claims, under `holderOf(row.id)`, every managed asset the rows reference. Idempotent: a claim
 * already held is not changed. An asset the principal cannot see, or that is no longer available
 * (a reference a hook supplied, or an asset already gone), is skipped, and reported only to
 * `onSkipped`; any other failure goes to `onFailure` and the rest are still claimed.
 *
 * `alreadyClaimed` remembers the claims taken and also the ones that failed permanently, so a
 * claim that can never succeed is neither retried nor reported again for as long as the set lives.
 */
export async function claimRowAssets(
  assets: AssetService,
  principalId: string,
  holderOf: (rowId: string) => string,
  rows: Iterable<ClaimableRow>,
  reports: RowClaimReports,
  alreadyClaimed?: Set<string>,
): Promise<void> {
  for (const row of rows) {
    for (const assetId of managedAssetIdsOf(row)) {
      const holderId = holderOf(row.id);
      const key = `${holderId}\u0000${assetId}`;
      if (alreadyClaimed?.has(key)) continue;
      try {
        await assets.retain(assetId, { id: principalId }, { holderId, until: ROW_CLAIM_UNTIL });
        alreadyClaimed?.add(key);
      } catch (error) {
        if (isNotOurs(error)) {
          reports.onSkipped?.(assetId, error, row.id);
          continue;
        }
        if (isPermanentClaimFailure(error)) alreadyClaimed?.add(key);
        reports.onFailure(assetId, error, row.id);
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
  rows: Iterable<ClaimableRow>,
  onFailure: (assetId: string, error: unknown, rowId: string) => void,
  claimed?: Set<string>,
): Promise<void> {
  for (const row of rows) {
    for (const assetId of managedAssetIdsOf(row)) {
      const holderId = holderOf(row.id);
      claimed?.delete(`${holderId}\u0000${assetId}`);
      try {
        await assets.release(assetId, { id: principalId }, holderId);
      } catch (error) {
        if (!isNotOurs(error)) onFailure(assetId, error, row.id);
      }
    }
  }
}

/**
 * Releases every claim whose holder id starts with `holderPrefix`, found from the asset side
 * (COR-1664). Walking the rows a conversation still holds misses a row that compaction removed, a
 * session's rows once the session record is gone, and a run whose checkpoint cannot be read; the
 * claims themselves are always there. Each claim is released as the principal that owns its asset,
 * and one that is already gone is skipped quietly. Any other failure goes to `onFailure` and the
 * rest are still released. Returns how many claims it released, and forgets them in `claimed`.
 */
export async function releaseClaimsByHolderPrefix(
  assets: AssetService,
  holderPrefix: string,
  onFailure: (claim: AssetHeldClaim, error: unknown) => void,
  claimed?: Set<string>,
): Promise<number> {
  return releaseHeldClaims(assets, await assets.heldClaims({ holderPrefix }), onFailure, claimed);
}

/** Releases the claims already listed by {@link AssetService.heldClaims}; see {@link releaseClaimsByHolderPrefix}. */
export async function releaseHeldClaims(
  assets: AssetService,
  claims: Iterable<AssetHeldClaim>,
  onFailure: (claim: AssetHeldClaim, error: unknown) => void,
  claimed?: Set<string>,
): Promise<number> {
  let released = 0;
  for (const claim of claims) {
    claimed?.delete(`${claim.holderId}\u0000${claim.assetId}`);
    try {
      await assets.release(claim.assetId, { id: claim.ownerId }, claim.holderId);
      released += 1;
    } catch (error) {
      if (!isNotOurs(error)) onFailure(claim, error);
    }
  }
  return released;
}

/**
 * Releases the claims a run's rows actually hold (COR-1630), and nothing else. A run claims only
 * the rows its own walker reached (the rows it committed and the last row it was seeded with), so
 * an earlier seeded row's assets were never claimed under its holder, and `release` would still
 * emit `asset.released` for them: the asset service reports a release even when the holder held
 * nothing. Each candidate is therefore read first, as the principal with the privileged capability
 * (`references` exists only on the privileged projection), and released, as the plain principal,
 * only where `holderOf(row.id)` is among its references. That makes the pass the same for a run
 * recovered after a restart as for one that never left, with no record of what was claimed, and
 * idempotent: a second pass finds nothing held.
 *
 * A candidate the principal cannot inspect or release (not found, access denied, unavailable) is
 * not this run's to release and is skipped quietly. Any other failure goes to `onFailure` with the
 * asset and the row it was found in, and the remaining candidates are still released. Another
 * holder's claim on the same asset (a session that holds the same row, another run) is untouched.
 */
export async function releaseHeldRowAssetClaims(
  assets: AssetService,
  principalId: string,
  holderOf: (rowId: string) => string,
  rows: Iterable<ClaimableRow>,
  onFailure: (assetId: string, error: unknown, rowId: string) => void,
): Promise<void> {
  for (const row of rows) {
    const holderId = holderOf(row.id);
    for (const assetId of managedAssetIdsOf(row)) {
      try {
        const descriptor = await assets.inspect(
          assetId,
          { id: principalId, privileged: true },
          { projection: 'privileged' },
        );
        if (
          descriptor.projection !== 'privileged' ||
          !descriptor.retention.references.some((reference) => reference.holderId === holderId)
        ) {
          continue;
        }
        await assets.release(assetId, { id: principalId }, holderId);
      } catch (error) {
        if (!isNotOurs(error)) onFailure(assetId, error, row.id);
      }
    }
  }
}
