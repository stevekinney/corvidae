/**
 * Shutdown (COR-2376 slice S3): `Bureau.shutdown` and `Bureau.dispose`, the one teardown of a
 * Bureau, and the list of subsystems its report covers. Built by `constructBureau` and reached only
 * through `createBureau`. The order of the teardown inside `shutdown` is a contract.
 */
import { ABORTED_RUN_TERMINAL_GRACE_MILLISECONDS } from '../durable-run-waits';
import type { ActiveRun } from '@lostgradient/operative';
import type { AgentDefinitions } from '../agent-catalog';
import type { BureauCore } from './core';
import { BureauDisposedEvent } from '../events';
import type {
  BureauShutdownOptions,
  BureauShutdownOwnerReport,
  BureauShutdownReport,
  CleanupAcknowledgement,
} from '../bureau-types/facade';
import type { RuntimeTimeoutHandle } from '@lostgradient/lifecycle';
import { detachBestEffortPromise } from '../bureau-construction-support';
import { disposeRunEventFeed } from '../run-event-feed-attachment.ts';
import { serializeUnknownError } from '../serialization';

/** The callables shutdown reads from elsewhere in `constructBureau`. */
export interface ShutdownPeers {
  /** Resolves once an active run has reached a terminal state. */
  readonly whenActiveRunTerminal: (activeRun: ActiveRun) => Promise<void>;
  /** Resolves once an errored run has finished ending. */
  readonly whenErroredRunEnds: (activeRun: ActiveRun) => Promise<void>;
  /** Stops the lazy expiry sweep. */
  readonly stopLazyExpirySweep: () => void;
  /** Releases a run's hold on its session's inputs. */
  readonly releaseSessionInputs: (sessionId: string, runId: string) => Promise<void>;
  /** Tells whoever waits on a run's terminal session record that it will not be written. */
  readonly abandonTerminalSessionRecord: (runId: string) => void;
  /** Waits for the session input settlements under way. */
  readonly drainSessionInputSettlements: () => Promise<void>;
}

/** Builds the shutdown functions of one Bureau. Synchronous, and registers nothing. */
export function createShutdown<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: ShutdownPeers,
) {
  const {
    assetServiceInstance,
    ownsStore,
    runtimeServices,
    store,
    emitter,
    eventFeed,
    eventFeedSubscription,
    stopForwarding,
    runEventFeeds,
    runtime,
    diagnose,
    activeRuns,
    erroredActiveRuns,
    recoveredActiveRuns,
    runsStoppedByShutdown,
    catalogRuns,
    runToolboxes,
    runToolboxesByRunId,
    backgroundShutdownController,
    terminalSessionRecordSettlers,
    sessionInputClosing,
    sessionInputGates,
    steeringCursors,
    steeringQueues,
    steeringPollers,
    inFlightSteeringPolls,
    inFlightSteeringSubmissions,
    inFlightSessionInputAdmissions,
    shutdownTimeoutSleep,
    manualDurableMaintenancePasses,
  } = core;

  /**
   * Every subsystem kind {@link BureauShutdownReport.owners} can report on.
   * `'heartbeat'` is reserved for the day Bureau composes one — see
   * `composedOwnerKinds` below, which decides which kinds actually get a row.
   */
  const ALL_SHUTDOWN_OWNER_KINDS = [
    'online-evals',
    'webhook-notifier',
    'audit-trail',
    'event-history',
    'assets',
    'durable-engine',
  ] as const;

  function shutdown(shutdownOptions?: BureauShutdownOptions): Promise<BureauShutdownReport> {
    // Idempotency guard: shutdown()/dispose() may be called more than once
    // (the harness does in tests, and `[Symbol.dispose]` may re-enter).
    // Disposing the engine and especially the raw Storage twice can close an
    // already-closed SQLite connection; a second call returns the first
    // call's already-cached report promise, ignoring whatever `policy` it
    // was given — the FIRST call's policy is what actually ran.
    if (core.shutdownPromise) return core.shutdownPromise;
    // COR-690: close run admission before anything below snapshots the active
    // runs or run toolboxes, so nothing admitted afterwards escapes the drain.
    core.runAdmissionClosed = true;
    sessionInputClosing.resolve();

    const policy: 'abort' | 'drain' | 'detach' = shutdownOptions?.policy ?? 'abort';
    const timeoutMilliseconds = shutdownOptions?.timeoutMilliseconds;
    // Capture the durable runs left for recovery at admission close: every one under 'detach',
    // and under 'abort' the ones this process recovered rather than started. The report
    // must count the same run identities that are still active when teardown
    // settles, not a stale size snapshot: a run may complete while shutdown
    // is waiting for workflow/toolbox/owner cleanup.
    const detachedRuns = new Set<ActiveRun>(
      runtime.durable && policy !== 'drain'
        ? [...activeRuns].filter((run) => policy === 'detach' || recoveredActiveRuns.has(run))
        : [],
    );

    // COR-1527: stop reacting to the workflow files at once, so nothing registers with an engine
    // that is about to be disposed; the chain below waits for the apply in progress first.
    const workflowClosed = core.workflowRuntime?.close();

    // Which owners this bureau actually composes — a report row is emitted
    // ONLY for a composed owner (2026-09-02 coordinator ruling).
    const composedOwnerKinds = ALL_SHUTDOWN_OWNER_KINDS.filter((kind) => {
      if (kind === 'online-evals') return Boolean(core.scorerSamplerInstance);
      if (kind === 'webhook-notifier') return Boolean(core.webhookNotifierInstance);
      if (kind === 'audit-trail') return Boolean(core.auditTrailInstance);
      if (kind === 'event-history') return Boolean(core.eventHistoryInstance);
      if (kind === 'assets') return Boolean(assetServiceInstance);
      return Boolean(runtime.durable);
    });
    const ownerOutcomes = new Map<
      (typeof ALL_SHUTDOWN_OWNER_KINDS)[number],
      CleanupAcknowledgement
    >();

    function buildReport(): BureauShutdownReport {
      const owners: BureauShutdownOwnerReport[] = composedOwnerKinds.map((kind) => ({
        kind,
        outcome: ownerOutcomes.get(kind) ?? 'unresolved',
      }));
      // A `.filter().length` per outcome (armorer's own `ExecutionCleanupReport`
      // shape) rather than one accumulating loop: every predicate runs for
      // every owner regardless of count, so `notRequired` reads as covered
      // even on a run with zero `'not-required'` owners today (the union
      // member is reserved per the shared vocabulary; no Bureau owner
      // currently produces it).
      return Object.freeze({
        admissionClosed: true,
        policy,
        detached: [...detachedRuns].filter((run) => activeRuns.has(run)).length,
        requested: owners.length,
        completed: owners.filter((owner) => owner.outcome === 'completed').length,
        failed: owners.filter((owner) => owner.outcome === 'failed').length,
        unresolved: owners.filter((owner) => owner.outcome === 'unresolved').length,
        notRequired: owners.filter((owner) => owner.outcome === 'not-required').length,
        owners: Object.freeze(owners),
      });
    }

    // Awaits `run()`, recording its outcome ('completed'/'failed') into
    // `ownerOutcomes`. Never throws — a rejecting owner drain is diagnosed
    // and recorded, not propagated, so one failing owner cannot skip the
    // unconditional backend teardown below (same isolation the pre-AB-207
    // `dispose()` already gave catalog-run `abort()` failures).
    async function settleOwner(
      kind: (typeof ALL_SHUTDOWN_OWNER_KINDS)[number],
      run: () => Promise<unknown>,
    ): Promise<void> {
      try {
        await run();
        ownerOutcomes.set(kind, 'completed');
      } catch (error) {
        ownerOutcomes.set(kind, 'failed');
        diagnose({
          level: 'error',
          scope: 'shutdown',
          message: `[bureau] Error during ${kind} shutdown: ${serializeUnknownError(error)}`,
        });
      }
    }

    // Resolves once every run in `terminals` has reached a terminal event,
    // or once `ABORTED_RUN_TERMINAL_GRACE_MILLISECONDS` has passed, whichever
    // comes first. The timer is cleared either way so it never outlives the
    // wait.
    async function awaitAbortedRunTerminals(terminals: Array<Promise<void>>): Promise<void> {
      if (terminals.length === 0) return;
      let graceTimer: RuntimeTimeoutHandle;
      const grace = new Promise<void>((resolve) => {
        graceTimer = runtimeServices.timers.setTimeout(
          resolve,
          ABORTED_RUN_TERMINAL_GRACE_MILLISECONDS,
        );
      });
      try {
        await Promise.race([Promise.all(terminals), grace]);
      } finally {
        runtimeServices.timers.clearTimeout(graceTimer);
      }
    }

    const chain = (async (): Promise<BureauShutdownReport> => {
      // COR-1527: a change being applied to the engine finishes while the engine is still there,
      // and nothing is applied after this, so the disposal below cannot race it.
      await workflowClosed;
      // Stop admission before touching runs. The canonical toolbox is the
      // owner of local execution lifecycle; await its shutdown as the
      // quiescence fence before releasing durable resources.
      runtime.baseToolbox.closeAdmission();
      for (const toolbox of runToolboxes) toolbox.closeAdmission();

      const runTerminals: Array<Promise<unknown>> = [];
      // Terminal events of the runs 'abort' aborts. Awaited, under a bound,
      // before the session-persistence drain below — see that await.
      const abortedRunTerminals: Array<Promise<void>> = [];
      // COR-1630 — the results of the catalog runs 'abort' aborts: each handle settling is what
      // starts that run's asset release, so the release is known only after it.
      const abortedCatalogRunResults: Array<Promise<void>> = [];
      const abortActiveRuns = policy === 'abort' || (policy === 'detach' && !runtime.durable);
      const abortCatalogRuns = policy === 'abort' || policy === 'detach';
      if (abortActiveRuns) {
        // Deliberately NOT awaited here (or anywhere gating the
        // unconditional engine/storage teardown below): a caller-owned
        // `ActiveRun` whose underlying provider call never honors its
        // `AbortSignal` (a hung dependency, not a well-behaved one) must
        // never be able to wedge the WHOLE shutdown chain open forever —
        // the critical backend teardown has to stay reachable regardless
        // of whether any individual run ever actually settles. A
        // well-behaved run's `abort()` drops its provider connection
        // immediately (see `active-run-adapter.ts`'s `abort()` doc), so its
        // terminal event — and any audit-trail/webhook-notifier write it
        // triggers — has ample opportunity to land during the real async
        // work the toolbox-shutdown await below already does, well before
        // the owner drains further down snapshot each subsystem's in-flight
        // writes.
        //
        // Each run's terminal listener is registered BEFORE its `abort()`,
        // which may dispatch `run.aborted` synchronously, and a member of
        // `activeRuns` has not dispatched a terminal event yet (its own
        // terminal listeners remove it first), as `whenActiveRunTerminal`
        // requires.
        for (const activeRun of activeRuns) {
          // A run this process recovered is left running for the next one, as under 'detach'.
          if (runtime.durable && recoveredActiveRuns.has(activeRun)) continue;
          abortedRunTerminals.push(peers.whenActiveRunTerminal(activeRun));
          runsStoppedByShutdown.add(activeRun);
          activeRun.abort('Bureau disposed');
        }
        // A run that already reported its error is over; it is not aborted, only waited for
        // under the same bound, so its terminal session save starts before the engine goes.
        for (const erroredRun of erroredActiveRuns) {
          abortedRunTerminals.push(peers.whenErroredRunEnds(erroredRun));
        }
        // AB-22 review fix: `bureau.run(...)` dispatches are tracked
        // separately (see `trackCatalogRun`) since a catalog `RunnableAgent`'s
        // returned handle is not necessarily backed by a bureau-owned
        // `ActiveRun` — its `abort()` can be arbitrary, untrusted code.
        // Snapshot before iterating (a synchronous catalog agent can settle
        // result() immediately from inside abort(), whose trackCatalogRun
        // cleanup deletes from catalogRuns mid-iteration), and isolate each
        // call: an in-flight custom handle throwing from abort() must not
        // reject this entire shutdown() before the unconditional teardown
        // below runs — that would skip toolbox shutdown, durable-engine
        // disposal, and storage closure, and since shutdownPromise is
        // already cached at this point, every subsequent shutdown()/dispose()
        // call would return the same rejection forever instead of ever
        // completing cleanup (review round 2, Codex).
      } else {
        // 'drain' waits caller-owned runs; 'detach' leaves durable caller-owned runs for recovery.
        for (const activeRun of activeRuns) {
          if (policy === 'drain') runTerminals.push(peers.whenActiveRunTerminal(activeRun));
        }
        for (const erroredRun of erroredActiveRuns) {
          runTerminals.push(peers.whenErroredRunEnds(erroredRun));
        }
      }
      if (abortCatalogRuns) {
        const currentCatalogRuns = [...catalogRuns];
        for (const catalogRun of currentCatalogRuns) {
          try {
            abortedCatalogRunResults.push(
              Promise.allSettled([catalogRun.result()]).then(() => undefined),
            );
          } catch {
            // A custom handle whose result() throws has no result to wait for; its abort() below
            // is still called, and its release, if any, is not waited for.
          }
        }
        for (const catalogRun of currentCatalogRuns) {
          try {
            catalogRun.abort('Bureau disposed');
          } catch (error) {
            diagnose({
              level: 'error',
              scope: 'shutdown',
              message: `[bureau] A catalog run's abort() threw during disposal; continuing teardown: ${serializeUnknownError(error)}`,
            });
          }
        }
      } else {
        // Catalog runs are caller-owned too, but unlike durable ActiveRuns they have no recovery
        // record, so detach retains the existing abort behavior for them.
        const currentCatalogRuns = [...catalogRuns];
        for (const catalogRun of currentCatalogRuns) {
          runTerminals.push(Promise.allSettled([catalogRun.result()]));
        }
      }
      const toolboxes = [
        ...new Set([runtime.baseToolbox, ...runToolboxes, ...runToolboxesByRunId.values()]),
      ];
      const toolboxPolicy = policy === 'detach' ? 'abort' : policy;
      const toolboxShutdownResults = await Promise.allSettled([
        ...toolboxes.map((toolbox) =>
          toolbox.shutdown({ policy: toolboxPolicy, reason: 'Bureau disposed' }),
        ),
        ...runTerminals,
      ]);
      for (const result of toolboxShutdownResults) {
        if (result.status === 'rejected') {
          diagnose({
            level: 'error',
            scope: 'shutdown',
            message: `[bureau] Error during toolbox shutdown: ${serializeUnknownError(result.reason)}`,
          });
        }
      }

      // COR-1476 — every run's session input is released: the leases go back to
      // the mailbox and the unpromoted claims are dropped, so the next boot
      // delivers them. Shutdown only releases; it never starts a run.
      for (const [runId, { sessionId }] of sessionInputGates) {
        await peers.releaseSessionInputs(sessionId, runId);
      }

      // AB-363: stop the automatic-profile run-ownership pruning timer, if
      // one was started — `clearInterval` alone only cancels FUTURE ticks,
      // so a pass already in flight is also awaited here, before the
      // `eventHistoryInstance`/storage disposal further down this same
      // shutdown runs — otherwise that disposal could race an in-flight
      // pass still replaying the feed or mid-`sessionStore.update()`
      // (Codex review, PR #579, "Await running pruning passes before
      // backend teardown"). `pruneStaleRunOwnership()`'s own promise chain
      // already `.catch()`es every failure before this point, so awaiting
      // it here never throws.
      //
      // AB-389 (Codex P1 review finding, PR #598, "Await the chained drain
      // before aborting its producers"): this await MUST happen BEFORE
      // `backgroundShutdownController.abort()` below, not after — the pass
      // this awaits chains `drainOutbox()` onto `pruneStaleRunOwnership()`
      // (see the interval callback's own doc comment), and every session
      // lifecycle listener `createDurableEventProducer` registers checks
      // `signal?.aborted` and returns immediately once that shared signal
      // is aborted, recording nothing. Aborting first would let a pass
      // already inside `pruneStaleRunOwnership()` run its chained drain
      // AFTER the abort, dispatching outbox entries whose durable writes
      // never start — `wasRecorded` still leaves those entries pending for
      // a later drain (the safety net a redelivery relies on generally),
      // but there is no reason to manufacture that residual here when
      // simply awaiting first avoids it entirely.
      //
      // AB-388 (Codex review, PR #597, "Fence maintenance admission once
      // shutdown starts"): closed HERE, synchronously, before anything
      // below this line awaits — see `maintenanceAdmissionClosed`'s own
      // doc comment for why the ordering matters.
      core.maintenanceAdmissionClosed = true;
      // COR-772 — land every child-settlement write the run teardown above
      // produced before the audit trail and storage below go away. Only
      // writes already under way are awaited here, not a child's own result.
      // The bounded wait on child results for 'abort' shutdown comes below, so
      // a child that ignores its abort costs at most that bound.
      await core.childTopology.drain();
      // COR-851 — land every goal signal already being sent. A goal interrupted
      // by shutdown is deliberately left non-terminal for the next process.
      await core.goalsComposition.drain();
      // Land terminal session saves already under way before the outbox
      // drain await and `backgroundShutdownController.abort()` below: a save
      // committing after that abort leaves its `session.saved` entry
      // unrecorded. Its commit triggers the drain synchronously, so the
      // `outboxDrainInFlight` await then covers it. See `drain()` for why
      // this cannot wedge on a run; `timeoutMilliseconds` bounds a hung store.
      //
      // An aborted run's save starts later than that: its `run.aborted`
      // listener runs only once the run has unwound, which is usually after
      // the waits above have passed. So first give the runs 'abort' aborted
      // a bounded chance to reach their terminal event — each one's save
      // has started by the time it resolves, because its own terminal
      // listener was registered first — and a run that never honors its
      // abort only costs this bound, never a wedged shutdown.
      await awaitAbortedRunTerminals(abortedRunTerminals);
      // A child aborted by this shutdown records its `aborted` settlement only
      // once its own result arrives, which a durable child's fenced
      // cancellation makes later than the drain above looked. Wait for it,
      // under the same bound, so the audit trail is still open to take it. 'detach' aborts
      // children as 'abort' does, so it waits for them too.
      if (abortCatalogRuns && core.childTopology.awaitingSettlements() > 0) {
        await awaitAbortedRunTerminals([core.childTopology.settlementsKnown()]);
      }
      await core.childTopology.drain();
      await core.sessionPersistence.drain();
      await peers.drainSessionInputSettlements();
      // COR-1630 — a catalog run that ended releases its asset claims, shutdown or not. The
      // aborted runs settle first, under the grace above, which starts their releases. A release
      // is storage work on a run that has ended, so it is awaited however long the database takes,
      // not under that grace: a release the grace cut short wrote against the asset service and the
      // pool after they closed below. Releases close in the step that finds none left
      // (`createCatalogAssetReleaseDrain`). A run whose durable record still reads in flight is
      // lost, not ended, and releases nothing (`catalog-run-asset-release.ts`).
      await awaitAbortedRunTerminals(abortedCatalogRunResults);
      await core.catalogAssetReleases.drain();
      if (core.automaticRunOwnershipPruneTimerStarted) {
        runtimeServices.timers.clearInterval(core.automaticRunOwnershipPruneTimer);
        core.automaticRunOwnershipPruneTimerStarted = false;
      }
      // COR-1622: the expiry sweep's own timer, and a pass still under way.
      peers.stopLazyExpirySweep();
      await core.lazyExpirySweepPass;
      // AB-390 — the session-outbox retry timer (armed when this bureau
      // last lost a claim to a still-live peer) must not fire after
      // shutdown: a retry drain running post-teardown would race the very
      // cleanup this shutdown sequence exists to make orderly.
      if (core.outboxRetryTimerArmedForMs !== undefined) {
        runtimeServices.timers.clearTimeout(core.outboxRetryTimerHandle);
        core.outboxRetryTimerArmedForMs = undefined;
      }
      // Codex P2 review finding, PR #599, "Await retry drains that have
      // already fired during shutdown": `clearTimeout` above only prevents
      // a NOT-YET-FIRED retry timer from firing — it cannot un-fire one
      // whose callback already started (armed, then fired, in the window
      // before this shutdown sequence reached this line) and is still
      // running its own `drainOutbox()` call. Without this await,
      // shutdown would proceed to abort producers and dispose durable
      // event history storage while that drain is still dispatching
      // events or reading/writing storage concurrently with teardown.
      if (core.outboxDrainInFlight) {
        await core.outboxDrainInFlight;
      }
      if (core.automaticRunOwnershipPruneCurrentPass) {
        await core.automaticRunOwnershipPruneCurrentPass;
      }
      if (core.taskResyncBootPass) await core.taskResyncBootPass;
      // COR-1946: no further lease renewals or sweeps; the lease itself is removed last.
      core.processLease.halt();
      await core.abandonedTaskSweeper.close();
      // AB-388: drain any manual `maintain()` call(s) still in
      // flight — see `manualDurableMaintenancePasses`'s own doc comment
      // above. `allSettled` (never `all`): a rejection here is either
      // already diagnosed by the pass's own sub-pass try/catch, or is a
      // re-thrown `engineMaintenanceError` the ORIGINAL caller of
      // `maintain()` observes directly — `shutdown()` must
      // still complete backend teardown either way. Drained in the SAME
      // place, and for the SAME reason, as the automatic pass's own await
      // just above: both must settle before the shared signal aborts and
      // before backend teardown below.
      if (manualDurableMaintenancePasses.size > 0) {
        await Promise.allSettled(manualDurableMaintenancePasses);
      }
      // Bureau-owned background work is stopped/awaited identically under
      // BOTH policies (2026-09-02 coordinator ruling) — abort the shared
      // signal now, AFTER runs are aborted/drained, toolbox shutdown is
      // awaited above, and the pruning/outbox pass above has settled, so
      // an in-flight judge invocation / webhook delivery settles promptly
      // against the owner drains immediately below rather than being told
      // to abort before shutdown has even started (which would make the
      // audit trail's `if (signal?.aborted) return` above drop the very
      // `run.aborted`/`tool.*` records this shutdown produces).
      backgroundShutdownController.abort();

      // All pre-teardown is BEST-EFFORT, and the whole body is under an OUTER
      // try/finally so the critical backend teardown (engine → storage → store)
      // ALWAYS runs. The synchronous steps below are fallible —
      // `emitter.dispatch`/`emitter.complete` route through
      // `CompletableEventTarget.dispatchEvent`, which loops over `toObservable()`
      // subscribers WITHOUT a try/catch, so a subscriber whose `next`/`complete`
      // throws propagates straight back here. That path is reachable through the
      // public Bureau surface (`toObservable()`), so the synchronous pre-teardown
      // is wrapped to swallow-and-log: a throwing subscriber must not strand the
      // SQLite/LMDB handle behind the now-`true` `disposed` guard (a second
      // dispose no-ops), leaking it permanently. Covered by the
      // "toObservable subscriber throws during dispose" regression test.
      try {
        // `runtime.memory.close()` stays a detached best-effort call — it is
        // not one of the owners this issue's report covers (2026-09-02
        // ruling: scheduler, online-evals, webhook notifier, audit trail,
        // durable engine).
        if (runtime.memory) {
          detachBestEffortPromise(runtime.memory.close());
        }

        try {
          // Dispose every Bureau-owned background subsystem — AWAITED, not
          // detached (AB-207/AB-37): each is a report-tracked owner drain,
          // run concurrently, before emitting bureau.disposed so any
          // in-flight write/delivery/evaluation callback is unsubscribed
          // cleanly (the webhook notifier also abandons in-flight backoff
          // waits so a disposed bureau never fires a webhook late).
          const ownerDrains: Array<Promise<void>> = [];
          if (core.auditTrailInstance) {
            const auditTrail = core.auditTrailInstance;
            ownerDrains.push(settleOwner('audit-trail', () => auditTrail.dispose()));
          }
          if (core.eventHistoryInstance) {
            const eventHistory = core.eventHistoryInstance;
            const durableEventProducer = core.durableEventProducerInstance;
            ownerDrains.push(
              settleOwner('event-history', async () => {
                // The producer (its bureau-event listeners) is disposed
                // BEFORE the store it writes into, so no in-flight
                // `record()` call can start against an already-disposed
                // `FleetEventFeed` (AB-311).
                // The follower's subscription ends before the feed it reads is released.
                await core.fireReviewFollower?.dispose();
                if (durableEventProducer) await durableEventProducer.dispose();
                await eventHistory.dispose();
              }),
            );
          }
          if (core.webhookNotifierInstance) {
            const webhookNotifier = core.webhookNotifierInstance;
            ownerDrains.push(settleOwner('webhook-notifier', () => webhookNotifier.dispose()));
          }
          if (core.scorerSamplerInstance) {
            const scorerSampler = core.scorerSamplerInstance;
            ownerDrains.push(settleOwner('online-evals', () => scorerSampler.dispose()));
          }
          if (assetServiceInstance) {
            // COR-794: aborts every in-flight asset operation and awaits each
            // one's cleanup acknowledgement, and clears the collection timer.
            const assetService = assetServiceInstance;
            ownerDrains.push(
              settleOwner('assets', async () => {
                const report = await assetService.shutdown();
                // A work handle whose cleanup did not complete fails the owner, not just its report.
                const unclean = report.acknowledgements.filter(
                  ({ acknowledgement }) => acknowledgement.status !== 'completed',
                );
                if (unclean.length > 0) {
                  throw new Error(
                    `Asset work did not clean up: ${unclean.map(({ workId }) => workId).join(', ')}`,
                  );
                }
              }),
            );
          }
          await Promise.allSettled(ownerDrains);
          // COR-1481 — the settlement and cleanup writes of tasks whose runs have just ended land
          // before the storage they write to is closed.
          await core.tasks.flush();
          // COR-1631 — so do the freezes of the surfaces those settlements started.
          await core.surfaces?.flush();
          // COR-1941 — so do the notifications those settlements wrote.
          await core.notificationsComposition.drain();

          for (const stop of stopForwarding) stop();
          emitter.dispatch(new BureauDisposedEvent());
          core.storeSubscription.unsubscribe();
          // After `BureauDisposedEvent` is dispatched, so the feed records
          // its own last event before it stops recording. Unsubscribing
          // first, then disposing, ends every watcher: disposal aborts the
          // feed's lifetime signal, which each subscription is bound to.
          eventFeedSubscription.unsubscribe();
          core.notificationsComposition.stop();
          // Any run feed still registered goes with it — `run.removed` reaps
          // the runs a host deleted, and this covers the rest.
          for (const feedRunId of runEventFeeds.runIds()) {
            disposeRunEventFeed(feedRunId, runEventFeeds);
          }
          eventFeed.dispose();
          emitter.complete();
        } catch (error) {
          diagnose({
            level: 'error',
            scope: 'shutdown',
            message: `[bureau] Error during shutdown pre-teardown: ${serializeUnknownError(error)}`,
          });
        }
      } finally {
        // The per-run `resolveWorkflowServices` resolver is engine-scoped and is
        // released when the engine is disposed below — there is no module-global
        // reconstructor to clear here anymore.
        //
        // Dispose the durable run engine, then fence off the raw Storage, then the
        // store — each guarded so a throw in one stage does not skip the next (engine
        // dispose is synchronous and can throw in a degraded environment). The raw
        // Storage is the caller's: Bureau stops using it but never closes it, so the
        // caller closes it after this shutdown returns.
        try {
          // Observability dispose runs BEFORE engine dispose: it ends still-open
          // spans and unsubscribes the engine lifecycle listeners. If the engine
          // were disposed first, those listeners would already be gone, so the spans
          // they would have closed in response to the engine's terminal-disposal
          // events would leak instead. Best-effort — a throw here must not skip the
          // backend teardown below.
          try {
            runtime.durable?.observability?.dispose();
          } catch (error) {
            diagnose({
              level: 'error',
              scope: 'shutdown',
              message: `[bureau] Error disposing durable observability: ${serializeUnknownError(error)}`,
            });
          }
          // AB-207: prefer the async disposal path (`[Symbol.asyncDispose]`)
          // over the synchronous one — `RegistryAgnosticEngine` always
          // implements both `Disposable` and `AsyncDisposable`, so this
          // await genuinely observes the engine's own drain rather than
          // firing a sync teardown and moving on.
          // Steering admissions already queued read the engine's run
          // liveness, so they finish before it is disposed; admission closed
          // with `runAdmissionClosed`. Run-boundary appends queued while the
          // engine drains are awaited again below, before the backend closes.
          // The steering pollers stop first, so none queues a fold after it.
          for (const poller of steeringPollers.values()) {
            runtimeServices.timers.clearInterval(poller.timer);
          }
          steeringPollers.clear();
          // COR-1476 — session-input admissions in flight read the engine and
          // the log the same way, and are closed with `runAdmissionClosed` too.
          await Promise.allSettled([
            ...inFlightSteeringSubmissions,
            ...inFlightSessionInputAdmissions.values(),
            ...inFlightSteeringPolls,
            ...steeringQueues.values(),
          ]);
          if (runtime.durable) {
            const engine = runtime.durable.engine;
            await settleOwner('durable-engine', () => engine[Symbol.asyncDispose]());
          }
          // COR-1481 — disposing the engine is what ends a durable run that was still in flight,
          // and each run's `closed()` acknowledgement lands as it does. The cleanup the registry
          // follows is awaited, with the writes it starts, before the backend closes under them.
          // A run whose end is known after this records nothing (COR-2005): the tracker is closed.
          await core.catalogSettlements.settled();
          await core.tasks.idle();
          // COR-1631 — those settlements freeze their tasks' surfaces too; the freezes land
          // before the backend closes under them.
          await core.surfaces?.flush();
        } finally {
          // COR-2005 — `settled()` closed the tracker when it ran; this covers a drain that threw
          // before it did. A run that ends from here on records nothing: the storage is going away.
          core.catalogSettlements.close();
          // A run that ended in the drain without a save leaves no one to settle its record.
          for (const runId of terminalSessionRecordSettlers.keys()) {
            peers.abandonTerminalSessionRecord(runId);
          }
          try {
            // Pending steering log appends (run-boundary events are logged
            // in the background) finish before the backend closes under
            // them. Each one reports its own failure as a diagnostic.
            await core.steeringSweep;
            await Promise.allSettled(steeringQueues.values());
            steeringQueues.clear();
            steeringCursors.clear();
          } finally {
            try {
              // An agent-directory scan in flight records file revisions in storage, so the
              // watcher stops and drains before storage closes under it (COR-1669).
              await core.fileAgents?.files.close();
            } finally {
              // COR-1946: removed after every task write of this shutdown, so a peer need not wait
              // for it to lapse; a failure only means the peer waits.
              await core.processLease.release().catch((error: unknown) => {
                diagnose({
                  level: 'error',
                  scope: 'shutdown',
                  message: `[bureau] Could not remove the process lease: ${serializeUnknownError(error)}`,
                  cause: error,
                });
              });
              try {
                // Bureau stops using the caller's storage, which the caller closes (COR-1767).
                runtime.stopUsingStorage();
              } finally {
                if (ownsStore) {
                  store.dispose();
                }
              }
            }
          }
        }
      }
      // COR-1524: stop watching the agent directory and wait for a scan in flight.
      await core.fileAgents?.files.close();
      return buildReport();
    })();

    // `shutdown()` is documented to never reject — every internal step above
    // is already best-effort (`settleOwner` catches and records failures),
    // but some unforeseen failure inside `chain` or the timeout sleep must not propagate through
    // `Promise.race`/the bare chain reference. This `.catch` is the single
    // fallback fence: diagnose, then resolve with the best-effort report
    // `buildReport()` can still produce from whatever `ownerOutcomes` were
    // recorded before the failure (review finding, PR #442).
    function settleNeverRejecting(
      promise: Promise<BureauShutdownReport>,
    ): Promise<BureauShutdownReport> {
      return promise.catch((error: unknown) => {
        diagnose({
          level: 'error',
          scope: 'shutdown',
          message: `[bureau] shutdown() settled via an unexpected rejection, falling back to a best-effort report: ${serializeUnknownError(error)}`,
        });
        return buildReport();
      });
    }

    if (timeoutMilliseconds === undefined) {
      detachBestEffortPromise(chain);
      core.shutdownPromise = settleNeverRejecting(chain);
    } else {
      // Aborted once `chain` itself settles (by either winning the race or
      // losing it) so the timer never outlives this call — a `shutdown()`
      // whose real teardown finishes well inside `timeoutMilliseconds` must
      // not hold a live `setTimeout` open for the remainder of that budget.
      // `detachBestEffortPromise`, not a bare `void`, on the SAME derived
      // `.finally()` promise this covers both: an unhandled rejection from
      // `chain` and the timer-abort side effect.
      const timeoutAbort = new AbortController();
      detachBestEffortPromise(chain.finally(() => timeoutAbort.abort()));
      core.shutdownPromise = settleNeverRejecting(
        Promise.race([
          chain,
          shutdownTimeoutSleep(timeoutMilliseconds, timeoutAbort.signal).then(() => buildReport()),
        ]),
      );
    }

    return core.shutdownPromise;
  }

  // Cached separately from `shutdownPromise`: `dispose()` must keep returning
  // the SAME promise reference on repeat calls (no externally observable
  // regression vs. the pre-AB-207 caller-visible contract) — `shutdown()`'s
  // own idempotency guard caches its own report promise, but each call to
  // `.then(() => undefined)` below would otherwise mint a new derived
  // promise every time.
  let disposePromise: Promise<void> | undefined;

  function dispose(): Promise<void> {
    if (!disposePromise) {
      disposePromise = shutdown({ policy: 'abort' }).then(() => undefined);
    }
    return disposePromise;
  }

  return { shutdown, dispose };
}
