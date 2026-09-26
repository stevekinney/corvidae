import type { WorkerPool } from '../workers/pool.ts';
import type { ExecutionStrategy } from './execution-strategy.ts';
import type { OperationOutcome, WorkerInboundMessage, WorkerOutboundMessage } from './types.ts';
import { WorkerCheckpointResumeState } from './worker-checkpoint-resume-state.ts';
import { WorkerExecutionDispatcher } from './worker-execution-dispatcher.ts';
import { WorkerExecutionOwnership } from './worker-execution-ownership.ts';
import type { WorkerExecutionStrategyOptions } from './worker-execution-strategy-options.ts';
import { WorkerFaultHandler } from './worker-fault-handling.ts';
import {
  buildResumeMessage,
  buildRunMessage,
  type WorkerInboundMessageContext,
} from './worker-inbound-message.ts';
import { WorkerListenerRegistry } from './worker-listener-registry.ts';
import {
  forwardedLogGateFromStrategyOptions,
  type ForwardedLogGate,
} from './worker-log-abuse-counter.ts';
import {
  emitWorkerMessageToEngine,
  isParkableWaitSignalCheckpoint,
} from './worker-message-helpers.ts';
import { WorkerProtocolGuard } from './worker-protocol-guard.ts';
import { isWorkerLogMessage } from './worker-protocol-log.ts';
import {
  DEFAULT_WORKER_REALM_READY_TIMEOUT_MS,
  WORKER_PROTOCOL_VERSION,
} from './worker-protocol.ts';
import { isWorkerRealmReadyMessage, WorkerRealmReadiness } from './worker-realm-readiness.ts';
import {
  WorkerTurnWatchdog,
  type WorkerTurnTimeoutResolverForTesting,
} from './worker-turn-watchdog.ts';

export class WorkerExecutionStrategy implements ExecutionStrategy {
  readonly #pool: WorkerPool;
  readonly #ownership: WorkerExecutionOwnership;
  readonly #workerListeners: WorkerListenerRegistry;
  readonly #broadcastChannel: BroadcastChannel | null;
  readonly #broadcastListener: ((event: MessageEvent) => void) | null;
  readonly #checkpointResumeState: WorkerCheckpointResumeState;
  readonly #workflowTurnTimeoutMs: number | undefined;
  readonly #maxProtocolMessageBytes: number | undefined;
  readonly #requireProtocolVersion: boolean;
  readonly #discardOnCancel: boolean;
  readonly #forwardedLogGate: ForwardedLogGate;
  readonly #turnWatchdog: WorkerTurnWatchdog;
  readonly #protocolGuard: WorkerProtocolGuard;
  readonly #realmReadiness: WorkerRealmReadiness | null;
  readonly #faultHandler: WorkerFaultHandler;
  readonly #dispatcher: WorkerExecutionDispatcher;
  #messageHandler: ((message: WorkerOutboundMessage) => void | Promise<void>) | null;
  #disposed: boolean;
  /**
   * Memoized `[Symbol.asyncDispose]` result (COR-113). `#teardown` itself
   * already runs at most once — guarded by `#disposed`, checked by both
   * dispose entry points before touching it — but an async caller also needs
   * every repeated or concurrent `asyncDispose()` call to observe the SAME
   * in-flight disposal rather than each awaiting its own call into
   * `#pool[Symbol.asyncDispose]()`. Assigned synchronously (this field's
   * setter never itself awaits), so two synchronous, unawaited calls in the
   * same tick still share one promise.
   */
  #asyncDisposePromise: Promise<void> | null;
  #nextTurnId: number;
  /**
   * Per-workflow captured revision (WFT-20), set once at `startWorkflow()`
   * and read by every subsequent turn's `beginTurn` — including `resume`
   * turns, whose inbound message never re-carries the revision. Cleared when
   * the workflow reaches a terminal outbound message or is cancelled.
   */
  readonly #workflowRevisions: Map<string, string>;

  constructor(pool: WorkerPool, options?: WorkerExecutionStrategyOptions) {
    const {
      workflowTurnTimeoutMs,
      maxProtocolMessageBytes,
      requireProtocolVersion = false,
      discardOnCancel = false,
      broadcastEvents = false,
      requireRealmReady = false,
      getExpectedWorkflowTypes,
      realmReadyTimeoutMs = DEFAULT_WORKER_REALM_READY_TIMEOUT_MS,
    } = options ?? {};
    this.#pool = pool;
    this.#ownership = new WorkerExecutionOwnership();
    this.#workflowRevisions = new Map();
    this.#workerListeners = new WorkerListenerRegistry();
    this.#checkpointResumeState = new WorkerCheckpointResumeState();
    this.#workflowTurnTimeoutMs = workflowTurnTimeoutMs;
    this.#maxProtocolMessageBytes = maxProtocolMessageBytes;
    this.#requireProtocolVersion = requireProtocolVersion;
    this.#discardOnCancel = discardOnCancel;
    this.#forwardedLogGate = forwardedLogGateFromStrategyOptions(options, maxProtocolMessageBytes);
    this.#turnWatchdog = new WorkerTurnWatchdog(this.#workflowTurnTimeoutMs, (turn) => {
      this.#faultHandler.handleTurnTimeout(turn);
    });
    this.#protocolGuard = new WorkerProtocolGuard(
      this.#maxProtocolMessageBytes,
      this.#requireProtocolVersion,
      this.#turnWatchdog,
    );
    this.#realmReadiness = WorkerExecutionStrategy.#buildRealmReadiness(
      requireRealmReady,
      getExpectedWorkflowTypes,
      realmReadyTimeoutMs,
      this.#maxProtocolMessageBytes,
    );
    this.#faultHandler = new WorkerFaultHandler({
      ownership: this.#ownership,
      checkpointResumeState: this.#checkpointResumeState,
      turnWatchdog: this.#turnWatchdog,
      forwardedLogGate: this.#forwardedLogGate,
      realmReadiness: this.#realmReadiness,
      workerListeners: this.#workerListeners,
      protocolGuard: this.#protocolGuard,
      pool: this.#pool,
      emit: (message) => {
        this.#emit(message);
      },
      forgetWorkflowRevision: (workflowId) => {
        this.#workflowRevisions.delete(workflowId);
      },
    });
    this.#dispatcher = new WorkerExecutionDispatcher({
      pool: this.#pool,
      ownership: this.#ownership,
      isDisposed: () => this.#disposed,
      requireProtocolVersion: () => this.#requireProtocolVersion,
      validateHostToWorkerMessage: (workflowId, message, worker) =>
        this.#faultHandler.assertHostToWorkerMessageWithinLimit(workflowId, message, worker),
      attachWorkerListeners: (worker) => {
        this.#attachWorkerListeners(worker);
      },
      detachWorkerListenersIfIdle: (worker) => {
        this.#detachWorkerListenersIfIdle(worker);
      },
      ensureRealmReady: (worker, workflowId) => this.#ensureRealmReady(worker, workflowId),
      beginTurn: (worker, workflowId, turnId, kind) => {
        this.#turnWatchdog.begin(
          worker,
          workflowId,
          turnId,
          kind,
          undefined,
          this.#workflowRevisions.get(workflowId),
        );
      },
      clearTurn: (worker) => {
        this.#turnWatchdog.clear(worker);
      },
      discardWorkerAndFailWorkflows: (worker, discardOptions) => {
        this.#faultHandler.discardWorkerAndFailWorkflows(worker, discardOptions);
      },
      emit: (message) => {
        this.#emit(message);
      },
    });
    this.#messageHandler = null;
    this.#broadcastChannel = null;
    this.#broadcastListener = null;
    this.#disposed = false;
    this.#asyncDisposePromise = null;
    this.#nextTurnId = 1;

    if (broadcastEvents) {
      try {
        this.#broadcastChannel = new BroadcastChannel('weft:events');
        this.#broadcastListener = (event: MessageEvent) => {
          this.#handleBroadcastMessage(event.data as Record<string, unknown>);
        };
        this.#broadcastChannel.addEventListener('message', this.#broadcastListener);
      } catch {}
    }
  }

  onMessage(handler: (message: WorkerOutboundMessage) => void | Promise<void>): void {
    this.#messageHandler = handler;
  }

  setWorkflowTurnTimeoutResolverForTesting(resolver: WorkerTurnTimeoutResolverForTesting): void {
    this.#turnWatchdog.setTimeoutResolverForTesting(resolver);
  }

  startWorkflow(parameters: {
    workflowId: string;
    workflowExecutionToken?: string;
    revision?: string;
    workflowType: string;
    input: unknown;
    checkpoint: ArrayBuffer;
    nestingDepth?: number;
    executionStateOwnerId?: string;
    startedAt?: number;
    sleepReferenceTime?: number;
    deadline?: number;
    headers?: [string, string][];
  }): void {
    this.#ownership.resetWorkflow(parameters.workflowId);
    this.#checkpointResumeState.resetWorkflow(parameters.workflowId);
    if (parameters.revision !== undefined) {
      this.#workflowRevisions.set(parameters.workflowId, parameters.revision);
    } else {
      this.#workflowRevisions.delete(parameters.workflowId);
    }
    const message = buildRunMessage(parameters, this.#inboundMessageContext());
    if (!this.#faultHandler.assertHostToWorkerMessageWithinLimit(parameters.workflowId, message)) {
      return;
    }
    void this.#dispatcher.acquireAndSend(parameters.workflowId, message);
  }

  resumeWorkflow(parameters: {
    workflowId: string;
    checkpoint: ArrayBuffer;
    operationResult: OperationOutcome;
  }): void {
    const worker = this.#ownership.getActiveWorker(parameters.workflowId);
    if (worker) {
      this.#checkpointResumeState.recordResume(parameters.workflowId);
      const resumeMessage = buildResumeMessage(parameters, this.#inboundMessageContext());
      this.#dispatcher.postResumeMessage(worker, parameters, resumeMessage);
      return;
    }

    const parkedWorker = this.#ownership.getParkedWorker(parameters.workflowId);
    if (parkedWorker) {
      const resumeMessage = buildResumeMessage(parameters, this.#inboundMessageContext());
      void this.#dispatcher.resumeParkedWorkflow(parameters, parkedWorker, resumeMessage);
      return;
    }

    if (this.#ownership.consumeCancelled(parameters.workflowId)) {
      return;
    }

    if (!this.#disposed) {
      this.#emit({
        type: 'failed',
        workflowId: parameters.workflowId,
        error: `No worker assigned for workflow: ${parameters.workflowId}`,
      });
    }
  }

  async #ensureRealmReady(worker: Worker, workflowId: string): Promise<boolean> {
    if (!this.#realmReadiness) return true;
    if (this.#realmReadiness.isReady(worker)) return true;

    const outcome = await this.#realmReadiness.waitForReady(worker);
    if (outcome.ok) return true;

    this.#faultHandler.discardWorkerAndFailWorkflows(worker, {
      targetWorkflowId: workflowId,
      targetCategory: outcome.failureCategory,
      targetError: outcome.error,
      otherCategory: 'system',
      otherError: `Worker discarded after realm-ready handshake failed: ${outcome.error}`,
    });
    return false;
  }

  #inboundMessageContext(): WorkerInboundMessageContext {
    return {
      turnId: this.#nextTurnId++,
      maxProtocolMessageBytes: this.#maxProtocolMessageBytes,
      hasLogSink: this.#forwardedLogGate.hasSink,
    };
  }

  cancelWorkflow(workflowId: string): void {
    // Cancellation is terminal for this strategy's own bookkeeping even
    // though a stray outbound message can still arrive after — the turn
    // watchdog is cleared below (via `#releaseActiveWorker`/discard), so any
    // late message fails the guard's turn-match check regardless.
    this.#workflowRevisions.delete(workflowId);
    const worker = this.#ownership.getActiveWorker(workflowId);
    if (worker) {
      this.#ownership.markCancelled(workflowId);
      if (this.#discardOnCancel) {
        this.#faultHandler.discardWorkerAndFailWorkflows(worker, {
          targetWorkflowId: workflowId,
          skipTarget: true,
          otherCategory: 'system',
          otherError: `Worker discarded during cancellation of workflow: ${workflowId}`,
        });
        return;
      }
      const message: WorkerInboundMessage = {
        type: 'cancel',
        workflowId,
      };
      if (this.#requireProtocolVersion) {
        message.protocolVersion = WORKER_PROTOCOL_VERSION;
      }

      worker.postMessage(message);
      this.#releaseActiveWorker(workflowId);
      return;
    }

    const parkedWorker = this.#ownership.getParkedWorker(workflowId);
    if (!parkedWorker) return;

    this.#ownership.markCancelled(workflowId);
    this.#ownership.deleteParked(workflowId);
    if (this.#discardOnCancel) {
      this.#faultHandler.discardWorkerAndFailWorkflows(parkedWorker, {
        targetWorkflowId: workflowId,
        skipTarget: true,
        otherCategory: 'system',
        otherError: `Worker discarded during cancellation of parked workflow: ${workflowId}`,
      });
      return;
    }
    void this.#dispatcher.cancelParkedWorkflow(workflowId, parkedWorker);
  }

  /**
   * Synchronous disposal (COR-113: idempotent termination). A no-op once
   * this strategy is already disposed — by an earlier synchronous dispose,
   * or by an `asyncDispose()` whose `#teardown()` phase has already run
   * synchronously (see that method's doc) — so the pool is never disposed
   * twice regardless of which entry point ran first.
   */
  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#teardown();
    this.#pool[Symbol.dispose]();
  }

  /**
   * Asynchronous disposal (COR-113: idempotent termination). Repeated or
   * concurrent calls share one memoized promise rather than each re-running
   * `#teardown()` or re-disposing the pool: `#asyncDisposePromise` is
   * assigned the FIRST time this is called and returned unchanged on every
   * subsequent call, including one made before the first has settled.
   */
  [Symbol.asyncDispose](): Promise<void> {
    this.#asyncDisposePromise ??= this.#performAsyncDispose();
    return this.#asyncDisposePromise;
  }

  async #performAsyncDispose(): Promise<void> {
    // Guards against a synchronous `[Symbol.dispose]()` that already ran
    // `#teardown()` and disposed the pool before this async path was ever
    // invoked (only reachable if `#asyncDisposePromise` was never set,
    // i.e. this is genuinely the first `asyncDispose()` call).
    if (this.#disposed) return;
    this.#teardown();
    await this.#pool[Symbol.asyncDispose]();
  }

  #teardown(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    if (this.#broadcastChannel) {
      if (this.#broadcastListener) {
        this.#broadcastChannel.removeEventListener('message', this.#broadcastListener);
      }
      this.#broadcastChannel.close();
    }

    this.#turnWatchdog.clearAll();
    this.#realmReadiness?.clear();

    const activeWorkflowIds = this.#ownership.activeWorkflowIds();
    for (const workflowId of activeWorkflowIds) {
      this.#releaseActiveWorker(workflowId);
    }

    this.#workerListeners.detachAll();
    this.#ownership.clear();
    this.#checkpointResumeState.clear();
    this.#workflowRevisions.clear();
    this.#messageHandler = null;
  }

  async #handleWorkerMessage(worker: Worker, message: unknown): Promise<void> {
    // Every worker realm sends `ready` at boot regardless of whether this
    // strategy requires the handshake (WFT-28), so it must be intercepted here
    // unconditionally — `ready` has no `workflowId` and would otherwise reach
    // `WorkerFaultHandler.acceptWorkerMessage`'s strict gate, which requires
    // one, and get the worker discarded before it ever executes a turn.
    if (isWorkerRealmReadyMessage(message)) {
      if (this.#realmReadiness) {
        await this.#realmReadiness.noteReadyMessage(worker, message);
      }
      return;
    }

    // Logs bypass the strict gate; ForwardedLogGate handles sustained abuse.
    if (isWorkerLogMessage(message)) {
      const owns = (id: string): boolean => this.#ownership.getTargetWorker(id) === worker;
      const abuseDiscard = this.#forwardedLogGate.handle(worker, message, owns);
      if (abuseDiscard) this.#faultHandler.discardWorkerAndFailWorkflows(worker, abuseDiscard);
      return;
    }

    if (!this.#faultHandler.acceptWorkerMessage(worker, message)) {
      return;
    }

    this.#turnWatchdog.clear(worker);
    const resumeVersionBeforeCheckpointHandling =
      this.#checkpointResumeState.beginCheckpointHandling(message);

    const emitResult = emitWorkerMessageToEngine(this.#messageHandler, message);
    const handlerFailed = emitResult instanceof Promise ? await emitResult : emitResult;

    try {
      // COR-113: a realm's `completed`/`failed` result is only ACCEPTED once
      // the handler's durable commit has actually succeeded — the host must
      // never acknowledge a workflow turn solely because a realm sent a
      // result. Checked BEFORE `#settleTerminalWorkerMessage`, which would
      // otherwise unconditionally release the worker back to the pool and
      // clear ownership regardless of `handlerFailed`, silently treating an
      // uncommitted result as though it had landed durably. Routed through
      // the same discard-and-refail path every other worker anomaly in this
      // file uses, so the workflow is settled as failed/retryable per
      // existing engine semantics rather than orphaned.
      if (handlerFailed && (message.type === 'completed' || message.type === 'failed')) {
        this.#faultHandler.discardWorkerAndFailWorkflows(worker, {
          targetWorkflowId: message.workflowId,
          targetCategory: 'system',
          targetError: `Turn result for workflow ${message.workflowId} could not be durably committed`,
          otherCategory: 'system',
          otherError: `Worker discarded after a workflow turn result failed to commit durably: ${message.workflowId}`,
        });
        return;
      }

      if (this.#settleTerminalWorkerMessage(worker, message)) {
        return;
      }

      if (handlerFailed) {
        return;
      }

      this.#parkCheckpointIfStillWaiting(worker, message, resumeVersionBeforeCheckpointHandling);
    } finally {
      this.#checkpointResumeState.finishCheckpointHandling(
        message.workflowId,
        resumeVersionBeforeCheckpointHandling,
        this.#ownership.isWorkflowClosed(message.workflowId),
      );
    }
  }

  #settleTerminalWorkerMessage(worker: Worker, message: WorkerOutboundMessage): boolean {
    if (message.type !== 'completed' && message.type !== 'failed') {
      return false;
    }

    this.#ownership.consumeCancelled(message.workflowId);
    this.#ownership.deleteParked(message.workflowId);
    this.#workflowRevisions.delete(message.workflowId);
    this.#releaseActiveWorker(message.workflowId);
    this.#detachWorkerListenersIfIdle(worker);
    this.#checkpointResumeState.forgetWorkflowIfClosed(
      message.workflowId,
      this.#ownership.isWorkflowClosed(message.workflowId),
    );
    return true;
  }

  #parkCheckpointIfStillWaiting(
    worker: Worker,
    message: WorkerOutboundMessage,
    resumeVersionBeforeCheckpointHandling: number | null,
  ): void {
    if (message.type !== 'checkpoint' || !isParkableWaitSignalCheckpoint(message)) {
      return;
    }
    if (
      this.#checkpointResumeState.wasResumedDuringCheckpointHandling(
        message.workflowId,
        resumeVersionBeforeCheckpointHandling,
      )
    ) {
      return;
    }
    if (this.#ownership.parkActive(message.workflowId, worker)) {
      this.#pool.release(worker);
    }
  }

  #releaseActiveWorker(workflowId: string): void {
    const worker = this.#ownership.releaseActive(workflowId);
    if (worker) {
      this.#turnWatchdog.clear(worker);
      this.#detachWorkerListenersIfIdle(worker);

      this.#pool.release(worker);
    }
  }

  #attachWorkerListeners(worker: Worker): void {
    this.#workerListeners.attach(worker, {
      message: (message) => {
        void this.#handleWorkerMessage(worker, message).catch(() => {});
      },
      error: (errorEvent) => {
        this.#faultHandler.handleWorkerError(worker, errorEvent);
      },
      messageerror: () => {
        this.#faultHandler.discardWorkerAndFailWorkflows(worker, {
          targetCategory: 'system',
          targetError: 'Worker messageerror event',
          otherCategory: 'system',
          otherError: 'Worker messageerror event',
        });
      },
    });
  }

  #detachWorkerListenersIfIdle(worker: Worker): void {
    this.#workerListeners.detachIfIdle(worker, (candidate) =>
      this.#ownership.workerIsIdle(candidate),
    );
  }

  #handleBroadcastMessage(data: Record<string, unknown>): void {
    if (data['type'] === 'signal:received' && typeof data['workflowId'] === 'string') {
      const targetWorker = this.#ownership.getTargetWorker(data['workflowId']);
      if (targetWorker) targetWorker.postMessage(data);
    }
  }

  #emit(message: WorkerOutboundMessage): void {
    const result = this.#messageHandler?.(message);
    if (result instanceof Promise) {
      // Observe the unawaited handler turn so rejections never become process noise.
      void result.catch(() => {});
    }
  }

  static #buildRealmReadiness(
    requireRealmReady: boolean,
    getExpectedWorkflowTypes: (() => readonly string[]) | undefined,
    timeoutMs: number,
    maxProtocolMessageBytes: number | undefined,
  ): WorkerRealmReadiness | null {
    if (!requireRealmReady) return null;
    if (!getExpectedWorkflowTypes) {
      throw new Error(
        'WorkerExecutionStrategyOptions.getExpectedWorkflowTypes is required when requireRealmReady is true',
      );
    }
    return new WorkerRealmReadiness({
      getExpectedWorkflowTypes,
      timeoutMs,
      maxProtocolMessageBytes,
    });
  }
}
