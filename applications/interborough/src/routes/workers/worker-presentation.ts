/**
 * Pure presentation-state derivation for worker/deployment rows (plan §9.9(1)
 * "runtime-state derivation pattern" — a priority-ordered pure function
 * instead of an if/else pile — adopted for the Workers track).
 *
 * ## Deliberately no "reconnecting (grace period)" state
 *
 * Plan §9.4 asks the UI to show "reconnecting (grace period)" for a worker
 * that drops and reconnects within `workerReconnectGracePeriodMs`
 * (`weft/src/server/serve-internals.ts`, clamped `[0, 5000]`, default ~2s)
 * rather than "flapping to disconnected". Traced against the wire
 * (`weft/src/server/runtime/authentication-bridge.ts`): during the grace
 * window the worker stays fully registered — same `WorkerSummary`, same
 * `health` — and `WorkerDisconnectedEvent` (`worker:disconnected`) fires
 * only AFTER the window expires and the requeue actually runs. There is no
 * wire-observable "this worker just entered its grace window" signal to
 * derive a distinct UI state from. Faking one off `heartbeatAgeMs` would be
 * wrong on its own terms (heartbeat cadence and the ~2s grace window are
 * unrelated timescales) and would misfire on real data — e.g. the design
 * mock's draining worker at a 1m12s heartbeat age, which must read
 * "Draining", never "reconnecting".
 *
 * What this module delivers instead is the requirement's actual intent:
 * never derive a client-side "disconnected" verdict for a worker present in
 * the current `weft.workers.list` snapshot — every function below only ever
 * classifies workers *that are in the list*, and callers must treat the
 * list itself (not a locally patched view) as truth. A per-worker
 * reconnecting/in-grace flag is a candidate follow-up on
 * https://github.com/stevekinney/weft/issues/729, not something to
 * approximate client-side.
 */
import type { WorkerSummary } from './worker-catalog-types.ts';

export type WorkerHealthLabel = 'Healthy' | 'Draining' | 'Drained' | 'Stale';
export type PresentationVariant = 'success' | 'warning' | 'danger' | 'neutral';

export interface HealthPresentation {
  readonly label: WorkerHealthLabel;
  readonly variant: PresentationVariant;
}

export type HeartbeatSeverity = 'fresh' | 'elevated' | 'stale';

/**
 * Conservative fixed thresholds (plan §9.4: "heartbeat staleness … relative
 * color thresholds"). `WorkerSummary` reports no per-worker heartbeat
 * interval to derive an exact multiple from, so these are documented
 * defaults rather than a computed ratio — widen/narrow here if a future
 * catalog change adds one.
 */
export const HEARTBEAT_ELEVATED_AFTER_MS = 30_000;
export const HEARTBEAT_STALE_AFTER_MS = 120_000;

/** Three-tier heartbeat freshness, independent of drain state (used for the heartbeat column's color only — see `workerHealthPresentation` for the combined badge). */
export function heartbeatSeverity(heartbeatAgeMs: number): HeartbeatSeverity {
  if (heartbeatAgeMs >= HEARTBEAT_STALE_AFTER_MS) return 'stale';
  if (heartbeatAgeMs >= HEARTBEAT_ELEVATED_AFTER_MS) return 'elevated';
  return 'fresh';
}

/**
 * Priority-ordered worker health presentation: draining > drained > stale
 * heartbeat > healthy. Matches `design/Weft UI.dc.html`'s workers
 * screens, where a draining worker keeps its "Draining" badge regardless of
 * heartbeat age (draining stops new-task assignment; it does not itself
 * stop heartbeats) and only an `active` worker's heartbeat can promote it to
 * "Stale".
 */
export function workerHealthPresentation(worker: WorkerSummary): HealthPresentation {
  if (worker.health === 'draining') return { label: 'Draining', variant: 'warning' };
  if (worker.health === 'drained') return { label: 'Drained', variant: 'neutral' };
  if (heartbeatSeverity(worker.heartbeatAgeMs) === 'stale') {
    return { label: 'Stale', variant: 'danger' };
  }
  return { label: 'Healthy', variant: 'success' };
}

/** What the line under the Workers list's title counts. A figure left out is one that could not be read. */
export interface WorkersSummaryInput {
  readonly workers: readonly WorkerSummary[];
  /** Tasks waiting in the queues; undefined while the queues have not been read, or could not be. */
  readonly waiting?: number | undefined;
  /** Tasks that failed for good (dead-lettered); undefined while the diagnostics have not been read. */
  readonly failedForGood?: number | undefined;
}

/**
 * The one line under the Workers list's title, such as `3 of 4 connected · 7 running · 12 waiting ·
 * 2 failed for good`. A worker is connected unless it has drained (a drained worker has left);
 * running is the tasks the workers hold now.
 */
export function workersSummaryLine(input: WorkersSummaryInput): string {
  const connected = input.workers.filter((worker) => worker.health !== 'drained').length;
  const running = input.workers.reduce((total, worker) => total + worker.inFlight, 0);
  const parts = [`${String(connected)} of ${String(input.workers.length)} connected`];
  parts.push(`${String(running)} running`);
  if (input.waiting !== undefined) parts.push(`${String(input.waiting)} waiting`);
  if (input.failedForGood !== undefined) {
    parts.push(`${String(input.failedForGood)} failed for good`);
  }
  return parts.join(' · ');
}

/** Backlog color per the design mock's `queuedColor`: danger above 50 queued, warning above 0, neutral at 0. */
export function queueBacklogVariant(queued: number): PresentationVariant {
  if (queued > 50) return 'danger';
  if (queued > 0) return 'warning';
  return 'neutral';
}

export type WorkerTransport = WorkerSummary['transport'];

/** How a transport reads in the console: spelled out, never a bare code. */
export const TRANSPORT_LABEL: Readonly<Record<WorkerTransport, string>> = {
  websocket: 'WebSocket',
  'long-poll': 'HTTP long-poll',
};

/** The behavioral limit that makes a long-poll worker different from a WebSocket one, in one sentence. */
export const LONG_POLL_LIMITATION =
  'HTTP long-poll workers have no server push: new work reaches them only when they poll, and a cancellation reaches them on their next activity heartbeat, so this view shows them as of their last poll or heartbeat rather than live.';

/** Workers per transport, so a fleet that mixes both says so. */
export function countByTransport(
  workers: readonly Pick<WorkerSummary, 'transport'>[],
): Readonly<Record<WorkerTransport, number>> {
  const counts: Record<WorkerTransport, number> = { websocket: 0, 'long-poll': 0 };
  for (const worker of workers) counts[worker.transport] += 1;
  return counts;
}
