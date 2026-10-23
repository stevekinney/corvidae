/**
 * COR-1664 — reconciles the retention claims a run or a session holds on managed assets against
 * what is left of the run or the session, from the asset side.
 *
 * A claim never lapses by itself (`assets/row-asset-claims.ts`), and the paths that release one
 * walk the rows a conversation still holds. Three cases leave a claim that no such walk reaches:
 *
 * - a row that history compaction removed, so a terminal run's final checkpoint no longer names it;
 * - a run that ended while its process died between the terminal commit and the release, which
 *   no settlement is published for again;
 * - a session deleted while a handoff or a drain was claiming for it.
 *
 * Both reconcilers read every claim under a holder kind once (`heldClaimsOf`), group them
 * by run or by session incarnation, and release the ones whose owner is over. They run at boot and
 * with durable maintenance, never reject, and are idempotent: a second pass finds nothing to release.
 *
 * ## What is a run's end
 *
 * | Durable state                       | Claims                                              |
 * | ----------------------------------- | --------------------------------------------------- |
 * | completed, failed, canceled         | released, unless it is a goal attempt of a live goal |
 * | in flight (running, suspended)      | kept: the run resumes                               |
 * | no durable record, or unreadable    | kept, and said once per run                         |
 *
 * A goal attempt of a goal that goes on is kept: the goal forwarder claims its rows for the goal's
 * session first and only then releases the run's, and releasing earlier would leave the next
 * attempt's seed without a claim. A recovery record that cannot be read cannot say whether the run
 * is a goal attempt, so it is kept as well.
 *
 * @module asset-claim-reconciliation
 */
import { heldClaimsOf } from './assets/internal-access';
import { releaseHeldClaims, runIdOfRowHolder, sessionOfRowHolder } from './assets/row-asset-claims';
import type { AssetHeldClaim, AssetService } from './assets/types';
import type { DurableEnd, DurableEndReader } from './catalog-run-settlement';
import type { CatalogRunRecoveryLoad } from './runtime-composition';
import { serializeUnknownError } from './serialization';
import type { DiagnosticSink } from './types';

/** What one reconciliation pass did. */
export interface AssetClaimReconciliationReport {
  /** The claims it released. */
  readonly released: number;
  /** The runs or sessions whose claims it left alone because the owner may still need them. */
  readonly kept: number;
}

export interface AssetClaimReconcilerDependencies {
  /** The asset service, or `undefined` for a Bureau without one: nothing was claimed then. */
  readonly assets: () => AssetService | undefined;
  /** Where a run stands in the durable engine. */
  readonly durableEnd: DurableEndReader;
  /** The recovery record of a catalog run, which says whether it is a goal attempt. */
  readonly loadRecoveryRecord: (runId: string) => Promise<CatalogRunRecoveryLoad>;
  /** Whether a goal is over for its attempts: terminal, canceled, or no longer stored. */
  readonly goalIsOver: (goalRunId: string) => Promise<boolean>;
  /**
   * Whether one incarnation of a session still exists. A session store that cannot say rejects,
   * and the session's claims are kept.
   */
  readonly sessionIsLive: (sessionId: string, incarnation: string) => Promise<boolean>;
  /** Whether releases are closed (shutdown has begun); a pass then does nothing. */
  readonly isClosed: () => boolean;
  /** Called with each claim about to be released, so the in-memory memo of claims taken forgets it. */
  readonly onReleased?: ((claim: AssetHeldClaim) => void) | undefined;
  readonly diagnose: DiagnosticSink;
}

export interface AssetClaimReconciler {
  /** Releases the claims of every run that is durably over. */
  reconcileRunClaims(): Promise<AssetClaimReconciliationReport>;
  /** Releases the claims of every session incarnation that no longer exists. */
  reconcileSessionClaims(): Promise<AssetClaimReconciliationReport>;
}

const NOTHING: AssetClaimReconciliationReport = { released: 0, kept: 0 };

/** Groups claims by a key, dropping the ones the key function does not recognize. */
function groupBy<Key extends string>(
  claims: readonly AssetHeldClaim[],
  keyOf: (claim: AssetHeldClaim) => Key | undefined,
): Map<Key, AssetHeldClaim[]> {
  const groups = new Map<Key, AssetHeldClaim[]>();
  for (const claim of claims) {
    const key = keyOf(claim);
    if (key === undefined) continue;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [claim]);
    else group.push(claim);
  }
  return groups;
}

const isTerminal = (end: DurableEnd): boolean =>
  end === 'completed' || end === 'failed' || end === 'canceled';

/** Creates the reconcilers. Every method resolves; none rejects. */
export function createAssetClaimReconciler(
  dependencies: AssetClaimReconcilerDependencies,
): AssetClaimReconciler {
  const { assets, durableEnd, loadRecoveryRecord, goalIsOver, sessionIsLive, isClosed, diagnose } =
    dependencies;
  /** Runs already said to be unreadable, so a maintenance timer does not repeat itself. */
  const reportedUnknown = new Set<string>();

  const warnOnce = (key: string, message: string, cause?: unknown): void => {
    if (reportedUnknown.has(key)) return;
    reportedUnknown.add(key);
    diagnose({
      level: 'warn',
      scope: 'assets',
      message,
      ...(cause === undefined ? {} : { cause }),
    });
  };

  async function release(
    service: AssetService,
    claims: readonly AssetHeldClaim[],
    owner: string,
  ): Promise<number> {
    for (const claim of claims) dependencies.onReleased?.(claim);
    return releaseHeldClaims(service, claims, (claim, error) =>
      diagnose({
        level: 'error',
        scope: 'assets',
        message: `[bureau] Could not release the retention claim of ${owner} on asset "${claim.assetId}": ${serializeUnknownError(error)}`,
        cause: error,
      }),
    );
  }

  /** Whether a run's claims can go: `true` to release, `false` to keep (and say so when unclear). */
  async function runIsOver(runId: string): Promise<boolean> {
    let end: DurableEnd;
    try {
      end = await durableEnd(runId);
    } catch (error) {
      warnOnce(
        `end:${runId}`,
        `[bureau] Could not read where run "${runId}" stands in the durable engine, so its retention claims on managed assets were kept: ${serializeUnknownError(error)}`,
        error,
      );
      return false;
    }
    if (end === 'in-flight') return false;
    if (end === 'not-durable') {
      warnOnce(
        `record:${runId}`,
        `[bureau] Run "${runId}" holds retention claims on managed assets but the durable engine has no record of it, so they were kept.`,
      );
      return false;
    }
    let loaded: CatalogRunRecoveryLoad;
    try {
      loaded = await loadRecoveryRecord(runId);
    } catch (error) {
      loaded = { status: 'read-error', error };
    }
    if (loaded.status === 'corrupt' || loaded.status === 'read-error') {
      warnOnce(
        `recovery:${runId}`,
        `[bureau] Could not read the recovery record of run "${runId}", so its retention claims on managed assets were kept.`,
        loaded.status === 'read-error' ? loaded.error : undefined,
      );
      return false;
    }
    // A run with no recovery record is not a goal attempt: a goal's start writes the record
    // before the attempt takes a step.
    const goalAttempt = loaded.status === 'found' ? loaded.record.goalAttempt : undefined;
    if (goalAttempt === undefined) return isTerminal(end);
    try {
      return isTerminal(end) && (await goalIsOver(goalAttempt.goalRunId));
    } catch (error) {
      warnOnce(
        `goal:${runId}`,
        `[bureau] Could not read goal "${goalAttempt.goalRunId}", so the retention claims of its attempt run "${runId}" on managed assets were kept: ${serializeUnknownError(error)}`,
        error,
      );
      return false;
    }
  }

  async function guarded(
    pass: (service: AssetService) => Promise<AssetClaimReconciliationReport>,
    failure: string,
  ): Promise<AssetClaimReconciliationReport> {
    const service = assets();
    if (service === undefined || isClosed()) return NOTHING;
    try {
      return await pass(service);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'assets',
        message: `[bureau] ${failure}: ${serializeUnknownError(error)}`,
        cause: error,
      });
      return NOTHING;
    }
  }

  return {
    reconcileRunClaims: () =>
      guarded(async (service) => {
        const claims = await heldClaimsOf(service, 'run-row:');
        let released = 0;
        let kept = 0;
        for (const [runId, held] of groupBy(claims, (claim) => runIdOfRowHolder(claim.holderId))) {
          if (isClosed()) break;
          if (await runIsOver(runId)) released += await release(service, held, `run "${runId}"`);
          else kept += 1;
        }
        return { released, kept };
      }, 'Could not reconcile the retention claims of runs on managed assets'),

    reconcileSessionClaims: () =>
      guarded(async (service) => {
        const claims = await heldClaimsOf(service, 'session-row:');
        let released = 0;
        let kept = 0;
        const groups = groupBy(claims, (claim) => {
          const holder = sessionOfRowHolder(claim.holderId);
          return holder === undefined
            ? undefined
            : `${encodeURIComponent(holder.sessionId)}:${encodeURIComponent(holder.incarnation)}`;
        });
        for (const held of groups.values()) {
          if (isClosed()) break;
          const holder = sessionOfRowHolder(held[0]!.holderId)!;
          let live: boolean;
          try {
            live = await sessionIsLive(holder.sessionId, holder.incarnation);
          } catch (error) {
            warnOnce(
              `session:${holder.sessionId}:${holder.incarnation}`,
              `[bureau] Could not read session "${holder.sessionId}", so its retention claims on managed assets were kept: ${serializeUnknownError(error)}`,
              error,
            );
            live = true;
          }
          if (live) kept += 1;
          else released += await release(service, held, `deleted session "${holder.sessionId}"`);
        }
        return { released, kept };
      }, 'Could not reconcile the retention claims of sessions on managed assets'),
  };
}
