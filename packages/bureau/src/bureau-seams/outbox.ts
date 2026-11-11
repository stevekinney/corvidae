/**
 * Outbox (COR-2376 slice S10): drain the session outbox, one entry at a time under a claim, and arm
 * the single retry timer when a live peer holds a claim. An entry is a session commit's event, a
 * review decision's audit record, an attachment, or an expired session's asset release. The drain
 * owner id and the three bindings the timer and the in-flight drain live in stay in
 * `constructBureau`, because shutdown reads and clears them. Built by `constructBureau` and
 * reached only through `createBureau`; recovery, maintenance, sessions and review resolution call
 * `drainOutbox`.
 */
import type { AgentDefinitions } from '../agent-catalog';
import {
  type AgentSession,
  type DurableEventOwner,
  SessionCreatedEvent,
  SessionDeletedEvent,
  type SessionOutboxEntry,
  SessionSavedEvent,
  type SessionStore,
} from '@lostgradient/operative';
import { type BureauCore, REVIEW_AUDIT_OUTBOX_NAMESPACE, type ReviewAuditAttachment } from './core';
import type { DurableEventProducer } from '../durable-event-history';
import type { ReviewDecisionAuditPayload } from '../resolved-review-record';
import { auditTrailSessionOwnerId } from '../audit-trail';
import { serializeUnknownError } from '../serialization';

/** The callables the outbox reads from elsewhere in `constructBureau`. */
export interface OutboxPeers {
  /** Records the audit of a resolved review. */
  readonly recordResolvedReview: (
    payload: ReviewDecisionAuditPayload,
    decidedAt: number,
  ) => Promise<void>;
  /** Tracks a session input settlement until it settles. */
  readonly trackSessionInputSettlement: (settling: Promise<void>) => void;
  /** Claims the assets a session holds. */
  readonly claimSessionAssets: (session: AgentSession) => Promise<void>;
  /** Whether the deletion owner record of a session incarnation is held. */
  readonly loadSessionDeletionOwner: (sessionId: string, incarnation: string) => Promise<boolean>;
  /** Releases the generated assets a session holds. */
  readonly releaseSessionGeneratedAssets: (session: AgentSession) => Promise<void>;
  /** Removes the deletion owner record of a session incarnation. */
  readonly removeSessionDeletionOwner: (sessionId: string, incarnation: string) => Promise<void>;
}

/** Builds the outbox drain of one Bureau. Synchronous, and registers nothing. */
export function createOutbox<D extends AgentDefinitions>(core: BureauCore<D>, peers: OutboxPeers) {
  const { assetServiceHolder, runtimeServices, emitter, runtime, diagnose, expiringSessions } =
    core;

  // How long a claim protects an entry from being reclaimed by a different
  // drainer. Long enough to comfortably cover one pass's durable-write wait
  // (`waitForActiveWrites`) under ordinary load; short enough that a
  // crashed drainer's claim does not strand an entry for long. Not a
  // `BureauOptions` knob for the same reason `AUTOMATIC_RUN_OWNERSHIP_PRUNE_INTERVAL_MS`
  // above is not one — the issue's acceptance criteria name no configurable
  // lease duration.
  const OUTBOX_CLAIM_LEASE_MS = 30_000;

  // How often the renewal timer (below) extends an in-progress claim.
  // Comfortably shorter than the lease itself so a renewal always lands
  // well before the PRIOR grant would expire, even under one slow tick.
  const OUTBOX_CLAIM_RENEWAL_INTERVAL_MS = Math.floor(OUTBOX_CLAIM_LEASE_MS / 3);

  // Codex P1 review finding, PR #599, "Cap retry delays before passing them
  // to setTimeout": `atMs` comes from a WINNING peer's own `claim.until` —
  // which this bureau does not control (`outbox.claim()` is a public
  // `SessionStore` method any caller sharing this backend may invoke with
  // an arbitrarily distant `until`). Both Node's and Bun's timer
  // implementations silently truncate a delay beyond the int32 range
  // (~24.8 days) to roughly 1ms instead of throwing, so passing such a
  // delay straight to `setTimeout` would fire almost immediately, observe
  // the SAME still-live claim, and re-arm another overflowing timer — a
  // tight storage-polling loop for the entire remaining lease. Capping the
  // delay and re-checking the remaining time on each capped fire closes
  // this without ever passing an out-of-range delay to a real timer.
  const MAXIMUM_SETTIMEOUT_DELAY_MS = 2_147_483_647;

  function scheduleOutboxRetry(atMs: number): void {
    // Codex P2 review finding, PR #599, "Clear retry timers armed by the
    // drain awaited at shutdown": shutdown's own `outboxDrainInFlight`
    // await (below) can let an in-flight drain reach a peer-owned entry and
    // call back into this function AFTER shutdown already cleared any
    // PRIOR retry timer but BEFORE that await resolves — arming a NEW timer
    // shutdown never clears, which could later invoke a drain against
    // disposed storage. `maintenanceAdmissionClosed` flips to `true`
    // synchronously at the very start of shutdown, before that await, so
    // checking it here closes retry admission for the rest of shutdown
    // rather than requiring shutdown to clear the timer a second time.
    if (core.maintenanceAdmissionClosed) return;
    if (core.outboxRetryTimerArmedForMs !== undefined && core.outboxRetryTimerArmedForMs <= atMs) {
      // An earlier (or equal) retry is already armed — it covers this
      // case too, since a fresh drain pass re-evaluates from scratch.
      return;
    }
    if (core.outboxRetryTimerArmedForMs !== undefined) {
      runtimeServices.timers.clearTimeout(core.outboxRetryTimerHandle);
    }
    core.outboxRetryTimerArmedForMs = atMs;
    const remainingMs = Math.max(0, atMs - runtimeServices.clock.now());
    const delayMs = Math.min(remainingMs, MAXIMUM_SETTIMEOUT_DELAY_MS);
    core.outboxRetryTimerHandle = runtimeServices.timers.setTimeout(() => {
      // The delay above may have been CAPPED rather than the real
      // remaining wait — if `atMs` has not actually arrived yet, this fire
      // is early: re-arm for the (now shorter) remaining time instead of
      // draining prematurely. `outboxRetryTimerArmedForMs` is
      // cleared first so the re-arm below is not refused as a no-op by
      // this same function's own "earlier retry already armed" guard.
      core.outboxRetryTimerArmedForMs = undefined;
      if (runtimeServices.clock.now() < atMs) {
        scheduleOutboxRetry(atMs);
        return;
      }
      drainOutbox().catch((error: unknown) => {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Session outbox retry drain (scheduled after losing a claim to a live peer) failed: ${serializeUnknownError(error)}`,
        });
      });
    }, delayMs);
  }

  // AB-389 (Codex P2 review finding, PR #598, "Re-run the drain when a
  // commit joins its completion edge"): a commit's trigger can arrive
  // exactly when an in-flight drain's last `pending()` call has already
  // returned empty and is about to return — that trigger's call below
  // joins `outboxDrainInFlight` (a promise already committed to
  // resolving), so its own newly-appended entry would otherwise sit
  // undrained until a later, unrelated trigger or maintenance tick (and
  // `performDeleteSession`'s own explicit await would return without the
  // durable fact it promises). Set synchronously by EVERY joiner — not
  // just the post-commit trigger — and checked, then reset, by the
  // in-flight drain itself right after its own pending-loop exits but
  // before it actually returns: any join that happens in that narrow
  // window forces one more full pass rather than being silently dropped.
  let outboxDrainRerunRequested = false;

  async function drainOutbox(): Promise<void> {
    if (core.outboxDrainInFlight) {
      outboxDrainRerunRequested = true;
      return core.outboxDrainInFlight;
    }
    // AB-389 (Codex P2 review finding, PR #598, "Recheck rerun requests
    // after the drain promise resolves"): the in-flight guard is cleared
    // INSIDE this same async function's own `finally`, synchronously right
    // after the do-while loop's last (non-awaited) exit check — never in a
    // separate `try { await drain } finally { ... }` wrapper one level up.
    // That extra layer used to introduce a real gap: the do-while exiting
    // (this promise settling) and the CALLER's `await drain` resuming to
    // run its own `finally` are two different microtask turns, and a
    // joiner's `drainOutbox()` call landing in between would see
    // `outboxDrainInFlight` still set, join this ALREADY-SETTLING
    // promise, and set `outboxDrainRerunRequested` — a flag nothing
    // would ever check again, since the do-while had already exited. With
    // the guard cleared here instead, there is no such gap: everything
    // from the do-while's condition evaluating false through this
    // `finally` running is one synchronous stretch (a try/finally
    // transition never yields to the microtask queue), so a joiner cannot
    // execute in between — it can only ever land during the single
    // `await` inside the loop, which the do-while's own re-check already
    // catches.
    core.outboxDrainInFlight = (async (): Promise<void> => {
      try {
        const outboxSessionStore = runtime.sessionStore;
        // Draining and dispatching happens whenever there is a session
        // store to drain, regardless of whether a durable event history
        // producer is configured — `bureau.addEventListener('session.deleted',
        // ...)` and `audit-trail.ts`'s own listener (a KV-only bureau with
        // no durable engine still has both) must keep receiving these
        // events exactly as they did when `SessionStore`/`deleteSession`
        // dispatched them directly. `durableEventProducerInstance` (not
        // `eventHistoryInstance` itself, which is what exposes
        // `waitForActiveWrites` — it exists exactly when
        // `eventHistoryInstance` does, both wired together further down
        // this function) is checked separately, only to decide whether
        // there is a durable write to wait for before acknowledging:
        // absent it, this bureau has no durable event history surface at
        // all, so there is nothing for AC1's "delete only after the
        // durable write settles" rule to apply to — acknowledging
        // immediately after dispatch is correct, not a gap.
        if (!outboxSessionStore) return;
        const producer = core.durableEventProducerInstance;
        do {
          outboxDrainRerunRequested = false;
          // Loop until one full pass finds nothing pending — an entry
          // appended by a commit that lands WHILE this pass is draining is
          // picked up by THIS pass rather than left for the next trigger.
          await drainOutboxPass(outboxSessionStore, producer);
          // Re-checked with no `await` between the pass above returning
          // and this read, so a join that set the flag at any point up to
          // and including this exact moment is observed.
        } while (outboxDrainRerunRequested);
      } finally {
        core.outboxDrainInFlight = undefined;
      }
    })();
    await core.outboxDrainInFlight;
  }

  async function drainOutboxPass(
    outboxSessionStore: SessionStore,
    producer: DurableEventProducer | undefined,
  ): Promise<void> {
    for (;;) {
      const pending: readonly SessionOutboxEntry[] = await outboxSessionStore.outbox.pending();
      if (pending.length === 0) return;
      for (const entry of pending) {
        // AB-391 (Codex P1 review finding, PR #601, "Stop before later
        // ordinals when an attachment is unknown"): `SessionStore.outbox`'s
        // own contract (`packages/operative/src/session/types.ts`) requires
        // replay "exactly once, in ordinal order" — a STORE-WIDE ordinal,
        // never a per-session one. An entry under a `session.attachment`
        // namespace THIS bureau version does not recognize may still be
        // meaningful to a different consumer (a future bureau version, or
        // a peer instance running one) that has not drained it yet, so it
        // is left pending rather than dropped — but letting this pass
        // advance PAST it to a later ordinal (the prior fix's `continue`)
        // breaks that same ordinal-order contract: a later `session.saved`
        // or `session.deleted` could reach durable history before an
        // earlier fact a peer's own consumer has not replayed yet. Stopping
        // the WHOLE pass here — exactly like the claim-contention branch
        // below — is the only way to leave an entry pending without also
        // reordering everything after it. A later trigger (this process's
        // own next tick, or a peer's) gets a fresh look at it.
        if (
          entry.kind === 'session.attachment' &&
          entry.namespace !== REVIEW_AUDIT_OUTBOX_NAMESPACE
        ) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Unrecognized session.attachment outbox entry namespace "${entry.namespace}" (ordinal ${entry.ordinal}); stopping this drain pass here, leaving it and every later ordinal pending, rather than dropping it or reordering past it, in case a different consumer recognizes it.`,
          });
          return;
        }
        // AB-390 — claim before replaying. A peer (this process's own
        // overlapping pass is impossible: `drainOutbox` is
        // single-flighted above; "peer" here means a DIFFERENT bureau
        // process sharing this backend) may already hold an unexpired
        // claim on this exact entry. Stopping the WHOLE pass here, rather
        // than continuing to a LATER ordinal, preserves AB-389's ordering
        // guarantee: replaying ordinal 2 while a peer still owns ordinal 1
        // would let `session.saved` reach durable history before
        // `session.created` for the same lineage. A later trigger — this
        // process's own next tick, or the peer finishing its own drain —
        // picks up where this pass stopped.
        const attempt = await outboxSessionStore.outbox.claim(entry.ordinal, {
          owner: core.outboxDrainOwner,
          until: runtimeServices.clock.now() + OUTBOX_CLAIM_LEASE_MS,
        });
        if (!attempt.claimed) {
          // Codex P1 review finding, PR #599, "Schedule a retry when a
          // live claim blocks recovery": `attempt.lease` — the CURRENT
          // winning claim as `claim()` itself just observed it, never this
          // pass's earlier `pending()` snapshot, which a peer's own
          // intervening `claim()` call could already have made stale (Codex
          // P1 review finding, PR #599, "Re-read the winning claim before
          // deciding not to retry") — names the blocking holder's own
          // lease. Wake this bureau's drain right when that lease is due
          // to expire, rather than depending on whichever unrelated
          // trigger happens to fire next.
          if (attempt.lease) scheduleOutboxRetry(attempt.lease.until);
          return;
        }
        const owner: DurableEventOwner = { kind: 'session', id: entry.sessionId };
        // Codex P1 review finding, PR #599, "Renew the claim while replay
        // is in flight": the stretch this `try` wraps — the durable write
        // `waitForActiveWrites` settles, `wasRecorded`, and the
        // audit-trail read-your-writes query — has no upper bound under
        // real backpressure or a slow backend. A claim taken once, before
        // any of that, can lapse mid-wait, letting a peer reclaim and
        // dispatch this SAME entry again before this drainer ever
        // discovers the lost claim at `acknowledge()` — recreating the
        // exact duplicate-delivery hazard this lease exists to close.
        // This timer renews the lease every
        // `OUTBOX_CLAIM_RENEWAL_INTERVAL_MS` for as long as this
        // drainer is still actively working the entry, and is always
        // cleared in `finally` — including on every early `return` below.
        const renewalTimerHandle = runtimeServices.timers.setInterval(() => {
          outboxSessionStore.outbox
            .claim(entry.ordinal, {
              owner: core.outboxDrainOwner,
              until: runtimeServices.clock.now() + OUTBOX_CLAIM_LEASE_MS,
            })
            .catch((error: unknown) => {
              diagnose({
                level: 'error',
                scope: 'durable-maintenance',
                message: `[bureau] Failed to renew the claim on session outbox entry ${entry.ordinal} while replaying it: ${serializeUnknownError(error)}`,
              });
            });
        }, OUTBOX_CLAIM_RENEWAL_INTERVAL_MS);
        let outcome: 'stop' | 'continue';
        try {
          outcome = await drainOutboxEntry(entry, owner, outboxSessionStore, producer);
        } finally {
          runtimeServices.timers.clearInterval(renewalTimerHandle);
        }
        if (outcome === 'stop') return;
      }
    }
  }

  // AB-390 — the claim-then-replay-then-acknowledge sequence for ONE
  // outbox entry, extracted so `drainOutboxPass` can wrap it in
  // the renewal-timer `try`/`finally` above without duplicating a return
  // path per verification step. Returns `'stop'` for every case that used
  // to `return` directly out of `drainOutboxPass` itself (the
  // caller propagates that into its OWN `return`, so "stop this entry"
  // and "stop the whole pass" remain exactly the same observable behavior
  // they were before this was split out) and `'continue'` once this
  // entry is fully acknowledged.
  /**
   * AB-391: narrows a `session.attachment` entry's opaque `JSONValue`
   * payload to the shape {@link buildReviewDecisionAuditRecord} produces —
   * the only payload shape this bureau ever appends under
   * {@link REVIEW_AUDIT_OUTBOX_NAMESPACE}.
   */
  function isReviewAuditAttachmentPayload(value: unknown): value is ReviewAuditAttachment {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    if (
      typeof record['runId'] === 'string' &&
      typeof record['type'] === 'string' &&
      'detail' in record &&
      typeof record['principal'] === 'string'
    ) {
      const request = record['decisionRequest'];
      if (request === undefined) return true;
      if (typeof request !== 'object' || request === null || Array.isArray(request)) return false;
      const candidate = request as Record<string, unknown>;
      return (
        typeof candidate['reviewId'] === 'string' &&
        typeof candidate['round'] === 'number' &&
        Number.isInteger(candidate['round']) &&
        (candidate['decision'] === 'approve' ||
          candidate['decision'] === 'deny' ||
          candidate['decision'] === 'reject') &&
        typeof candidate['principal'] === 'string' &&
        typeof candidate['digest'] === 'string' &&
        (candidate['reason'] === undefined || typeof candidate['reason'] === 'string')
      );
    }
    return false;
  }

  /**
   * AB-391: replays one `session.attachment` outbox entry — the durable
   * write this bureau's own review-transition code coupled to a
   * session-store commit (see the "review-transition audit records ride
   * the session outbox" section above) — into the real audit trail, then
   * acknowledges it.
   *
   * Idempotency is `AuditTrail.record`'s own `dedupeKey` — an atomic
   * storage-level compare-and-swap keyed by THIS entry's `sessionId` and
   * `ordinal` (Codex review finding, PR #601, "Make attachment replay
   * deduplication atomic": a read-before-write existence check, no matter
   * how it is scoped, has a race window between the read and the write
   * that two Bureau processes both reclaiming this entry after a lease
   * renewal race can land in, each seeing "not yet recorded" and each
   * durably writing — `dedupeKey` closes that window at the storage layer
   * rather than trying to narrow it in application code). A rejection
   * from `record()` here (a genuine storage failure, since `dedupeKey`
   * opts into propagating failures rather than swallowing them — see its
   * own doc comment) propagates out of this function uncaught, leaving
   * the entry claimed-but-unacknowledged for a later drain to retry,
   * exactly the "leave it pending" behavior a failed write always had.
   *
   * Only ever called for a `REVIEW_AUDIT_OUTBOX_NAMESPACE` entry —
   * `drainOutboxPass` stops the whole pass at (and never claims) any other
   * `session.attachment` namespace before reaching this function, so
   * there is no "unrecognized namespace" branch here to duplicate that
   * check.
   */
  async function drainOutboxAttachmentEntry(
    entry: Extract<SessionOutboxEntry, { kind: 'session.attachment' }>,
    outboxSessionStore: SessionStore,
  ): Promise<'stop' | 'continue'> {
    const acknowledge = async (): Promise<'stop' | 'continue'> => {
      const acknowledged = await outboxSessionStore.outbox.acknowledge(
        entry.ordinal,
        core.outboxDrainOwner,
      );
      if (!acknowledged) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Lost the claim on outbox entry ${entry.ordinal} (session.attachment for session "${entry.sessionId}") before acknowledging it; a different drainer reclaimed and will retire it.`,
        });
        return 'stop';
      }
      return 'continue';
    };

    // `REVIEW_AUDIT_OUTBOX_NAMESPACE` IS this bureau's own — this code is
    // the only writer of it, via `reviewAuditOutboxAttachment`, which
    // always produces the shape `isReviewAuditAttachmentPayload` checks
    // for. A payload under this namespace that fails that check is
    // corruption from THIS write path (or a hand-edited/fuzzed record),
    // not a forward-compatibility gap a future consumer could resolve —
    // there is no future version of this same namespace to defer to, so
    // dropping it (rather than leaving it to jam every future pass) is
    // the correct call.
    if (!isReviewAuditAttachmentPayload(entry.payload)) {
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] Malformed audit-record outbox entry payload (ordinal ${entry.ordinal}); acknowledging without replay.`,
      });
      return acknowledge();
    }
    const payload = entry.payload;
    if (core.auditTrailInstance) {
      await core.auditTrailInstance.record({
        runId: payload.runId,
        type: payload.type,
        detail: payload.detail,
        principal: payload.principal,
        timestampMs: entry.committedAtMs,
        dedupeKey: `session.attachment:${entry.sessionId}:${entry.ordinal}`,
      });
    }
    // COR-1828: the decision's resolved-review record rides the same replay, so a crash after the
    // session commit leaves it for the next drain, as it leaves the audit entry.
    await peers.recordResolvedReview(payload, entry.committedAtMs);
    if (payload.decisionRequest !== undefined) {
      const recorded = await core.reviewDecisions.markRecorded(payload.decisionRequest);
      const inspection = recorded
        ? undefined
        : await core.reviewDecisions.inspect(payload.decisionRequest);
      if (!recorded && (inspection?.outcome !== 'matching' || !inspection.recorded)) {
        throw new Error(
          `could not mark review decision "${payload.decisionRequest.reviewId}" recorded before acknowledging its outbox entry`,
        );
      }
    }
    return acknowledge();
  }

  /** Releases an expired session's asset claims once its `session.deleted` entry drains; never rejects. */
  async function releaseExpiredSessionAssetClaims(entry: SessionOutboxEntry): Promise<void> {
    const key = `${entry.sessionId}\u0000${entry.incarnation}`;
    const expired = expiringSessions.get(key);
    if (expired === undefined) return;
    expiringSessions.delete(key);
    try {
      await peers.releaseSessionGeneratedAssets(expired);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'assets',
        message: `[bureau] Could not release the asset claims of expired session "${entry.sessionId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  async function drainOutboxEntry(
    entry: SessionOutboxEntry,
    owner: DurableEventOwner,
    outboxSessionStore: SessionStore,
    producer: DurableEventProducer | undefined,
  ): Promise<'stop' | 'continue'> {
    if (entry.kind === 'session.attachment') {
      return drainOutboxAttachmentEntry(entry, outboxSessionStore);
    }
    // COR-718 — the deletion's audit entry carries the owner the session had, which
    // the audit listener reads synchronously, so it is loaded before the dispatch.
    if (
      entry.kind === 'session.deleted' &&
      !(await peers.loadSessionDeletionOwner(entry.sessionId, entry.incarnation))
    ) {
      return 'stop';
    }
    // COR-713: every row that enters a session's history arrived in a commit this drain replays,
    // so this is where the rows' claims on the assets they reference are taken, and they are
    // taken BEFORE the entry is dispatched and acknowledged: the entry is the only cue that the
    // commit still needs its claims, so a claim that fails (or a process that exits first) leaves
    // it pending for the next pass. An expired session's claims are released here too once the
    // store has removed it; that only shortens an asset's life, so it runs beside the drain.
    if (entry.kind === 'session.created' || entry.kind === 'session.saved') {
      // A Bureau with no asset service has no claims to take, so it does not read the session at
      // all: a failing load cannot stop its drain, and the read costs nothing per entry.
      if (assetServiceHolder.current !== undefined) {
        try {
          const committed = await outboxSessionStore.load(entry.sessionId);
          if (committed !== undefined && committed.incarnation === entry.incarnation) {
            await peers.claimSessionAssets(committed);
          }
        } catch (error) {
          // Only a transient failure reaches here: a claim that cannot succeed (a corrupt asset
          // record) was reported, remembered and skipped by `claimSessionAssets`, so it never
          // holds back the entry or the events behind it.
          diagnose({
            level: 'error',
            scope: 'assets',
            message: `[bureau] Could not claim the assets of session "${entry.sessionId}" for its outbox entry ${entry.ordinal}; leaving it pending for a later drain to retry: ${serializeUnknownError(error)}`,
            cause: error,
          });
          return 'stop';
        }
      }
    } else if (entry.kind === 'session.deleted') {
      peers.trackSessionInputSettlement(releaseExpiredSessionAssetClaims(entry));
    }
    // AB-389 (Codex P2 review finding, PR #598, "Isolate subscriber
    // exceptions while draining the outbox"): `emitter.dispatch()`
    // fans out to two kinds of listener — `addEventListener`-registered
    // ones (this includes `durableEventProducerInstance`'s own
    // write-tracking listener, native-`EventTarget`-isolated per spec:
    // a throw there never reaches this call) and a public
    // `bureau.toObservable()` subscriber, which has NO such isolation
    // (`CompletableEventTarget.dispatchEvent` calls those directly, no
    // try/catch of its own — see that class's own doc comment on why
    // this is intentionally NOT fixed there: `active-run-adapter.ts`'s
    // OWN emitter relies on a throwing observer aborting its dispatch
    // call, an unrelated, already-tested contract this fix must not
    // disturb). Isolated HERE instead, scoped to exactly this call
    // site: because the native listener above already started
    // tracking its write synchronously before any observer runs, a
    // throw from a downstream OBSERVER can never un-start that write —
    // catching it here just stops one badly-behaved subscriber from
    // permanently wedging the RESERVED lowest-ordinal entry (returned
    // on every retry) and starving every later session lifecycle fact
    // behind it.
    try {
      switch (entry.kind) {
        case 'session.created':
          emitter.dispatch(
            new SessionCreatedEvent(
              entry.sessionId,
              entry.agentName,
              entry.incarnation,
              entry.ordinal,
              entry.committedAtMs,
            ),
          );
          break;
        case 'session.saved':
          emitter.dispatch(
            new SessionSavedEvent(
              entry.sessionId,
              entry.agentName,
              entry.incarnation,
              entry.ordinal,
              entry.committedAtMs,
            ),
          );
          break;
        case 'session.deleted':
          emitter.dispatch(
            new SessionDeletedEvent(
              entry.sessionId,
              entry.incarnation,
              entry.ordinal,
              entry.committedAtMs,
            ),
          );
          break;
      }
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] A bureau.toObservable() subscriber threw while replaying session outbox entry ${entry.ordinal} (${entry.kind} for session "${entry.sessionId}"); continuing the drain:`,
        cause: error,
      });
    }
    // Waits for the durable write THIS dispatch just started (and
    // any other write already in flight for the same owner) to
    // settle before acknowledging — never before. `dispatch()` calls
    // `durable-event-history.ts`'s listener synchronously, which
    // starts tracking the write before `dispatch()` itself returns,
    // so this snapshot-then-await always catches it.
    await producer?.waitForActiveWrites(owner);
    // AB-389 (Codex P1 review finding, PR #598, "Retain the outbox
    // entry when its durable write fails"): `waitForActiveWrites`
    // resolving proves only that the write SETTLED, never that it
    // SUCCEEDED — a storage failure is diagnosed and swallowed by the
    // write's own listener, never surfaced here. Verifying via
    // `wasRecorded` (the SAME dedupe identity `record()` itself checks
    // — this entry's own ordinal) before acknowledging closes that
    // gap: a failed write leaves the entry pending for a LATER drain
    // to retry, rather than being permanently discarded even though
    // nothing durable was ever recorded. Skipped entirely when there
    // is no durable event history to verify against (`eventHistoryInstance`
    // absent) — acknowledging immediately is correct there, per this
    // function's own doc comment on why `producer` alone gates the
    // wait above.
    if (core.eventHistoryInstance) {
      const wasRecorded = await core.eventHistoryInstance.wasRecorded(
        owner,
        entry.kind,
        String(entry.ordinal),
      );
      if (!wasRecorded) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Session outbox entry ${entry.ordinal} (${entry.kind} for session "${entry.sessionId}") was not durably recorded; leaving it pending for a later drain to retry.`,
        });
        // Stop this pass here, rather than spinning on the same
        // still-failing entry forever within this one call: a LATER,
        // distinct trigger (the next commit, or the next maintenance
        // tick) starts a fresh pass and gets a fresh chance at it.
        return 'stop';
      }
    }
    // AB-389 (Codex P1 review finding, PR #598, "Verify deletion audit
    // persistence before acknowledging"): `audit-trail.ts`'s own
    // `session.deleted` listener writes an out-of-band KV record
    // through the SAME swallow-and-diagnose discipline `sink()` uses
    // for durable history — a failed `kv.set()` never surfaces to this
    // drain. `eventHistoryInstance`'s own `wasRecorded` check above
    // verifies ONLY durable event history, which can be entirely
    // absent (a KV-only bureau with no durable engine) even though the
    // audit trail is configured and its write is the ONLY record of
    // this deletion. `query({ runId })` already waits for that
    // specific owner's in-flight write to settle (AB-228) before
    // reading back, so this both waits AND verifies in one call — a
    // bureau with no `runtime.kv` configured skips this entirely
    // (`query()` always returns `[]` there, which would otherwise read
    // as a permanent, un-retryable failure).
    if (entry.kind === 'session.deleted' && core.auditTrailInstance && runtime.kv) {
      const ownerRunId = auditTrailSessionOwnerId(entry.sessionId);
      const records = await core.auditTrailInstance.query({
        runId: ownerRunId,
        type: 'session.deleted',
      });
      const persisted = records.some((record) => {
        const detail = record.detail;
        return (
          typeof detail === 'object' &&
          detail !== null &&
          'incarnation' in detail &&
          detail.incarnation === entry.incarnation
        );
      });
      if (!persisted) {
        diagnose({
          level: 'error',
          scope: 'durable-maintenance',
          message: `[bureau] Session outbox entry ${entry.ordinal} (session.deleted for session "${entry.sessionId}") was not durably recorded in the audit trail; leaving it pending for a later drain to retry.`,
        });
        return 'stop';
      }
    }
    const acknowledged = await outboxSessionStore.outbox.acknowledge(
      entry.ordinal,
      core.outboxDrainOwner,
    );
    // AB-390 — a `false` here means a different owner reclaimed this
    // entry between this pass's `claim()` above and this point (this
    // owner's own lease must have lapsed under an unusually slow
    // durable write, outrunning even the renewal timer above). The
    // dispatch above already ran, so the current claimant's own
    // acknowledge (or a future one) retires the entry; continuing
    // this pass past a lost claim risks the same reordering hazard
    // the claim-before-replay check above exists to prevent.
    if (!acknowledged) {
      diagnose({
        level: 'error',
        scope: 'durable-maintenance',
        message: `[bureau] Lost the claim on session outbox entry ${entry.ordinal} (${entry.kind} for session "${entry.sessionId}") before acknowledging it; a different drainer reclaimed and will retire it.`,
      });
      return 'stop';
    }
    // The audit entry is verified and the outbox entry acknowledged, so the side
    // record has done its work.
    if (entry.kind === 'session.deleted') {
      await peers.removeSessionDeletionOwner(entry.sessionId, entry.incarnation);
    }
    return 'continue';
  }

  return { drainOutbox };
}
