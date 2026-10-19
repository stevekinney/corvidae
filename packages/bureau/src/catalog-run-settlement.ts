/**
 * The catalog-run settlement hook: one internal event that fires for every `bureau.run()` run
 * when it reaches a terminal state, whether it was dispatched by this process or recovered
 * after a restart.
 *
 * ## Why one hook
 *
 * A catalog run ends in one of two places. A fresh dispatch's handle resolves
 * `handle.result()` in the process that started it. A run recovered in flight has no handle
 * of the caller's; the AB-240 recovery monitor (`monitorRecoveredCatalogRun`) observes it end.
 * A consumer that wants to know a catalog run ended (the task registry settling a task, a
 * snapshot reference taking its final state) would otherwise have to watch both, and a
 * consumer that watched only the first silently missed every run that crossed a restart. This
 * hook is the single place both publish to, so a subscriber sees every catalog run end once,
 * from either path.
 *
 * ## Contract
 *
 * - {@link CatalogRunSettlementHook.publish} is called by Bureau, once per terminal state per
 *   run per process, after the run's result is known. A run that ends in a process that is
 *   then killed is published by the process that recovers it, if it is still in flight there,
 *   and is otherwise reconciled from the durable state at boot (task records only).
 * - A listener receives a {@link CatalogRunSettlement}: the run id, the agent, how it ended
 *   (`completed`, `failed` or `canceled`), the finish reason, a bounded error message for a
 *   failure, the answer text for a completed run, and whether the run was recovered.
 * - Listeners run in subscription order. One that throws or rejects is isolated (its failure
 *   goes to the diagnostic sink) and never stops the others or the publisher.
 * - `publish` resolves once every listener has settled, so a caller can wait for the writes a
 *   listener started. It never rejects.
 * - Not a public API: subscribers are inside this package, handed the hook by `createBureau`.
 *
 * @module catalog-run-settlement
 */
import type { DiagnosticSink } from './types';

/** How a catalog run ended. */
export interface CatalogRunSettlement {
  readonly runId: string;
  readonly agentName: string;
  readonly status: 'completed' | 'failed' | 'canceled';
  readonly finishReason: string | null;
  /** The failure's text, at most 1,000 characters, for a run that failed. */
  readonly message: string | null;
  /** The run's answer, for a run that completed with one. Unbounded: a subscriber bounds it. */
  readonly content: string | null;
  /** Whether this process recovered the run after a restart rather than dispatching it. */
  readonly recovered: boolean;
}

export type CatalogRunSettlementListener = (
  settlement: CatalogRunSettlement,
) => void | Promise<void>;

export interface CatalogRunSettlementHook {
  /** Calls `listener` for every catalog run that settles from now on. Returns its unsubscribe. */
  subscribe(listener: CatalogRunSettlementListener): () => void;
  /** Tells every subscriber that a catalog run settled. Never rejects. */
  publish(settlement: CatalogRunSettlement): Promise<void>;
}

/** Creates the hook. `diagnose` receives the failure of a listener that throws. */
export function createCatalogRunSettlementHook(diagnose: DiagnosticSink): CatalogRunSettlementHook {
  const listeners = new Set<CatalogRunSettlementListener>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async publish(settlement) {
      for (const listener of [...listeners]) {
        try {
          await listener(settlement);
        } catch (error) {
          diagnose({
            level: 'error',
            scope: 'catalog-run-settlement',
            message: `[bureau] A catalog-run settlement listener failed for run "${settlement.runId}": ${error instanceof Error ? error.message : String(error)}`,
            cause: error,
          });
        }
      }
    },
  };
}
