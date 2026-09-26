/**
 * A pool of {@link WorkerRealm} instances scoped to one immutable artifact
 * revision (COR-249).
 *
 * "One realm pool per immutable artifact revision" (COR-249's own issue
 * text) means every realm this pool ever warms is fixed, at construction,
 * to one `workerUrl`, one `expectedWorkflowTypes` list, and one
 * `expectedArtifactDigest` — never place unrelated revisions in one Worker.
 * A `RevisionRealmRegistry` (COR-249) is what owns one `RevisionRealmPool`
 * per `(name, revision)` and routes a start to the correct one.
 *
 * Each `WorkerRealm` in this pool serves exactly one execution end to end
 * (see `worker-realm.ts`'s module doc): `acquireForExecution` warms (or
 * reuses an idle, already-`Ready`) realm and activates it for a new
 * execution's `executionToken`; `releaseAfterExecution` drains and
 * terminates it once that execution finishes, "terminate drained Workers."
 * A pool does not reuse a realm across two different executions — each
 * `acquireForExecution` either takes an idle `Ready` realm this pool warmed
 * ahead of demand, or warms a fresh one on the spot, bounded by
 * `concurrency`.
 *
 * @module core/realm/revision-realm-pool
 */

import { WorkerRealm, type WorkerRealmOptions } from './worker-realm.ts';

export interface RevisionRealmPoolOptions {
  readonly workflowRevision: string;
  readonly workerUrl: string | URL;
  readonly expectedWorkflowTypes: readonly string[];
  readonly expectedArtifactDigest?: string;
  /** Upper bound on realms concurrently warmed (idle or active) for this revision. */
  readonly concurrency: number;
  readonly maxRestarts?: number;
  readonly realmReadyTimeoutMs?: number;
  readonly maxProtocolMessageBytes?: number;
  readonly workerName?: string;
  readonly smol?: boolean;
}

export type RevisionRealmAcquireOutcome =
  | { ok: true; realm: WorkerRealm }
  | {
      ok: false;
      reason: 'revision-not-active' | 'realm-ready-handshake-failed' | 'pool-at-capacity';
      error?: string;
    };

/**
 * One revision's pool of {@link WorkerRealm} instances. `isReferenced` (a
 * {@link import('./realm-lifecycle.ts').RealmLifecycleDependencies}
 * dependency every realm this pool constructs shares) is this pool's own
 * "am I still active or does a realm still have work" check — see
 * {@link RevisionRealmPool.isReferenced}, not a per-realm concept.
 */
export class RevisionRealmPool {
  readonly #options: RevisionRealmPoolOptions;
  readonly #realms = new Set<WorkerRealm>();
  #revisionActive = true;
  #disposed = false;
  /**
   * Count of `acquireForExecution` calls currently suspended on `await
   * realm.waitUntilReady()` (or the recheck immediately after it), for a
   * realm that is not yet `Active`. `isDrained` must stay `false` while
   * this is nonzero: a realm mid-handshake is neither counted by
   * `activeRealmCount` (it is not yet `Active`) nor discarded by {@link
   * markInactive} (which only reclaims idle `Ready` realms), so without
   * this counter a registry's `#reclaimIfDrained` could dispose the whole
   * pool -- terminating the in-flight realm's underlying Worker -- while
   * an acquisition genuinely still has a claim on it.
   */
  #inFlightAcquisitions = 0;

  constructor(options: RevisionRealmPoolOptions) {
    this.#options = options;
  }

  /**
   * Warm (or reuse an idle `Ready`) realm and activate it for one new
   * execution. Refused with `revision-not-active` once {@link markInactive}
   * has been called — "activation routes new starts only to the newly
   * active revision" — never by silently routing a new start to a revision
   * that is no longer current. An in-flight execution that already holds a
   * realm is unaffected: it keeps dispatching turns to that same realm
   * directly, "the old realm remains available for runs pinned to it."
   */
  async acquireForExecution(executionToken: string): Promise<RevisionRealmAcquireOutcome> {
    if (this.#disposed || !this.#revisionActive) {
      return { ok: false, reason: 'revision-not-active' };
    }

    const realm = this.#takeIdleReadyRealm() ?? this.#warmNewRealmIfUnderCapacity();
    if (!realm) {
      return { ok: false, reason: 'pool-at-capacity' };
    }

    this.#inFlightAcquisitions += 1;
    try {
      const outcome = await realm.waitUntilReady();
      if (!outcome.ok) {
        // A rejected/timed-out ready handshake already leaves the realm's own
        // lifecycle in `Crashed` (see `WorkerRealm#settleReady`), but it never
        // terminates the underlying real Worker thread on its own -- that is
        // this pool's job, matching the existing `WorkerFaultHandler
        // .discardWorkerAndFailWorkflows` precedent for the identical failure
        // in the generic Worker-execution-mode path
        // (`worker-execution-strategy.ts`'s `#ensureRealmReady`). Without this,
        // the Worker thread outlives its dropped realm indefinitely.
        realm.discard();
        this.#realms.delete(realm);
        return { ok: false, reason: 'realm-ready-handshake-failed', error: outcome.error };
      }

      if (this.#disposed || !this.#revisionActive) {
        // The revision went inactive (or the whole pool was disposed) while
        // this realm's ready handshake was still in flight. "Activation
        // routes new starts only to the newly active revision" must hold
        // even though the realm itself finished warming successfully in the
        // interim -- discard the freshly-warmed realm instead of activating
        // it for a start nothing should route to any more.
        realm.discard();
        this.#realms.delete(realm);
        return { ok: false, reason: 'revision-not-active' };
      }

      realm.activate({
        workflowRevision: this.#options.workflowRevision,
        realmGeneration: outcome.realmGeneration,
        executionToken,
      });
      return { ok: true, realm };
    } finally {
      this.#inFlightAcquisitions -= 1;
    }
  }

  /**
   * Release a realm whose one execution finished (successfully, by failure,
   * or by cancellation). Drains and terminates it and drops it from this
   * pool's bookkeeping — a realm is never reused across two executions in
   * this slice (see the module doc). A no-op for a realm this pool does not
   * own (already released, or crashed and self-removed).
   */
  releaseAfterExecution(realm: WorkerRealm): void {
    if (!this.#realms.has(realm)) return;
    if (realm.lifecycle.state === 'active') realm.beginDrain();
    if (realm.lifecycle.state === 'draining') realm.terminate();
    this.#realms.delete(realm);
  }

  /** Drop a realm that crashed mid-execution from this pool's bookkeeping, without attempting to drain/terminate it again (its own crash handling already did that). */
  forgetCrashedRealm(realm: WorkerRealm): void {
    this.#realms.delete(realm);
  }

  /**
   * Mark this revision no longer the catalog's active pointer (COR-249:
   * "activation routes new starts only to the newly active revision"). Idle
   * (warmed but never-activated) realms are reclaimed immediately —
   * "terminate drained Workers" — since nothing is pinned to them; realms
   * mid-execution are left alone (they self-release through
   * {@link releaseAfterExecution} when their own execution finishes).
   */
  markInactive(): void {
    this.#revisionActive = false;
    for (const realm of this.#realms) {
      if (realm.lifecycle.state === 'ready') {
        realm.discard();
        this.#realms.delete(realm);
      }
    }
  }

  /** Re-mark this revision as the catalog's active pointer again (a later activation reactivating an older revision). */
  markActive(): void {
    this.#revisionActive = true;
  }

  /**
   * Active realm count — realms with at least one execution mid-flight.
   * Wired into `WorkflowRevisionReferenceCounts.activeExecutionRealms`
   * (COR-249).
   */
  get activeRealmCount(): number {
    let count = 0;
    for (const realm of this.#realms) if (realm.lifecycle.state === 'active') count += 1;
    return count;
  }

  /** Total realms this pool currently tracks (idle + active + draining), for diagnostics/tests. */
  get realmCount(): number {
    return this.#realms.size;
  }

  /**
   * True once nothing references this revision any more: it is not the
   * active pointer, no realm is mid-execution, and no acquisition is still
   * mid-handshake for it. This is the point at which a {@link
   * import('./revision-realm-registry.ts').RevisionRealmRegistry} can
   * reclaim the pool itself — "a drained realm with no pinned work
   * terminates." The in-flight-acquisition check matters exactly when a
   * realm has finished warming but the pool has not yet decided whether to
   * activate or discard it (see `acquireForExecution`'s post-handshake
   * recheck) — reclaiming the pool during that window would terminate a
   * realm a caller still has a live claim on.
   */
  get isDrained(): boolean {
    return !this.#revisionActive && this.activeRealmCount === 0 && this.#inFlightAcquisitions === 0;
  }

  /** Whether this pool still considers its revision referenced — the {@link import('./realm-lifecycle.ts').RealmLifecycleDependencies.isReferenced} every realm this pool constructs is given. Deliberately excludes `activeExecutionRealms` from its own reasoning: counting the realm asking the question would make an active revision's own realms permanently "referenced" even after the revision goes inactive, and a realm can never legitimately restart mid-drain regardless (see `markInactive`, which only ever discards *idle* realms). */
  isReferenced(): boolean {
    return this.#revisionActive;
  }

  /** Dispose the whole pool: discard every realm regardless of state. Used when a drained pool is finally removed from the registry, or on overall host shutdown. */
  dispose(): void {
    this.#disposed = true;
    for (const realm of this.#realms) realm.discard();
    this.#realms.clear();
  }

  #takeIdleReadyRealm(): WorkerRealm | undefined {
    for (const realm of this.#realms) {
      if (realm.lifecycle.state === 'ready') return realm;
    }
    return undefined;
  }

  #warmNewRealmIfUnderCapacity(): WorkerRealm | undefined {
    if (this.#realms.size >= this.#options.concurrency) return undefined;
    const realmOptions: WorkerRealmOptions = {
      workerUrl: this.#options.workerUrl,
      expectedWorkflowTypes: this.#options.expectedWorkflowTypes,
      isReferenced: () => this.isReferenced(),
      maxRestarts: this.#options.maxRestarts ?? 0,
      ...(this.#options.expectedArtifactDigest === undefined
        ? {}
        : { expectedArtifactDigest: this.#options.expectedArtifactDigest }),
      ...(this.#options.realmReadyTimeoutMs === undefined
        ? {}
        : { realmReadyTimeoutMs: this.#options.realmReadyTimeoutMs }),
      ...(this.#options.maxProtocolMessageBytes === undefined
        ? {}
        : { maxProtocolMessageBytes: this.#options.maxProtocolMessageBytes }),
      ...(this.#options.workerName === undefined ? {} : { workerName: this.#options.workerName }),
      ...(this.#options.smol === undefined ? {} : { smol: this.#options.smol }),
    };
    const realm = new WorkerRealm(realmOptions);
    this.#realms.add(realm);
    return realm;
  }
}
