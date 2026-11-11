/**
 * Sessions (COR-2376 slice S9): list, read and rename a session, delete one (with its runs, durable
 * records and asset claims) through the deletion owner record, abandon a session's runs, and claim,
 * release and reconcile the assets a session holds. Built by `constructBureau` and reached only
 * through `createBureau`; maintenance, the outbox, the child runs and task start call into it.
 */
import {
  type ActiveRun,
  type AgentSession,
  type CleanupAcknowledgement as RunCleanupAcknowledgement,
  SESSION_OWNER_METADATA_KEY,
  SESSION_TITLE_METADATA_KEY,
  SESSION_TITLE_OVERRIDE_LIMIT,
  type SessionListOptions,
  type SessionStore,
  sessionOriginOf,
  summarizeSession,
} from '@lostgradient/operative';
import { type AgUiLease, createAgUiLeases, releaseQuietly } from '../http/ag-ui-lease';
import type { AgentDefinitions } from '../agent-catalog';
import type { BureauCore, SessionDeletionRecord } from './core';
import { BureauError, BureauShuttingDownError } from '../bureau-errors';
import type { BureauSteeringGate } from '../steering';
import type { ChatAsset } from '../chat-asset-purge';
import { ChatRunsNotEndedError, type DeletedChat } from '../chat-content-purge';
import type { ConditionalTextValueStore } from '@lostgradient/storage';
import type { ContextDeletionReport, RunSummary } from '../types';
import type { RunMemoryPlacement } from '../chat-memory-purge';
import { THREAD_LEASE_RETRY_MILLISECONDS } from '../bureau-construction-support';
import {
  claimRowAssets,
  isPermanentClaimFailure,
  managedAssetIdsOf,
  releaseClaimsByHolderPrefix,
  releaseRowAssetClaims,
  sessionRowHolderId,
  sessionRowHolderPrefix,
} from '../assets/row-asset-claims';
import { deleteSteeringLog } from '../steering-log';
import { heldClaimsOf } from '../assets/internal-access';
import {
  isPlainAuthorityRecord,
  resolveRunMemoryOwner,
  resolveSessionOwner,
} from '../session-authority';
import { ownerOrLocal } from '../owner-of-record';
import { runtimeWorkspaceOwnerAuthority } from '../http/workspace-principal.ts';
import { serializeUnknownError } from '../serialization';
import { writeContextTombstone } from '../context-tombstone';

/** The callables sessions reads from elsewhere in `constructBureau`. */
export interface SessionsPeers {
  /** The ids of the runs a session has persisted approvals for. */
  readonly persistedApprovalRunIds: (metadata: unknown) => Set<string>;
  /** The session id of a run this process holds. */
  readonly getRunSessionIdentifier: (runState: { activeRun: ActiveRun }) => string;
  /** Resolves once the active run of a session is terminal. */
  readonly whenActiveRunTerminal: (activeRun: ActiveRun) => Promise<void>;
  /** Drains the outbox of a session. */
  readonly drainOutbox: () => Promise<void>;
  /** Aborts a run. */
  readonly abortRun: (id: string, reason?: string) => RunSummary;
  /** Revokes the pending approvals of a run. */
  readonly revokePendingApprovalsForRun: (
    runId: string,
    outcome: { status: 'canceled' | 'revoked'; principal: string },
  ) => Promise<void>;
  /** Retires the inputs a session has queued. */
  readonly retireSessionInputs: (sessionId: string, incarnation: string) => Promise<void>;
  /** `runtime.kv`, when this Bureau keeps durable steering. */
  readonly durableSteeringStore: () => ConditionalTextValueStore | undefined;
  /** Runs an operation after every earlier steering log operation for the session. */
  readonly enqueueSteering: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;
  /** Drops the steering state of a session. */
  readonly forgetSessionSteering: (sessionId: string) => void;
  /** Discards the tried runs of a session. */
  readonly discardTriedRuns: (
    session: AgentSession,
    knownRunIds: ReadonlySet<string>,
  ) => Promise<void>;
  /** The session store, or a refusal when there is none. */
  readonly requireSessionStore: () => SessionStore;
}

/** Builds the sessions of one Bureau. Synchronous, and registers nothing. */
export function createSessions<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: SessionsPeers,
) {
  const {
    workspace,
    assetServiceHolder,
    runtimeServices,
    store,
    runtime,
    diagnose,
    dropPendingApprovalOverride,
    runToolboxesByRunId,
    releaseRunScope,
    orphanedRunIds,
    reviewResolutionCleanupPending,
    pendingApprovalOverrides,
    terminalReviewSessions,
    invalidApprovalReviewIds,
    steeringGates,
    steeringCursors,
    runRequestContexts,
    inFlightSessionDeletions,
    sessionDeletionOwners,
  } = core;

  async function listSessions(requestOptions?: SessionListOptions) {
    // COR-1911 — the contexts of agents being tried are not among a person's chats, goals and
    // fires unless they are asked for by origin.
    return peers.requireSessionStore().list({
      excludeOrigins: ['try'],
      ...requestOptions,
    });
  }

  async function getSession(id: string) {
    return peers.requireSessionStore().load(id);
  }

  // COR-1909: a title a person gave the session lives in its metadata, under a key of its own, so
  // clearing it is removing the key and the summary reads the derived title again. The write is
  // one `update()` that does not refresh `updatedAt`: a rename is not activity, and must not
  // reorder the listing or keep a session from expiring.
  async function renameSession(
    id: string,
    title: string | null,
    renameOptions?: { readonly incarnation?: string | undefined },
  ): Promise<AgentSession | undefined> {
    const sessions = peers.requireSessionStore();
    if (core.runAdmissionClosed) {
      throw new BureauShuttingDownError(
        'Cannot rename: Bureau is shutting down.',
        runtimeServices.clock.nowISO(),
      );
    }
    const trimmed = title === null ? null : title.trim();
    if (trimmed !== null && (trimmed === '' || trimmed.length > SESSION_TITLE_OVERRIDE_LIMIT)) {
      throw new BureauError(
        `A session title is 1 to ${SESSION_TITLE_OVERRIDE_LIMIT} characters, or null to clear it`,
        'BAD_REQUEST',
      );
    }
    return sessions.update(
      id,
      (session) => {
        if (session === undefined) return undefined;
        if (
          renameOptions?.incarnation !== undefined &&
          session.incarnation !== renameOptions.incarnation
        ) {
          return undefined;
        }
        const { [SESSION_TITLE_METADATA_KEY]: _replaced, ...rest } = session.metadata;
        return {
          ...session,
          metadata: trimmed === null ? rest : { ...rest, [SESSION_TITLE_METADATA_KEY]: trimmed },
        };
      },
      { refreshActivity: false },
    );
  }

  // AB-228 (Codex P2 review finding, PR #566): two concurrent
  // `deleteSession(id)` calls can both observe a truthy `session` from
  // their own `sessionStore.load(id)` before either has actually deleted
  // it. Coalescing concurrent calls for the same id onto a single
  // in-flight promise makes exactly one of them actually run
  // `performDeleteSession`; every other concurrent caller within THIS
  // process awaits that same result instead of starting a second,
  // redundant run. A call that arrives strictly AFTER the first has
  // already settled (id reused, or genuinely deleting again) is
  // unaffected — the map entry is cleared in `finally`, so it starts a
  // fresh `performDeleteSession`. This in-flight map is a process-local
  // fast path only, not the source of truth for whether a durable
  // `session.deleted` record and notification should be produced: two
  // separate BUREAU PROCESSES sharing one persistent backend under the
  // supported `durableOwnership: { ownership: 'workflow-lease' }`
  // configuration do not share this map and can both reach
  // `performDeleteSession` for the same id at the same moment.
  //
  // AB-371: that cross-process race is resolved by `SessionStore.delete`
  // itself, whose contract now resolves `boolean` — `true` only for the
  // call whose own atomic delete-and-count actually removed a live
  // record, `false` for every other caller (already gone, or never
  // existed). `performDeleteSession` dispatches `SessionDeletedEvent` (and
  // so the durable audit record it feeds) only when `sessionStore.delete`
  // returns `true`, so exactly one of the two racing processes produces
  // the record and the notification, regardless of what either observed
  // from its own `sessionStore.load(id)` beforehand. The other cleanup in
  // this function (revoking approvals, aborting or releasing this
  // process's own live runs, discarding this process's steering gate)
  // still runs unconditionally for whichever process actually holds a
  // truthy `session` from its own load — each process only knows about
  // its own in-memory run state, so that cleanup could never be skipped
  // just because a peer process happened to win the durable delete.
  // AB-228 (Codex follow-up review finding, PR #566): the coalescing slot
  // above is released as soon as `sessionStore.delete(id)` itself commits
  // (`onStoreDeletionCommitted` below), NOT when the whole function
  // finally resolves. `performDeleteSession`'s tail after that point
  // (releasing a paused run's steering gate, awaiting its terminal event)
  // is cleanup for the OLD, now-actually-deleted incarnation — holding the
  // coalescing slot open through it would make a `deleteSession(id)` call
  // for a session RECREATED with the same id, arriving during that tail,
  // silently resolve against the OLD promise instead of ever deleting the
  // NEW session. `releaseCoalescing` is reset to a no-op the first time it
  // runs (either via the commit callback or the `finally` safety net for
  // the never-existed-session path / a thrown error before commit) so it
  // never double-clears an entry a later, unrelated call may already own.
  /**
   * COR-1934 — removes one run's durable workflow and its checkpoints. A workflow that is not
   * terminal is skipped by the engine's purge.
   */
  async function purgeDurableRun(runId: string): Promise<void> {
    const durable = runtime.durable;
    if (durable === undefined) return;
    // By exact id: a prefix purge would take `…-run-10` with `…-run-1`, and refuses a documented
    // custom child id such as `order:42`.
    const purged = await durable.engine.purgeById(runId);
    // `false` is also what a lost compare-and-set, a run that began again, or a finalizer still
    // owed answer. A workflow that is still stored is then the run's content left behind: the step
    // fails, so the pending record stays and the next pass retries, and its checkpoints stay with
    // it, since the id may by now be another run's.
    if (!purged && (await durable.engine.get(runId)) !== null) {
      throw new Error(`The durable workflow of run "${runId}" was not purged and is still stored`);
    }
    await durable.checkpointStore.clear(runId);
  }

  /** The statuses after which a durable workflow no longer changes. */
  const isTerminalDurableStatus = (status: string): boolean =>
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timed-out';

  /**
   * COR-1934 — the runs the given runs delegated to, directly or through other children, breadth
   * first, so a child comes before its own children; none of the given runs is repeated.
   */
  async function descendantRunIdsOf(parents: readonly string[]): Promise<string[]> {
    const found: string[] = [];
    const seen = new Set(parents);
    const queue = [...parents];
    for (let index = 0; index < queue.length; index += 1) {
      for (const child of await core.childTopologyStore.listByParent(queue[index]!)) {
        if (seen.has(child.childRunId)) continue;
        seen.add(child.childRunId);
        found.push(child.childRunId);
        queue.push(child.childRunId);
      }
    }
    return found;
  }

  /**
   * COR-1934 — every run of a chat about to be deleted: the runs this process holds for it, the
   * runs its ownership map names (pruned once a run's history expires), and its task records,
   * the complete list. A list that cannot be read fails the delete before anything is removed,
   * because a partial one would leave a run's content behind for good.
   */
  async function chatRunIdsOf(session: AgentSession): Promise<string[]> {
    const runIds = new Set<string>();
    for (const [, runState] of store.getState().runs) {
      if (peers.getRunSessionIdentifier(runState) === session.id) runIds.add(runState.id);
    }
    const owners = session.metadata['lastRunOwningPrincipals'];
    if (isPlainAuthorityRecord(owners)) for (const runId of Object.keys(owners)) runIds.add(runId);
    for (const taskId of await core.tasks.taskIdsOfContext(session.id, session.incarnation)) {
      runIds.add(taskId);
    }
    // Children the chat's runs delegated to hold its words too (COR-1934); the purge reads the
    // topology again on every pass, so one dispatched after this is found as well.
    for (const child of await descendantRunIdsOf([...runIds])) runIds.add(child);
    return [...runIds];
  }

  function deleteSession(
    id: string,
    deleteOptions?: {
      readonly incarnation?: string | undefined;
      readonly actor?: string | undefined;
    },
  ): Promise<ContextDeletionReport> {
    return startSessionDeletion(id, {
      incarnation: deleteOptions?.incarnation,
      actor: deleteOptions?.actor,
    });
  }

  /**
   * {@link deleteSession}, and for a retention sweep `idleBefore`: the chat is deleted only if,
   * read again under its thread lease, its last activity is still before that time and it has no
   * live task, and the store delete is then fenced to the incarnation read there. A chat that was
   * active since the sweep listed it is kept, with no tombstone, and deletes nothing.
   */
  async function startSessionDeletion(
    id: string,
    deleteOptions: {
      readonly incarnation?: string | undefined;
      readonly actor?: string | undefined;
      readonly idleBefore?: number | undefined;
    },
  ): Promise<ContextDeletionReport> {
    const existing = inFlightSessionDeletions.get(id);
    if (existing) return existing;
    let releaseCoalescing: (() => void) | undefined = () => {
      inFlightSessionDeletions.delete(id);
    };
    const deletion = performDeleteSession(
      id,
      deleteOptions.incarnation,
      () => {
        releaseCoalescing?.();
        releaseCoalescing = undefined;
      },
      deleteOptions.actor,
      deleteOptions.idleBefore,
    ).finally(() => {
      releaseCoalescing?.();
      releaseCoalescing = undefined;
    });
    inFlightSessionDeletions.set(id, deletion);
    return deletion;
  }

  /**
   * COR-718 — who owned a session at the moment it was deleted, kept for the
   * `session.deleted` audit entry. The deleted session's body is gone by the time
   * that entry is written (possibly in another process, after a restart), and its
   * id may be recreated under another owner, so the entry carries the owner in its
   * `detail`. Operative's session store knows nothing of owners, so Bureau writes
   * the owner to its own store, keyed by session id and incarnation, before the
   * store delete; the outbox drain reads it back into memory before it dispatches
   * the event, and removes it once the audit entry is verified and the outbox
   * entry acknowledged.
   *
   * It is written only when an audit trail exists to consume it, and a deletion,
   * by `deleteSession` or by the store's own `cleanup()`, does not go ahead when
   * it cannot be written: the audit entry would then have no owner, and nothing
   * could supply one afterwards. A crash between this write and the store delete,
   * between the acknowledgement and the removal, or a process that wrote the
   * record and then lost the delete to another process, leaves one small orphan
   * record. That is accepted, because the record is only ever read for its own
   * session id and incarnation. The `v1` prefix is where a future boot sweep
   * would look for them.
   */
  const SESSION_DELETION_OWNER_PREFIX = 'session-deletion-owner:v1:';

  /** Whether `error` is the strict UTF-8 decoder rejecting stored bytes, as opposed to the store failing. */
  function isInvalidEncodingError(error: unknown): boolean {
    return (
      error instanceof TypeError &&
      (error as { code?: unknown }).code === 'ERR_ENCODING_INVALID_ENCODED_DATA'
    );
  }

  function serializeSessionDeletionRecord(record: SessionDeletionRecord): string {
    return JSON.stringify({
      owner: record.owner ?? null,
      actor: record.actor ?? null,
      title: record.summary?.title ?? null,
      messageCount: record.summary?.messageCount ?? null,
    });
  }

  function parseSessionDeletionRecord(stored: string): SessionDeletionRecord {
    if (!stored.startsWith('{')) return { owner: stored, actor: undefined, summary: undefined };
    try {
      const parsed: unknown = JSON.parse(stored);
      if (typeof parsed !== 'object' || parsed === null) {
        return { owner: undefined, actor: undefined, summary: undefined };
      }
      const { owner, actor, title, messageCount } = parsed as Record<string, unknown>;
      return {
        owner: typeof owner === 'string' ? owner : undefined,
        actor: typeof actor === 'string' ? actor : undefined,
        summary:
          typeof messageCount === 'number'
            ? { title: typeof title === 'string' ? title : null, messageCount }
            : undefined,
      };
    } catch {
      return { owner: undefined, actor: undefined, summary: undefined };
    }
  }

  function sessionDeletionOwnerKey(sessionId: string, incarnation: string): string {
    return `${SESSION_DELETION_OWNER_PREFIX}${encodeURIComponent(sessionId)}:${incarnation}`;
  }

  async function recordSessionDeletionOwner(session: AgentSession, actor?: string): Promise<void> {
    const kvStore = runtime.kv;
    if (!core.auditTrailInstance || !kvStore) return;
    // A malformed owner names no one, so the entry is left without one.
    const owner = resolveSessionOwner(session.metadata);
    // The title and the count are what the chat was while it existed (COR-2018): the body is gone
    // by the time the entry is written, so they travel with the record the owner does.
    const { title, messageCount } = summarizeSession(session);
    const record: SessionDeletionRecord = { owner, actor, summary: { title, messageCount } };
    const key = sessionDeletionOwnerKey(session.id, session.incarnation);
    sessionDeletionOwners.set(key, record);
    try {
      await kvStore.set(key, serializeSessionDeletionRecord(record));
    } catch (error: unknown) {
      // The deletion does not go ahead without its owner: once the session is gone,
      // nothing can supply the owner its audit entry needs, in this process or any
      // other, so the caller is told and the session is left for it to retry.
      sessionDeletionOwners.delete(key);
      throw new Error(
        `Could not record the owner of session "${session.id}" before deleting it; the session was not deleted: ${serializeUnknownError(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * The steps before any session is removed, whether `deleteSession` removes it or an expiry
   * (`sessionStore.cleanup`) does, so the two cannot differ:
   *
   * - each session's owner is recorded for its deletion's audit entry; a record that cannot be
   *   written keeps every session;
   * - COR-1481: the user's message text does not outlive the context it belonged to, so each
   *   task of the incarnation keeps its status and cleanup and loses its history. This runs
   *   before the removal commits, so a failure leaves the context in place and a retry finds it.
   */
  async function prepareSessionsForRemoval(
    sessions: readonly AgentSession[],
    actor?: string,
  ): Promise<void> {
    for (const session of sessions) await recordSessionDeletionOwner(session, actor);
    for (const session of sessions) await core.tasks.clearHistory(session.id, session.incarnation);
  }

  /**
   * Reads the owner record back into memory before the deletion event is dispatched.
   * Resolves `true` when the read succeeded, whether it found a record or a definite
   * miss (a deletion that bypassed Bureau), and `false` when the read itself threw: the
   * caller must then leave the deletion pending, because acknowledging it would write
   * the audit entry without an owner and delete the only copy of it.
   */
  async function loadSessionDeletionOwner(
    sessionId: string,
    incarnation: string,
  ): Promise<boolean> {
    const kvStore = runtime.kv;
    if (!kvStore) return true;
    const key = sessionDeletionOwnerKey(sessionId, incarnation);
    if (sessionDeletionOwners.has(key)) return true;
    try {
      const stored = await kvStore.get(key);
      if (stored !== null) sessionDeletionOwners.set(key, parseSessionDeletionRecord(stored));
      return true;
    } catch (error: unknown) {
      // A record that is present but not valid text is a definite miss, like one that
      // is absent: nothing can ever read an owner from it, and retrying would jam
      // every later outbox entry behind it. It is audited without an owner and
      // removed with the rest. Only the strict decoder's own error code says so: a
      // bare `TypeError` is also what `fetch` throws when an HTTP-backed store is
      // unreachable, and that is the store failing, which is retried.
      if (isInvalidEncodingError(error)) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] The recorded owner of deleted session "${sessionId}" cannot be decoded; its deletion entry will have none: ${serializeUnknownError(error)}`,
          cause: error,
        });
        return true;
      }
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] Could not read the recorded owner of deleted session "${sessionId}"; leaving its deletion pending for a later drain to retry: ${serializeUnknownError(error)}`,
        cause: error,
      });
      return false;
    }
  }

  async function removeSessionDeletionOwner(sessionId: string, incarnation: string): Promise<void> {
    const key = sessionDeletionOwnerKey(sessionId, incarnation);
    sessionDeletionOwners.delete(key);
    try {
      await runtime.kv?.delete(key);
    } catch (error: unknown) {
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] Could not remove the owner record of deleted session "${sessionId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  /**
   * Marks every still-running run of session `id` as orphaned and aborts the ones
   * that are not paused, for a session that is about to be removed, by
   * `deleteSession` or by the store's own `cleanup()` (COR-718). Shared so that an
   * expiry is a deletion in this respect too: without it an expired session's run
   * would keep executing and write its terminal transcript into whatever session
   * the id names by then.
   *
   * The runs are found the same way `listRuns` attributes a run to a session, via
   * `getRunSessionIdentifier`, not the narrower `persistedApprovalRunIds` (AB-207).
   * Every still-live run is marked in `orphanedRunIds` BEFORE any of it is aborted
   * or released, so its eventual terminal `saveSession` call never resurrects the
   * record it belonged to (PR #430, "Prevent released runs from recreating deleted
   * sessions"), whichever way it settles. A run paused through the session's
   * steering gate is left for `settleForDeletion` to release rather than aborted
   * here, which keeps a usable control path until it terminates. The returned
   * `runTerminals` settle when each run's own terminal event has fired.
   */
  function abandonSessionRuns(id: string): {
    sessionRunIds: Set<string>;
    steeringGate: BureauSteeringGate | undefined;
    runTerminals: Array<Promise<void>>;
    /** COR-1481 — the tasks that were live when the session's deletion began, with their cleanup. */
    liveTasks: Array<{ taskId: string; closed: Promise<RunCleanupAcknowledgement> }>;
  } {
    const state = store.getState();
    const sessionRunIds = new Set<string>();
    for (const [, runState] of state.runs) {
      if (peers.getRunSessionIdentifier(runState) === id) sessionRunIds.add(runState.id);
    }
    for (const runId of sessionRunIds) {
      const runState = store.getRun(runId);
      if (runState?.status === 'running') orphanedRunIds.add(runId);
    }
    const steeringGate = steeringGates.get(id);
    const runTerminals: Array<Promise<void>> = [];
    const liveTasks: Array<{ taskId: string; closed: Promise<RunCleanupAcknowledgement> }> = [];
    for (const runId of sessionRunIds) {
      const runState = store.getRun(runId);
      if (runState?.status !== 'running') continue;
      runTerminals.push(peers.whenActiveRunTerminal(runState.activeRun));
      const closed = runState.activeRun.closed();
      void core.tasks.watchCleanup(runId, closed);
      liveTasks.push({ taskId: runId, closed });
      const isPaused = steeringGate?.forRun(runId).getDesiredState().paused ?? false;
      if (!isPaused) peers.abortRun(runId);
    }
    return { sessionRunIds, steeringGate, runTerminals, liveTasks };
  }

  /**
   * COR-713: a session's rows claim every managed asset they reference (supplied or generated, user
   * or assistant) under holders keyed by the session and the row, so the asset policy's retention
   * floor cannot expire an asset a persisted row still points at, and a row copied into another
   * session is claimed there under that session's own holder. Every way a row enters a session's
   * history is a session commit, and every commit is replayed through the outbox drain, which
   * calls {@link claimSessionAssets}. The claim is the asset service's own `retain`; a claim that
   * cannot be made or released only changes how long an asset lives, so a failure is reported and
   * never fails the commit, the drain or the deletion.
   */
  const claimedRowAssets = new Set<string>();

  /**
   * Skips the claim pass has already warned about, so a session that records no owner reports each
   * one once for the life of the process instead of on every save.
   */
  const reportedOwnerlessSkips = new Set<string>();

  function rowClaimContext(session: AgentSession) {
    const service = assetServiceHolder.current;
    if (service === undefined) return undefined;
    // A session records its owner when it is created. One that records none is claimed as the
    // local principal, which cannot see an asset another principal owns (COR-1581).
    const ownerless = session.metadata[SESSION_OWNER_METADATA_KEY] === undefined;
    return {
      service,
      principalId: ownerOrLocal(resolveSessionOwner(session.metadata)),
      holderOf: (rowId: string) => sessionRowHolderId(session.id, session.incarnation, rowId),
      rows: Object.values(session.conversationHistory.messages),
      onFailure: (assetId: string, error: unknown, rowId: string) =>
        diagnose({
          level: 'error',
          scope: 'assets',
          message: isPermanentClaimFailure(error)
            ? `[bureau] Skipping the retention claim of session "${session.id}" on asset "${assetId}" in row "${rowId}" for as long as this process runs, because the asset's stored record is corrupt; once it is repaired, the claim is made by a later retain of the asset or by the session's next save after a restart (a restart alone does not replay it): ${serializeUnknownError(error)}`
            : `[bureau] Could not update the retention claim of session "${session.id}" on asset "${assetId}" in row "${rowId}": ${serializeUnknownError(error)}`,
          cause: error,
        }),
      // A release that fails only changes how long an asset lives, so it is reported and moves on.
      onReleaseFailure: (assetId: string, error: unknown, rowId: string) =>
        diagnose({
          level: 'error',
          scope: 'assets',
          message: `[bureau] Could not release the retention claim of session "${session.id}" on asset "${assetId}" in row "${rowId}": ${serializeUnknownError(error)}`,
          cause: error,
        }),
      // An asset the principal cannot see is skipped quietly when the session has an owner: a hook
      // can supply a reference its owner may not read. Without one, the skip is probably this.
      onSkipped: ownerless
        ? (assetId: string, error: unknown, rowId: string) => {
            const key = `${session.id}\u0000${session.incarnation}\u0000${rowId}\u0000${assetId}`;
            if (reportedOwnerlessSkips.has(key)) return;
            reportedOwnerlessSkips.add(key);
            diagnose({
              level: 'warn',
              scope: 'assets',
              message: `[bureau] Session "${session.id}" records no owner, so its claim on asset "${assetId}" in row "${rowId}" was made as the local principal and skipped: ${serializeUnknownError(error)}`,
              cause: error,
            });
          }
        : undefined,
    };
  }

  /**
   * Takes the claims of every row in a committed session. A claim that fails transiently is
   * reported and then thrown once every row has been tried, so the outbox drain leaves the commit's
   * entry unacknowledged and replays it: the entry is the only cue that a committed row still needs
   * its claim. A claim that fails permanently (a corrupt asset record) is reported and remembered
   * with the claims already taken, and never thrown: retrying it cannot help, and an entry held
   * back for it would hold back every session's events until someone repaired the asset store.
   */
  async function claimSessionAssets(session: AgentSession): Promise<void> {
    const context = rowClaimContext(session);
    if (context === undefined) return;
    let transientFailure: { error: unknown } | undefined;
    await claimRowAssets(
      context.service,
      context.principalId,
      context.holderOf,
      context.rows,
      {
        workspaceAuthority: runtimeWorkspaceOwnerAuthority(workspace, context.principalId),
        onFailure: (assetId, error, rowId) => {
          context.onFailure(assetId, error, rowId);
          if (!isPermanentClaimFailure(error)) transientFailure ??= { error };
        },
        onSkipped: context.onSkipped,
      },
      claimedRowAssets,
    );
    // COR-1664 — the session may have been deleted while its claims were being taken (a goal
    // handoff or a drain holds a snapshot loaded before the delete). The delete released what it
    // saw, so a claim taken after that is released here, from the asset side. A session deleted
    // after this check releases every claim already taken. It runs before a transient failure is
    // rethrown: a retain that succeeded earlier in the pass must not be stranded by a later one.
    let checkFailure: { error: unknown } | undefined;
    try {
      const stillLive = await runtime.sessionStore?.load(session.id);
      if (runtime.sessionStore !== undefined && stillLive?.incarnation !== session.incarnation) {
        await releaseClaimsByHolderPrefix(
          context.service,
          sessionRowHolderPrefix(session.id, session.incarnation),
          (claim, error) => context.onReleaseFailure(claim.assetId, error, claim.holderId),
          claimedRowAssets,
        );
      }
    } catch (error) {
      checkFailure = { error };
    }
    if (transientFailure !== undefined) throw transientFailure.error;
    if (checkFailure !== undefined) throw checkFailure.error;
  }

  /**
   * COR-1934 — the managed assets a session holds: the ones its rows reference, owned by the
   * session's owner, and the ones it holds a claim on, owned by whoever owns the asset. Read before
   * the delete, because the rows are gone by the time the purge runs and the delete releases the
   * claims. An asset it never claimed is found by its row, and one whose row compaction removed by
   * its claim.
   */
  async function chatAssetsOf(session: AgentSession): Promise<ChatAsset[]> {
    const context = rowClaimContext(session);
    if (context === undefined) return [];
    const found = new Map<string, ChatAsset>();
    for (const row of context.rows) {
      for (const assetId of managedAssetIdsOf(row)) {
        found.set(assetId, { assetId, ownerId: context.principalId });
      }
    }
    const claims = await heldClaimsOf(
      context.service,
      sessionRowHolderPrefix(session.id, session.incarnation),
    );
    for (const claim of claims) {
      // An asset the chat's owner only read (another principal's, shared with them) is that
      // principal's to keep or delete: the chat released its claim, and that is all it did.
      if (claim.ownerId !== context.principalId) continue;
      found.set(claim.assetId, { assetId: claim.assetId, ownerId: claim.ownerId });
    }
    return [...found.values()];
  }

  /**
   * COR-1934 — whose memory, and under which agent, the chat's runs wrote, named before the delete
   * because the task records that otherwise say so can be gone by the time the purge runs (a
   * `retention.tasks` shorter than memory's retention).
   */
  function chatMemoryPlacementsOf(
    session: AgentSession,
    runIds: readonly string[],
  ): RunMemoryPlacement[] {
    const placements = new Map<string, RunMemoryPlacement>();
    for (const runId of runIds) {
      const owner = resolveRunMemoryOwner(session.metadata, runId);
      placements.set(`${owner}\u0000${session.agentName}`, { owner, agentName: session.agentName });
    }
    return [...placements.values()];
  }

  async function releaseSessionGeneratedAssets(session: AgentSession): Promise<void> {
    const context = rowClaimContext(session);
    if (context === undefined) return;
    await releaseRowAssetClaims(
      context.service,
      context.principalId,
      context.holderOf,
      context.rows,
      context.onReleaseFailure,
      claimedRowAssets,
    );
    // COR-1664 — the walk above reaches only the rows the session holds now. A row compaction (or
    // a replaced history) removed still has its claim, so the deleted incarnation's whole holder
    // prefix is released from the asset side, at the deletion rather than at the next boot or
    // maintenance pass. Only this incarnation: an id recreated since has its own claims.
    await releaseClaimsByHolderPrefix(
      context.service,
      sessionRowHolderPrefix(session.id, session.incarnation),
      (claim, error) => context.onReleaseFailure(claim.assetId, error, claim.holderId),
      claimedRowAssets,
    );
  }

  /** Releases the claims of runs that ended and sessions that were deleted; never rejects. */
  async function reconcileAssetClaims(): Promise<void> {
    await core.assetClaimReconciler.reconcileRunClaims();
    await core.assetClaimReconciler.reconcileSessionClaims();
  }

  /**
   * COR-1986 — the thread's lease, taken for a delete. An AG-UI start or resume decides under the
   * same lease, so a delete and a start cannot interleave into a chat that is created again after
   * it was deleted. A held lease is waited for on the injected timers, for as long as its holder
   * renews it or until it expires; the wait ends with a `BureauShuttingDownError` once admission
   * closes. A Bureau with no durable store has no session to delete and takes no lease.
   */
  async function acquireThreadLeaseForDeletion(id: string): Promise<AgUiLease | undefined> {
    if (runtime.kv === undefined) return undefined;
    const threadLeases = createAgUiLeases({ kv: runtime.kv, runtime: runtimeServices });
    for (;;) {
      const lease = await threadLeases.acquire('thread', id);
      if (lease !== undefined) return lease;
      if (core.runAdmissionClosed) {
        throw new BureauShuttingDownError(
          'Cannot delete: Bureau is shutting down.',
          runtimeServices.clock.nowISO(),
        );
      }
      await new Promise<void>((resolve) => {
        runtimeServices.timers.setTimeout(resolve, THREAD_LEASE_RETRY_MILLISECONDS);
      });
    }
  }

  /**
   * Whether `session` is still past a retention cutoff: its last activity is before `idleBefore`
   * and no task of it is live, so deleting it cancels nothing a person is waiting on.
   */
  async function isIdleBefore(session: AgentSession, idleBefore: number): Promise<boolean> {
    if (Date.parse(session.updatedAt) >= idleBefore) return false;
    const activity = await core.tasks.activityOf(
      [session.id],
      new Map([[session.id, session.incarnation]]),
    );
    return activity.get(session.id) === 'idle';
  }

  /**
   * COR-1986 — reads the session to delete and, when there is one to delete, records that its id
   * was deleted BEFORE anything is removed, under the thread's lease. A tombstone that cannot be
   * written refuses the delete, so nothing is removed; one that was written is never taken back,
   * so a delete that fails after it leaves a chat that refuses starts and is finished by a retry.
   * Every chat is given one, a tried agent's included: its agent goes with it, but a start that
   * names the same thread id through a catalog agent would otherwise recreate it with every row.
   */
  async function loadSessionAndTombstone(
    id: string,
    expectedIncarnation: string | undefined,
    idleBefore: number | undefined,
  ): Promise<AgentSession | 'active' | undefined> {
    const sessionStore = peers.requireSessionStore();
    const lease = await acquireThreadLeaseForDeletion(id);
    try {
      const session = await sessionStore.load(id);
      // COR-1481 — the caller authorized one incarnation of this id. An id reused since is
      // another context, and nothing of it is cancelled or deleted here.
      if (expectedIncarnation !== undefined && session?.incarnation !== expectedIncarnation) {
        return undefined;
      }
      // A retention sweep's expiry is decided again here, under the lease a chat start takes
      // before it adds a message, and before the tombstone, which is never taken back.
      if (
        session !== undefined &&
        idleBefore !== undefined &&
        !(await isIdleBefore(session, idleBefore))
      ) {
        return 'active';
      }
      if (session !== undefined && runtime.kv !== undefined) {
        await writeContextTombstone(runtime.kv, {
          version: 1,
          contextId: id,
          owner: resolveSessionOwner(session.metadata) ?? null,
          deletedAt: runtimeServices.clock.now(),
        });
      }
      return session;
    } finally {
      if (lease !== undefined) await releaseQuietly(lease);
    }
  }

  async function performDeleteSession(
    id: string,
    expectedIncarnation: string | undefined,
    onStoreDeletionCommitted: () => void,
    actor?: string,
    idleBefore?: number,
  ): Promise<ContextDeletionReport> {
    const sessionStore = peers.requireSessionStore();
    const loaded = await loadSessionAndTombstone(id, expectedIncarnation, idleBefore);
    // A retention sweep's chat that was active since it was listed is kept.
    if (loaded === 'active') return { deleted: false, tasks: [] };
    const session = loaded;
    // A caller that named another incarnation than the stored one deletes nothing.
    if (expectedIncarnation !== undefined && session === undefined) {
      return { deleted: false, tasks: [] };
    }
    if (session) {
      // A sweep deletes the incarnation it found idle, never one created under the id since.
      const fencedIncarnation =
        expectedIncarnation ?? (idleBefore === undefined ? undefined : session.incarnation);
      // COR-1934 — before anything is removed: the purge that follows the commit is owed from here,
      // and a delete that cannot record it is refused, so the chat is deleted again whole.
      const runIds = await chatRunIdsOf(session);
      const deletedChat: DeletedChat = {
        sessionId: id,
        incarnation: session.incarnation,
        runIds,
        assets: await chatAssetsOf(session),
        memoryPlacements: chatMemoryPlacementsOf(session, runIds),
      };
      await core.chatContentPurge.record(deletedChat);
      await prepareSessionsForRemoval([session], actor);
      for (const runId of peers.persistedApprovalRunIds(session.metadata)) {
        await peers.revokePendingApprovalsForRun(runId, {
          status: 'revoked',
          principal: 'system:session-deletion',
        });
        for (const reviewId of pendingApprovalOverrides.keys()) {
          if (reviewId.startsWith(`approval:${runId}:`)) dropPendingApprovalOverride(reviewId);
        }
        for (const reviewId of invalidApprovalReviewIds) {
          if (reviewId.startsWith(`approval:${runId}:`)) invalidApprovalReviewIds.delete(reviewId);
        }
      }

      // AB-207: abort every NON-PAUSED run this session owns, found the same
      // way `listRuns` attributes a run to a session — via
      // `getRunSessionIdentifier` — not the narrower `persistedApprovalRunIds`
      // set above (a run with no pending approval was previously left
      // running past its session's deletion). A run currently paused via
      // this session's steering gate is deliberately left alone here: it is
      // RELEASED (not aborted) by `settleForDeletion` further down, exactly
      // as PR #430's P1 finding ("Prevent released runs from recreating
      // deleted sessions") already established — aborting it here instead
      // would abort-terminate it via a different path than that release,
      // regressing the "retain a usable control path until they terminate"
      // behavior that fix relies on. Every running run's own terminal event
      // (`run.completed`/`run.aborted`/`run.error`) — whether reached via
      // this abort or via the later release — is awaited AFTER
      // `settleForDeletion` runs, so this function's returned promise never
      // resolves while a session run is still cleanup-pending.
      const {
        sessionRunIds,
        steeringGate: steeringGateForAbort,
        runTerminals,
        liveTasks,
      } = abandonSessionRuns(id);
      // COR-1482: a schedule fire is a live task of its context too, though it is not in the run
      // store, so deleting the context stops it as it stops every other live task in it.
      for (const fire of await core.tasks.unsettledFiresOfContext(id, session.incarnation)) {
        const cancelled = await core.tasks.cancel(fire.taskId, 0).catch((error: unknown) => {
          diagnose({
            level: 'error',
            scope: 'task-registry',
            message: `[bureau] Could not cancel schedule fire "${fire.taskId}" with its context "${id}": ${serializeUnknownError(error)}`,
            cause: error,
          });
          return undefined;
        });
        if (cancelled === undefined || cancelled.receipt === 'rejected') continue;
        // A fire has no cleanup to acknowledge, so the stop is reported as one nothing confirms.
        // Followed here, so the receipt of this deletion says so even with no wait: left to the
        // caller's wait of zero, the acknowledgement would not have been seen yet and the stop
        // would read as a cleanup still pending.
        const closed: Promise<RunCleanupAcknowledgement> = Promise.resolve({
          status: 'unresolved',
          reason: 'unreachable',
        });
        await core.tasks.watchCleanup(fire.taskId, closed);
        liveTasks.push({ taskId: fire.taskId, closed });
      }

      // AB-228/AB-371/AB-384, superseded by AB-389: `session.deleted` used
      // to be dispatched directly, right here, immediately after
      // `sessionStore.delete` committed — a deliberate fire-and-forget
      // dispatch coupled to nothing but this call's own completion, built
      // on the `{ returnIncarnation: true }` overload specifically to avoid
      // a race on WHICH incarnation to stamp the event with. That whole
      // concern moves into the store itself: `sessionStore.delete` now
      // appends the `SessionOutboxEntry` — gated on the SAME atomic
      // delete-and-count this call awaits, carrying the SAME race-free
      // incarnation the old overload existed to obtain — in the SAME
      // `conditionalBatch` as the removal, and dispatches only the
      // best-effort `SessionOutboxAppendedEvent` drain trigger this bureau
      // already listens for. `drainOutbox` (below) replays the entry
      // as a fresh `SessionDeletedEvent` onto this SAME emitter, in ordinal
      // order against every other pending entry, once its own durable
      // write has settled — never before, and never merely because this
      // call returned. The plain `boolean` contract is all this call site
      // needs now.
      // COR-1476 — before the delete commits, so a session recreated under this
      // id can never have its own pending input cancelled here. Input admitted
      // in the gap before the delete is left for delivery to refuse by
      // incarnation. A failure must not keep the session from being deleted.
      await peers.retireSessionInputs(id, session.incarnation).catch((error: unknown) => {
        diagnose({
          level: 'error',
          scope: 'session-input',
          message: `[bureau] Could not retire the pending session input of session "${id}" before deleting it: ${serializeUnknownError(error)}`,
          cause: error,
        });
      });
      // COR-1911 — a tried context's agent goes BEFORE the store delete, not after it: once the
      // delete commits, the id is free, and an owner who named the agent could start the id again
      // with it, a context nothing would ever clean up. Without the agent the id answers
      // NOT_FOUND. A delete that throws did not commit, so the context is still live and its
      // agent is held again.
      const triedAgent =
        sessionOriginOf(session.metadata) === 'try'
          ? core.tryAgents.take(session.agentName, id)
          : undefined;
      let removedLiveRecord: boolean;
      try {
        removedLiveRecord =
          fencedIncarnation === undefined
            ? await sessionStore.delete(id)
            : await sessionStore.delete(id, { expectedIncarnation: fencedIncarnation });
      } catch (error) {
        if (triedAgent !== undefined) core.tryAgents.hold(triedAgent);
        // The delete did not commit: the purge is not owed.
        await core.chatContentPurge.forget(deletedChat);
        throw error;
      }
      onStoreDeletionCommitted();
      if (!removedLiveRecord) await core.chatContentPurge.forget(deletedChat);
      // COR-1915 — the deleted chat's spend records go with it. A record left behind is ignored
      // anyway, since a chat recreated under the id has another incarnation, so a failure here is
      // diagnosed and never keeps the deletion from finishing.
      if (removedLiveRecord) {
        await core.chatSpendLedger.forget(id, session.incarnation).catch((error: unknown) => {
          diagnose({
            level: 'error',
            scope: 'chat-spend',
            message: `[bureau] Could not remove the spend records of deleted chat "${id}": ${serializeUnknownError(error)}`,
            cause: error,
          });
        });
      }
      if (removedLiveRecord) await releaseSessionGeneratedAssets(session);
      // AB-389 — drain right here, before anything below that can stall
      // (a genuinely stuck run's terminal await further down must never
      // block this durable fact from landing): this is the ONE call site
      // that can call `drainOutbox()` directly rather than relying
      // solely on the best-effort trigger, since it already knows a commit
      // just happened. Gated on `removedLiveRecord` — "immediately after
      // EACH COMMIT" means no commit, no direct drain: the losing side of
      // an AB-371 cross-process race removed nothing, so it must not also
      // race the winner's own drain for the SAME entry (both bureaus share
      // one persistent outbox, and neither `pending()` nor `acknowledge()`
      // claims an entry exclusively — see this function's own doc comment
      // below on the residual this leaves, for the maintenance-timer and
      // boot-recovery drain paths specifically, which are NOT gated on
      // having personally committed anything). `drainOutbox` is
      // idempotent and single-flighted regardless, so this never duplicates
      // work the trigger (fired synchronously inside `sessionStore.delete`
      // above, for the SAME winning call) might also be running.
      if (removedLiveRecord) {
        try {
          await peers.drainOutbox();
        } catch (error) {
          // Same isolation as `recoverDurableRuns`'s own drain call: the
          // session removal above already committed — a drain failure
          // (this call's own attempt, or another pending entry's) must not
          // make `deleteSession()` itself appear to have failed when the
          // deletion it promised actually succeeded.
          diagnose({
            level: 'error',
            scope: 'recovery',
            message: `[bureau] Session outbox drain failed after deleteSession("${id}") committed; the deletion itself succeeded: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
      }

      // AB-67/AB-199 review findings (PR #430 — Codex P2): a deleted
      // session's steering gate — and its entries in the shared,
      // bureau-wide idempotency ledger — must not survive to be inherited
      // by a session id that gets reused later, or a stale
      // pause/configVersion/command-ledger entry would block or mis-replay
      // against the logically new session. Both removals happen ONLY AFTER
      // `sessionStore.delete` above has actually succeeded ("Keep the gate
      // until session deletion succeeds") — a rejected deletion leaves the
      // still-live session's gate and ledger entries untouched, rather than
      // orphaning a replacement gate a subsequent `submitSteeringCommand`
      // call would otherwise create.
      //
      // `settleForDeletion` runs FIRST, before the gate is discarded: a run
      // still paused when its session is deleted would otherwise have its
      // steering channel simply vanish with the gate — every later
      // `submitSteeringCommand` against the now-deleted session already
      // returns `not-found`, so nothing could ever resume it, and its
      // `runStep` would await a promise this gate's own closure held
      // forever (review finding, PR #430 — Codex P2, "Settle paused runs
      // before deleting their steering gate"). This is also the moment a
      // still-paused run above actually gets released, so `runTerminals`
      // must be awaited AFTER this call, not before it.
      steeringGateForAbort?.settleForDeletion(runtimeServices.clock.nowISO());
      steeringGateForAbort?.purgeFromLedger();
      // Only the gate settled above: if the id was recreated during the
      // awaits since, the new incarnation's gate (and the runs holding it)
      // must survive this deletion's cleanup.
      if (steeringGates.get(id) === steeringGateForAbort) steeringGates.delete(id);
      // The durable side gets the same treatment, for the same reason — a
      // reused session id must not inherit a deleted session's command
      // history — but scoped to the DELETED body's incarnation, captured
      // before the store delete. A session recreated under this id in the
      // meantime has a new incarnation and its own log, which this cleanup
      // never touches; this process's folded view is dropped only if it was
      // a view of the deleted incarnation.
      if (steeringCursors.get(id)?.incarnation === session.incarnation) {
        peers.forgetSessionSteering(id);
      }
      const steeringKv = peers.durableSteeringStore();
      if (steeringKv !== undefined) {
        // Best-effort, like the outbox drain above: the session is already
        // gone, so a failure here must not make the deletion look failed. The
        // log it leaves is removed by the boot sweep of orphaned logs.
        try {
          await peers.enqueueSteering(id, () =>
            deleteSteeringLog(steeringKv, id, session.incarnation),
          );
        } catch (error) {
          diagnose({
            level: 'error',
            scope: 'steering',
            message: `[bureau] Session "${id}" was deleted, but its steering log could not be removed; the next boot sweep removes it: ${serializeUnknownError(error)}`,
          });
        }
      }

      await Promise.allSettled(runTerminals);

      for (const runId of sessionRunIds) {
        runRequestContexts.delete(runId);
        runToolboxesByRunId.delete(runId);
        releaseRunScope(runId);
        terminalReviewSessions.delete(runId);
        for (const [reviewId, cleanup] of reviewResolutionCleanupPending) {
          if (cleanup.runId === runId) reviewResolutionCleanupPending.delete(reviewId);
        }
      }
      // COR-1911 — a tried context takes the agent it was started with, and the runs it made,
      // with it: the other contexts' runs are history that retention ends.
      if (removedLiveRecord && sessionOriginOf(session.metadata) === 'try') {
        await peers.discardTriedRuns(session, sessionRunIds);
      }
      // COR-1934 — the chat's content goes once its runs have ended, so their last events are in.
      // The deletion has committed: a failure is diagnosed, the pending record stays, and the next
      // maintenance pass or boot finishes the purge.
      if (removedLiveRecord) {
        try {
          await core.chatContentPurge.run(deletedChat);
        } catch (error) {
          diagnose({
            level: error instanceof ChatRunsNotEndedError ? 'warn' : 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Chat "${id}" was deleted, but its content could not be purged yet; a later maintenance pass retries: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
      }
      return { deleted: removedLiveRecord, tasks: liveTasks };
    }
    await sessionStore.delete(id);
    return { deleted: false, tasks: [] };
  }

  return {
    listSessions,
    getSession,
    renameSession,
    purgeDurableRun,
    isTerminalDurableStatus,
    descendantRunIdsOf,
    deleteSession,
    startSessionDeletion,
    sessionDeletionOwnerKey,
    prepareSessionsForRemoval,
    loadSessionDeletionOwner,
    removeSessionDeletionOwner,
    abandonSessionRuns,
    claimedRowAssets,
    claimSessionAssets,
    releaseSessionGeneratedAssets,
    reconcileAssetClaims,
  };
}
