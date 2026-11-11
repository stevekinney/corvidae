import {
  isScheduledAgentRunInput,
  type JSONValue,
  type RecoveredRunHandle,
  type ScheduledAgentRunInput,
  type SessionStore,
  type SessionSummary,
  isFailureFinishReason,
} from '@lostgradient/operative';
import { decode, KEYS, isWeftErrorLike } from '@lostgradient/weft';
import { type RecoveredRunVerdict, type RecoveryRejectionReason } from './events';
import { decodeScheduleRunMarker } from './runtime-composition';
import { resolveDiagnosticSink, serializeUnknownError } from './serialization';
import {
  type CatalogRunSettlement,
  type DurableEndReader,
  type CatalogSettlementTracker,
  settlementForRejection,
} from './catalog-run-settlement';
import { settledTaskState } from './task-registry';
import type { DiagnosticSink } from './types';
import { ownEntry } from './own-entry';

/**
 * Returns whether a persisted session can still resume under transport-issued
 * authority. Terminal sessions retain their authority for auditability, but
 * must not defer boot recovery because no user code can resume from them.
 */
export function hasRecoverableTransportAuthority(metadata: Record<string, JSONValue>): boolean {
  if (metadata['lastRunStatus'] !== 'running') return false;
  const requiresTransportValidator = (revision: unknown): boolean =>
    typeof revision === 'string' && revision !== 'bureau:1' && revision !== 'bureau:scheduler:1';
  const lastRunId = metadata['lastRunId'];
  if (typeof lastRunId !== 'string' || !lastRunId) return false;
  const authorities = metadata['lastRequestAuthorities'];
  if (authorities && typeof authorities === 'object' && !Array.isArray(authorities)) {
    const activeAuthority = ownEntry(authorities as Record<string, JSONValue>, lastRunId);
    if (!activeAuthority || typeof activeAuthority !== 'object' || Array.isArray(activeAuthority)) {
      return false;
    }
    return requiresTransportValidator(
      (activeAuthority as Record<string, JSONValue>)['authorizationRevision'],
    );
  }
  const legacyAuthority = metadata['lastRequestAuthority'];
  if (!legacyAuthority || typeof legacyAuthority !== 'object' || Array.isArray(legacyAuthority)) {
    return false;
  }
  return requiresTransportValidator(
    (legacyAuthority as Record<string, JSONValue>)['authorizationRevision'],
  );
}

export function isTerminalApprovalBindingError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as Record<string, unknown>)['code'];
  return (
    code === 'expired' ||
    code === 'revoked' ||
    code === 'already-consumed' ||
    code === 'not-found' ||
    code === 'invalid-binding'
  );
}

export function emptyRecoveredStepMetadata(): Record<string, never> {
  return {};
}

/**
 * The session metadata boot recovery needs to decide a recovered run's fate,
 * loaded by id from the owning session. `null` ⇒ the session does not exist.
 */
export type RecoveredRunSessionMetadata = { lastRunId?: unknown; lastRunStatus?: unknown } | null;

/**
 * The outcome of loading a recovered run's owning session: a successful load
 * (the metadata, possibly `null` for "absent") or a transient read FAILURE that
 * leaves ownership UNKNOWN.
 */
export type SessionLoadOutcome = { ok: true; session: RecoveredRunSessionMetadata } | { ok: false };

/**
 * Decide what boot recovery does with one handle from `engine.recoverAll()`:
 *
 * - `reattach` — bureau-owned, in-flight, session-confirmed: wrap it in a live
 *   ActiveRun and register it.
 * - `monitor` — native scheduled fire: leave the recovered Weft workflow running
 *   and attach a detached result monitor, but do not register an ActiveRun because
 *   scheduled fires intentionally have no interactive session ownership.
 * - `cancel` — POSITIVELY not a reattachable bureau-owned in-flight run (bad/
 *   missing launch metadata, foreign run id, or a session that is absent / owns a
 *   different run / is already terminal). `engine.cancel` terminalizes it so it
 *   does not run unowned with no monitor.
 * - `skip` — ownership could NOT be confirmed (a transient session-load failure,
 *   or no session store): do NOTHING. `engine.cancel` is terminal, so we never
 *   cancel a run that may be legitimately recovering — the worst case is it
 *   resumes without live `getRun` visibility (the pre-#3 behaviour).
 *
 * Pure (no I/O) so every branch is unit-testable. `recoverAll()` fires the
 * services resolver synchronously per run before returning, and the resolver
 * reconciles a deps-unrebuildable run's session to `lastRunStatus: 'error'` — so
 * by the time this classifies, a session still `'running'` is one the resolver
 * kept. The gate is on SESSION status, NOT engine run-status: a run that
 * resolved-and-finished fast during `recoverAll` is terminal in the engine but its
 * session is still `'running'` (its monitor has not written yet), and it must
 * still be reattached so its completion is persisted.
 */
export interface ClassifyRecoveredRunArgs {
  handleId: string;
  /** Whether the launch metadata identifies a native scheduled fire. */
  scheduledFire: boolean;
  /** The narrowed agentRun input when the launch metadata is bureau-owned, else `undefined`. */
  ownedSessionId: string | undefined;
  /** Whether reading the handle's launch metadata threw. */
  metadataReadFailed: boolean;
  /** A session store is configured (recovery cannot reattach without one). */
  hasSessionStore: boolean;
  /** The session-load outcome; only meaningful when `ownedSessionId` is set + `hasSessionStore`. */
  sessionLoad: SessionLoadOutcome;
  /**
   * AB-10 — true when the durable engine flagged this run's checkpointed
   * `workflowVersion` as differing from the currently-registered one (see
   * `RuntimeComposition.workflowVersionMismatches`). Only changes the verdict
   * for what would otherwise be `'reattach'` — the run still reattaches
   * (pin-and-warn), it is just flagged distinctly so callers can log/alert on
   * the drift.
   */
  versionMismatch?: boolean;
  /**
   * COR-297 — the status of the run's durable record, when it was read. A `'pending'` record was
   * prepared and never launched, so a run that would otherwise reattach is cancelled instead
   * (`'prepared-not-launched'`). A terminal status (`RECOVERED_RUN_TERMINAL_STATUSES`) on a run
   * whose session is no longer running means a peer already finished the run, so there is nothing
   * to cancel (`'skip'`, COR-1916). Omitted, or any other status, changes nothing.
   */
  engineRecordStatus?: string;
}

/**
 * COR-1916 — the durable statuses a run never leaves. A recovered handle whose record already
 * reads one of these, with its session settled, was finished by a peer while this boot was
 * classifying it (a peer takes the claim of a process that stalled past its lease TTL).
 */
export const RECOVERED_RUN_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
]);

/**
 * `classifyRecoveredRun`'s verdict, plus — only when the verdict is
 * `'cancel'` — the structured reason (AB-90/ab90-09's `recovery.rejected`
 * payload). Both derived from the SAME branch pass over `args` as the plain
 * verdict below, so the verdict `emitter.dispatch`es as `recovery.attempted`
 * and the reason it dispatches as `recovery.rejected` can never drift apart.
 */
export function classifyRecoveredRunDetailed(args: ClassifyRecoveredRunArgs): {
  verdict: RecoveredRunVerdict;
  rejection?: RecoveryRejectionReason;
} {
  // A failed metadata read means we cannot even identify the run — but it WAS
  // resumed by recoverAll, so cancel it rather than leave it unowned.
  if (args.metadataReadFailed) {
    return { verdict: 'cancel', rejection: 'metadata-read-failed' };
  }
  if (args.ownedSessionId === undefined) {
    // A scheduled fire has no interactive session ownership to confirm. Weft has
    // already resumed it via the scheduled-fire resolver branch, so monitor its
    // result without registering it as an ActiveRun or cancelling it as foreign.
    if (args.scheduledFire) return { verdict: 'monitor' };
    // Not a bureau-owned agentRun (foreign run id / non-agentRun input) — cancel.
    return { verdict: 'cancel', rejection: 'foreign-input' };
  }
  // Owned input but no session store to confirm against / reattach into — skip.
  if (!args.hasSessionStore) return { verdict: 'skip' };
  // Transient session-load failure — ownership UNKNOWN, never cancel; skip.
  if (!args.sessionLoad.ok) return { verdict: 'skip' };
  const session = args.sessionLoad.session;
  // Session absent / owns a different run / not in-flight — positively unowned.
  if (!session) return { verdict: 'cancel', rejection: 'session-absent' };
  if (session.lastRunId !== args.handleId) {
    return { verdict: 'cancel', rejection: 'session-run-mismatch' };
  }
  if (session.lastRunStatus !== 'running') {
    // COR-1916 — session and record agree the run is over: a peer finished it after this boot
    // took its handle. Cancelling it would be a no-op and reporting it a recovery failure a lie.
    if (
      args.engineRecordStatus !== undefined &&
      RECOVERED_RUN_TERMINAL_STATUSES.has(args.engineRecordStatus)
    ) {
      return { verdict: 'skip' };
    }
    return { verdict: 'cancel', rejection: 'session-not-running' };
  }
  // A pending record never resumes, so a version mismatch is moot for it.
  if (args.engineRecordStatus === 'pending') {
    return { verdict: 'cancel', rejection: 'prepared-not-launched' };
  }
  return { verdict: args.versionMismatch ? 'reattach-version-mismatch' : 'reattach' };
}

/**
 * Plain-verdict view of {@link classifyRecoveredRunDetailed}, unchanged for
 * every existing caller and test — this wrapper exists only so the
 * rejection-reason derivation above has exactly one place to live.
 */
export function classifyRecoveredRun(args: ClassifyRecoveredRunArgs): RecoveredRunVerdict {
  return classifyRecoveredRunDetailed(args).verdict;
}

/**
 * Dedupes {@link BureauRecoveryReport.perRunFailures} by `runId`, keeping
 * the FIRST entry seen. A recovered handle whose owning session is absent/
 * mismatched/not-running is classified once by the awaited `onRecoveredWorkflow`
 * hook (during `recoverAll()`) and, because that verdict never registers an
 * `ActiveRun`, classified AGAIN by `recoverDurableRuns`'s own post-`recoverAll()`
 * pass over every unregistered handle — both classifications agree (nothing
 * about the handle changed between them), so without this dedupe the SAME
 * `{runId, reason}` would appear twice, violating the one-entry-per-handle
 * contract (code-review regression fixture, AB-349). Pure and exported for
 * direct unit testing, matching {@link classifyRecoveredRunDetailed}.
 */
export function dedupeRecoveryPerRunFailures(
  perRunFailures: readonly { readonly runId: string; readonly reason: string }[],
): { readonly runId: string; readonly reason: string }[] {
  const seen = new Set<string>();
  const deduped: { readonly runId: string; readonly reason: string }[] = [];
  for (const failure of perRunFailures) {
    if (seen.has(failure.runId)) continue;
    seen.add(failure.runId);
    deduped.push(failure);
  }
  return deduped;
}

export function isRecoverableScheduledFireInput(input: unknown): input is ScheduledAgentRunInput {
  return (
    isScheduledAgentRunInput(input) &&
    typeof input.scheduleId === 'string' &&
    input.scheduleId.trim().length > 0
  );
}

export async function loadScheduleIdForRecoveredRun(
  engine: { storage: { get(key: string): Promise<Uint8Array | null> } },
  workflowId: string,
): Promise<
  | { status: 'found'; scheduleId: string }
  | { status: 'missing' }
  | { status: 'read-error'; error: unknown }
> {
  try {
    const value = await engine.storage.get(KEYS.scheduleRun(workflowId));
    if (!value) return { status: 'missing' };
    const scheduleId = decodeScheduleRunMarker(decode(value));
    return scheduleId !== undefined ? { status: 'found', scheduleId } : { status: 'missing' };
  } catch (error) {
    return { status: 'read-error', error };
  }
}

export async function loadExistingScheduledSessionId(
  store: SessionStore,
  input: ScheduledAgentRunInput,
  runId: string,
): Promise<string | undefined> {
  if (input.sessionId !== undefined) {
    const session = await store.load(input.sessionId);
    return session?.metadata['lastScheduledFireRunId'] === runId ? input.sessionId : undefined;
  }
  const sessions = await store.list();
  return sessions.find(
    (session: SessionSummary) =>
      session.id.startsWith('sched-') &&
      session.id.endsWith(`-${runId}`) &&
      session.metadata['lastScheduledFireRunId'] === runId,
  )?.id;
}

/**
 * This engine's own disposal rejected a recovered run's handle. The run is still durable and the
 * next boot resumes it, so a shutdown is not reported as the run failing.
 */
function rejectedByOwnDisposal(error: unknown): boolean {
  return isWeftErrorLike(error) && error.code === 'EngineDisposedError';
}

export async function monitorRecoveredScheduledFire(
  handle: RecoveredRunHandle,
  diagnose: DiagnosticSink = resolveDiagnosticSink(undefined),
): Promise<void> {
  try {
    const result = await handle.result();
    if (
      typeof result === 'object' &&
      result !== null &&
      'finishReason' in result &&
      isFailureFinishReason(result.finishReason)
    ) {
      const errorMessage =
        'errorMessage' in result && typeof result.errorMessage === 'string'
          ? `: ${result.errorMessage}`
          : '';
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Recovered scheduled fire "${handle.id}" finished with ${String(result.finishReason)}${errorMessage}`,
      });
    }
  } catch (error) {
    if (rejectedByOwnDisposal(error)) return;
    diagnose({
      level: 'error',
      scope: 'recovery',
      message: `[bureau] Recovered scheduled fire "${handle.id}" failed: ${serializeUnknownError(error)}`,
    });
  }
}

/**
 * AB-240: the catalog-dispatch analog of {@link monitorRecoveredScheduledFire}.
 * A catalog run (`bureau.run(...)`) has no bureau session and — like a
 * scheduled fire — no interactive session surface, so a recovered one gets
 * the same headless detached-result monitor rather than the
 * session-ownership reattach path. A LIVE catalog run is registered on
 * `store` (COR-1302, `registerCatalogRun`) so `getRun`/`abortRun` resolve its
 * handle's id; a recovered one is not, and stays with this monitor.
 */
export async function monitorRecoveredCatalogRun(
  handle: RecoveredRunHandle,
  agentName: string,
  diagnose: DiagnosticSink = resolveDiagnosticSink(undefined),
  settled?: (settlement: CatalogRunSettlement) => Promise<void>,
  durableEnd?: DurableEndReader,
  tracker?: Pick<CatalogSettlementTracker, 'commit'>,
): Promise<void> {
  let ended: { readonly result: unknown } | { readonly error: unknown };
  try {
    ended = { result: await handle.result() };
  } catch (error) {
    ended = { error };
  }
  // The run's end is known, and what follows is storage work (the durable run's state, then every
  // listener's reads and writes). A shutdown waits for it however long the database takes.
  const commit =
    tracker?.commit ??
    (async (work: () => Promise<void>) => {
      await work();
      return true;
    });
  await commit(async () => {
    if ('result' in ended) {
      const { result } = ended;
      if (
        typeof result === 'object' &&
        result !== null &&
        'finishReason' in result &&
        isFailureFinishReason(result.finishReason)
      ) {
        const errorMessage =
          'errorMessage' in result && typeof result.errorMessage === 'string'
            ? `: ${result.errorMessage}`
            : '';
        diagnose({
          level: 'error',
          scope: 'recovery',
          message: `[bureau] Recovered catalog run "${handle.id}" (agent "${agentName}") finished with ${String(result.finishReason)}${errorMessage}`,
        });
      }
      const fields =
        typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
      const finishReason =
        typeof fields['finishReason'] === 'string' ? fields['finishReason'] : undefined;
      await settled?.({
        runId: handle.id,
        agentName,
        status: settledTaskState('completed', finishReason),
        finishReason: finishReason ?? null,
        message:
          typeof fields['errorMessage'] === 'string' ? fields['errorMessage'].slice(0, 1000) : null,
        content: typeof fields['content'] === 'string' ? fields['content'] : null,
        recovered: true,
      });
      return;
    }
    // A rejection is not an end: disposing the engine rejects the handle of a run that is still
    // running, and the next boot resumes it. Only a terminal state the durable run reached is
    // published (see `settlementForRejection`).
    const { error } = ended;
    const settlement = await settlementForRejection({
      runId: handle.id,
      agentName,
      error,
      recovered: true,
      durableEnd,
    });
    if (settlement === undefined && rejectedByOwnDisposal(error)) return;
    diagnose({
      level: 'error',
      scope: 'recovery',
      message:
        settlement === undefined
          ? `[bureau] Recovered catalog run "${handle.id}" (agent "${agentName}") is no longer followed, and its durable run is not over: ${serializeUnknownError(error)}`
          : `[bureau] Recovered catalog run "${handle.id}" (agent "${agentName}") failed: ${serializeUnknownError(error)}`,
    });
    if (settlement !== undefined) await settled?.(settlement);
  });
}
