/**
 * COR-1630 — releases the claims a catalog run holds on managed assets when the run ends.
 *
 * A catalog run has no session, so it holds the assets its own rows reference under the holder
 * `run-row:<run id>:<row id>` (`assets/row-asset-claims.ts`), with a claim that never lapses by
 * itself. Nothing let those claims go, so every asset a run touched was kept for ever. This is the
 * one step that does, and it has three owners:
 *
 * - the catalog dispatcher, for a run this process dispatched and watched (`bureau.run()`, a
 *   child run, a workflow step), through {@link CatalogRunAssetReleaser.releaseAfterHandle};
 * - the catalog-run settlement hook, for a run recovered after a restart
 *   ({@link CatalogRunAssetReleaser.releaseAfterRecovery}), and for a recovered goal attempt whose
 *   goal is already over;
 * - the goal forwarder, for a goal attempt of a goal that goes on, after the goal's session holds the attempt's rows
 *   ({@link CatalogRunAssetReleaser.releaseConversation} and
 *   {@link CatalogRunAssetReleaser.releaseEndedRun}).
 *
 * The dispatcher skips a goal attempt, and the hook skips one whose goal is still going, so each
 * `(run, row, asset)` pair is released once; the step is idempotent anyway, because it releases
 * only the pairs the asset's own records show as held.
 *
 * ## What is an end
 *
 * A handle that settles is not always a run that ended. A run cut short by disposing the engine,
 * or one this process lost to another engine over the same store, resolves with an
 * interrupted-shaped `aborted` result while its durable record stays in flight, and the next boot
 * or the engine that owns the run carries on. Those release nothing, so the durable record is read
 * after the handle settles and only a terminal state releases. A run with no durable record at all
 * (a Bureau with no durable engine) ends when its handle settles.
 *
 * ## Shutdown
 *
 * The rule holds at shutdown too: a run that has durably ended releases, and a run that will
 * resume does not. `shutdown()` with the default `abort` policy aborts every tracked catalog run,
 * which cancels its durable workflow for good (record `cancelled`, task `canceled`, never resumed),
 * and a run that completed while a `drain` shutdown waited for it has ended as well, so both
 * release. A run whose durable record still reads running or suspended when the engine goes away
 * (a goal attempt, a workflow step, a run recovered at boot) is lost, not ended: it releases
 * nothing and keeps its claims for the boot that resumes it. A release that is under way when
 * shutdown starts is awaited, under the grace `shutdown()` gives aborted runs, before the asset
 * service closes; after that point {@link CatalogRunAssetReleaserDependencies.isClosed} is true
 * and a release does nothing, so none runs against a closed service.
 *
 * @module catalog-run-asset-release
 */
import { releaseHeldRowAssetClaims, runRowHolderId } from './assets/row-asset-claims';
import type { ClaimableRow } from './assets/row-asset-claims';
import type { AssetService } from './assets/types';
import type { CatalogRunSettlement, DurableEnd, DurableEndReader } from './catalog-run-settlement';
import type { CatalogRunRecoveryLoad } from './runtime-composition';
import { serializeUnknownError } from './serialization';
import type { DiagnosticSink } from './types';

/** The rows of a finished run, as the walker reads them: hidden ones included. */
export interface ReleasableConversation {
  getMessages(options?: { includeHidden?: boolean }): ReadonlyArray<ClaimableRow>;
}

/** What the durable engine and checkpoint hold of a run, read without driving it. */
export type EndedRunConversation =
  /** The run ended; this is the conversation its checkpoint holds. */
  | { readonly status: 'ended'; readonly conversation: ReleasableConversation }
  /** The run is going, parked or suspended. */
  | { readonly status: 'running' }
  /** The engine has no such run. */
  | { readonly status: 'missing' };

/** How a handle the dispatcher watched settled. */
export type SettledCatalogHandle =
  | {
      readonly kind: 'result';
      readonly finishReason: string | undefined;
      readonly conversation: ReleasableConversation;
    }
  | { readonly kind: 'rejected' };

export interface CatalogRunAssetReleaserDependencies {
  /** The asset service, or `undefined` for a Bureau without one: nothing was claimed then. */
  readonly assets: () => AssetService | undefined;
  /** Where the run stands in the durable engine; see {@link DurableEndReader}. */
  readonly durableEnd: DurableEndReader;
  /** Reads an ended run's conversation from its checkpoint. Rejects when it cannot be read. */
  readonly readEnded: (runId: string) => Promise<EndedRunConversation>;
  /**
   * Whether releases are closed: `shutdown()` sets it once it has waited for the releases under
   * way, just before the asset service goes. A release that starts afterwards does nothing.
   */
  readonly isClosed: () => boolean;
  readonly diagnose: DiagnosticSink;
}

/** The run a pass releases for: the principal is the one its claims were taken as. */
interface RunClaims {
  readonly runId: string;
  readonly principalId: string;
}

export interface CatalogRunAssetReleaser {
  /** A handle the dispatcher watched settled. Releases only when the run actually ended. */
  releaseAfterHandle(run: RunClaims & { readonly settled: SettledCatalogHandle }): Promise<void>;
  /** A recovered run published its settlement. Reads its conversation from its checkpoint. */
  releaseAfterRecovery(run: RunClaims): Promise<void>;
  /** Releases the held pairs of `conversation`; the caller has decided the run ended. */
  releaseConversation(
    run: RunClaims & { readonly conversation: ReleasableConversation },
  ): Promise<void>;
  /** Releases an ended run's held pairs, reading its conversation; nothing if it has not ended. */
  releaseEndedRun(run: RunClaims): Promise<void>;
}

/** Creates the step. Every method resolves; none rejects, so no caller needs a guard. */
export function createCatalogRunAssetReleaser(
  dependencies: CatalogRunAssetReleaserDependencies,
): CatalogRunAssetReleaser {
  const { assets, durableEnd, readEnded, isClosed, diagnose } = dependencies;

  const warn = (message: string, cause?: unknown): void =>
    diagnose({
      level: 'warn',
      scope: 'assets',
      message,
      ...(cause === undefined ? {} : { cause }),
    });

  /** Where the run stands, with a read that fails counted as still going, and said so. */
  async function endOf(runId: string): Promise<DurableEnd> {
    try {
      return await durableEnd(runId);
    } catch (error) {
      warn(
        `[bureau] Could not read where run "${runId}" stands in the durable engine, so it is treated as still going and its retention claims on managed assets were not released: ${serializeUnknownError(error)}`,
        error,
      );
      return 'in-flight';
    }
  }

  async function releaseConversation(
    run: RunClaims & { readonly conversation: ReleasableConversation },
  ): Promise<void> {
    const service = assets();
    if (service === undefined || isClosed()) return;
    let rows: ReadonlyArray<ClaimableRow>;
    try {
      rows = run.conversation.getMessages({ includeHidden: true });
    } catch (error) {
      warn(
        `[bureau] Could not read the conversation of run "${run.runId}", so its retention claims on managed assets were not released: ${serializeUnknownError(error)}`,
        error,
      );
      return;
    }
    await releaseHeldRowAssetClaims(
      service,
      run.principalId,
      (rowId) => runRowHolderId(run.runId, rowId),
      rows,
      (assetId, error, rowId) =>
        warn(
          `[bureau] Could not release the retention claim of run "${run.runId}" on asset "${assetId}" in row "${rowId}": ${serializeUnknownError(error)}`,
          error,
        ),
    );
  }

  async function releaseEndedRun(run: RunClaims): Promise<void> {
    if (assets() === undefined || isClosed()) return;
    let reading: EndedRunConversation;
    try {
      reading = await readEnded(run.runId);
    } catch (error) {
      warn(
        `[bureau] Could not read the conversation of run "${run.runId}", so its retention claims on managed assets were not released: ${serializeUnknownError(error)}`,
        error,
      );
      return;
    }
    if (reading.status !== 'ended') return;
    await releaseConversation({ ...run, conversation: reading.conversation });
  }

  return {
    async releaseAfterHandle({ runId, principalId, settled }) {
      if (assets() === undefined || isClosed()) return;
      const end = await endOf(runId);
      if (end === 'in-flight' || isClosed()) return;
      if (settled.kind === 'result') {
        await releaseConversation({ runId, principalId, conversation: settled.conversation });
        return;
      }
      if (end === 'not-durable') {
        // A run that rejected and left no durable record has no conversation to read.
        warn(
          `[bureau] Run "${runId}" ended with an error and left no conversation to read, so its retention claims on managed assets were not released.`,
        );
        return;
      }
      await releaseEndedRun({ runId, principalId });
    },

    async releaseAfterRecovery({ runId, principalId }) {
      if (assets() === undefined || isClosed()) return;
      await releaseEndedRun({ runId, principalId });
    },

    releaseConversation,
    releaseEndedRun,
  };
}

/** What the recovered-run listener reads from the Bureau around it. */
export interface RecoveredRunReleaseDependencies {
  readonly releaser: Pick<CatalogRunAssetReleaser, 'releaseAfterRecovery'>;
  readonly loadRecoveryRecord: (runId: string) => Promise<CatalogRunRecoveryLoad>;
  /**
   * Whether a goal is over for its attempts: terminal, canceled, or no longer stored. A goal that
   * is over has no forwarder left to release its recovered attempt's claims.
   */
  readonly goalIsOver: (goalRunId: string) => Promise<boolean>;
  /** The principal id a run's claims were taken as. */
  readonly ownerOf: (principal: string | undefined) => string;
  readonly diagnose: DiagnosticSink;
}

/**
 * The hook listener that releases a recovered run's claims when it ends. A fresh dispatch is
 * released where it is dispatched, and a goal attempt by the goal forwarder, so this one acts on
 * a recovered publication only, and skips a goal attempt unless its goal is over, which leaves no
 * forwarder to release it. A recovery record that cannot be read
 * cannot say whether the run is a goal attempt, and releasing a goal attempt's claims before its
 * session holds them would leave the next attempt's seed unclaimed, so it releases nothing.
 */
export function createRecoveredRunReleaseListener({
  releaser,
  loadRecoveryRecord,
  goalIsOver,
  ownerOf,
  diagnose,
}: RecoveredRunReleaseDependencies): (settlement: CatalogRunSettlement) => Promise<void> {
  return async (settlement) => {
    if (!settlement.recovered) return;
    let loaded: CatalogRunRecoveryLoad;
    try {
      loaded = await loadRecoveryRecord(settlement.runId);
    } catch (error) {
      loaded = { status: 'read-error', error };
    }
    if (loaded.status !== 'found') {
      diagnose({
        level: 'warn',
        scope: 'assets',
        message: `[bureau] Could not read the recovery record of run "${settlement.runId}", so its retention claims on managed assets were not released.`,
      });
      return;
    }
    const { goalAttempt } = loaded.record;
    if (goalAttempt !== undefined) {
      // A goal attempt is released by the goal forwarder while its goal goes on. A goal that is
      // over (terminal, canceled or gone) has no forwarder to do it: recovery stops the attempt's
      // run without watching it, so this is the only place its claims can be let go.
      let over: boolean;
      try {
        over = await goalIsOver(goalAttempt.goalRunId);
      } catch (error) {
        diagnose({
          level: 'warn',
          scope: 'assets',
          message: `[bureau] Could not read goal "${goalAttempt.goalRunId}", so the retention claims of its recovered attempt run "${settlement.runId}" on managed assets were not released: ${serializeUnknownError(error)}`,
          cause: error,
        });
        return;
      }
      if (!over) return;
    }
    await releaser.releaseAfterRecovery({
      runId: settlement.runId,
      principalId: ownerOf(loaded.record.principal),
    });
  };
}
