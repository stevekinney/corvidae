/**
 * `ExecutionStrategy` implementation that routes every workflow turn to a
 * revision-scoped {@link WorkerRealm} instead of a shared Worker pool
 * (COR-249's engine integration, ADR 0004's line 49 deferral).
 *
 * Reuses the exact same `WorkerInboundMessage`/`WorkerOutboundMessage`
 * envelope-building helpers ({@link buildRunMessage}, {@link
 * buildResumeMessage}) `WorkerExecutionStrategy` uses for the generic Worker
 * path — a revision realm's `realm-run` message carries one of these as its
 * opaque `input`, and the realm's own bootstrap steps it with the identical
 * `handleRunMessage`/`handleResumeMessage` helpers (`src/workers/workflow-runner.ts`)
 * the generic Worker bootstrap already uses. Nothing about generator
 * stepping, checkpoint replay, or operation-result application is
 * reimplemented here — only routing.
 *
 * **One execution, one realm.** Unlike `WorkerExecutionStrategy`'s pool of
 * interchangeable, reusable Workers, `RevisionRealmPool` hands out a realm
 * that serves exactly one execution end to end (see that module's doc) —
 * this strategy tracks `workflowId -> { realm, revision, executionToken }`
 * for the execution's lifetime and releases the realm back to its pool
 * (which drains and terminates it) the moment the workflow reaches a
 * terminal outbound message, is cancelled, this strategy is disposed, or
 * the realm itself rejects a turn (a genuine mid-turn Worker crash, or a
 * protocol-level failure from a realm that never crashed) — see
 * `#dispatch`'s catch block for why that release always goes through
 * `releaseAfterExecution` rather than `forgetCrashedRealm`.
 *
 * **Revision resolution.** A fresh start's revision comes from
 * `parameters.revision`, already resolved by the engine's own dynamic-source
 * machinery (WFT-15/16) before `startWorkflow()` is ever called — the same
 * value that routes new starts to the currently-active revision via the real
 * `catalog:revision-activated` event (see `revision-realm-catalog-listener.ts`).
 * Recovery re-launches (an engine restart resuming a run after storage
 * reload) call `startWorkflow()` again with the checkpoint bytes but omit
 * `parameters.revision` — for that path this strategy falls back to
 * `getWorkflowRevisionPin`, a synchronous accessor over the engine's own
 * per-instance `workflowTypeByWorkflowId` identity cache (WFT-19), which is
 * populated with the resolved revision before every launch path reaches the
 * strategy. This is the "durable revision pin" a recovered run keeps
 * executing against, in its own revision's realm, even after a newer
 * revision has since become active.
 *
 * **Cancellation is non-cooperative.** A revision realm has no in-place
 * "abort but keep replying" turn (ADR 0004's own COR-113 deferral: "this
 * slice's `WorkerRealm`/`RevisionRealmPool` reject rather than cooperatively
 * complete a pending turn on drain/terminate"). `cancelWorkflow` releases the
 * realm immediately (drain + terminate), which rejects any turn still
 * in-flight; this strategy recognizes that specific rejection (the workflow
 * id was just cancelled) and emits nothing further for it, matching hardened
 * Worker mode's own `discardOnCancel: true` posture.
 *
 * @module core/realm/revision-realm-execution-strategy
 */

import type { ExecutionStrategy } from '../execution-strategy.ts';
import type { OperationOutcome, WorkerOutboundMessage } from '../types.ts';
import { WorkerExecutionDisposal } from '../worker-execution-disposal.ts';
import {
  buildResumeMessage,
  buildRunMessage,
  type WorkerInboundMessageContext,
} from '../worker-inbound-message.ts';
import type { RealmTurnEnvelope } from './realm-protocol.ts';
import type { RevisionRealmConfig, RevisionRealmRegistry } from './revision-realm-registry.ts';
import type { WorkerRealm } from './worker-realm.ts';

/** Normalize `ArrayBuffer | Uint8Array` (the {@link ExecutionStrategy.startWorkflow} contract) to a plain `ArrayBuffer`. */
function toArrayBuffer(checkpoint: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (checkpoint instanceof ArrayBuffer) return checkpoint;
  const copy = new Uint8Array(checkpoint.byteLength);
  copy.set(checkpoint);
  return copy.buffer;
}

interface ActiveRealmExecution {
  readonly name: string;
  readonly revision: string;
  readonly realm: WorkerRealm;
  readonly executionToken: string;
  nextTurnId: number;
}

export interface RevisionRealmExecutionStrategyOptions {
  readonly registry: RevisionRealmRegistry;
  /** See {@link import('../types/options.ts').EngineOptions.revisionRealmExecution}. */
  readonly resolveRevisionRealmConfig: (
    workflowType: string,
    revision: string,
  ) => RevisionRealmConfig | undefined;
  /**
   * Synchronous accessor over the engine's own per-instance
   * `workflowTypeByWorkflowId` cache (WFT-19) — the durable revision pin a
   * recovery re-launch needs, since `startWorkflow()`'s own `revision`
   * parameter is only populated on a fresh start. See this module's doc.
   */
  readonly getWorkflowRevisionPin: (workflowId: string) => string | undefined;
  readonly maxProtocolMessageBytes?: number;
}

function outboundFailure(
  workflowId: string,
  error: string,
): WorkerOutboundMessage & { type: 'failed' } {
  return { type: 'failed', workflowId, error, failureCategory: 'system' };
}

export class RevisionRealmExecutionStrategy implements ExecutionStrategy {
  readonly #registry: RevisionRealmRegistry;
  readonly #resolveConfig: (
    workflowType: string,
    revision: string,
  ) => RevisionRealmConfig | undefined;
  readonly #getWorkflowRevisionPin: (workflowId: string) => string | undefined;
  readonly #maxProtocolMessageBytes: number | undefined;
  readonly #executions = new Map<string, ActiveRealmExecution>();
  /** Workflow ids `cancelWorkflow()` just released the realm for — a pending turn's resulting rejection is expected and swallowed rather than reported as a failure. */
  readonly #cancelled = new Set<string>();
  readonly #disposal: WorkerExecutionDisposal;
  #messageHandler: ((message: WorkerOutboundMessage) => void | Promise<void>) | null = null;

  constructor(options: RevisionRealmExecutionStrategyOptions) {
    this.#registry = options.registry;
    this.#resolveConfig = options.resolveRevisionRealmConfig;
    this.#getWorkflowRevisionPin = options.getWorkflowRevisionPin;
    this.#maxProtocolMessageBytes = options.maxProtocolMessageBytes;
    this.#disposal = new WorkerExecutionDisposal({
      teardown: () => {
        this.#executions.clear();
        this.#cancelled.clear();
        this.#messageHandler = null;
      },
      disposeSync: () => {
        this.#registry.dispose();
      },
      disposeAsync: () => {
        this.#registry.dispose();
        return Promise.resolve();
      },
    });
  }

  onMessage(handler: (message: WorkerOutboundMessage) => void | Promise<void>): void {
    this.#messageHandler = handler;
  }

  startWorkflow(parameters: {
    workflowId: string;
    workflowExecutionToken?: string;
    revision?: string;
    workflowType: string;
    input: unknown;
    checkpoint: ArrayBuffer | Uint8Array;
    nestingDepth?: number;
    executionStateOwnerId?: string;
    startedAt?: number;
    sleepReferenceTime?: number;
    deadline?: number;
    headers?: [string, string][];
  }): void {
    const revision = parameters.revision ?? this.#getWorkflowRevisionPin(parameters.workflowId);
    if (revision === undefined) {
      this.#emit(
        outboundFailure(
          parameters.workflowId,
          `Revision realm execution requires a resolved workflow revision for type "${parameters.workflowType}", but none was available for workflow "${parameters.workflowId}".`,
        ),
      );
      return;
    }
    void this.#startOnRealm(parameters, revision);
  }

  resumeWorkflow(parameters: {
    workflowId: string;
    checkpoint: ArrayBuffer | Uint8Array;
    operationResult: OperationOutcome;
  }): void {
    const execution = this.#executions.get(parameters.workflowId);
    if (!execution) {
      if (this.#cancelled.delete(parameters.workflowId)) return;
      if (!this.#disposal.isDisposed) {
        this.#emit(
          outboundFailure(
            parameters.workflowId,
            `No revision realm assigned for workflow: ${parameters.workflowId}`,
          ),
        );
      }
      return;
    }
    const input = buildResumeMessage(
      {
        workflowId: parameters.workflowId,
        checkpoint: toArrayBuffer(parameters.checkpoint),
        operationResult: parameters.operationResult,
      },
      this.#turnContext(),
    );
    void this.#dispatch(parameters.workflowId, execution, input);
  }

  cancelWorkflow(workflowId: string): void {
    const execution = this.#executions.get(workflowId);
    if (!execution) return;
    this.#executions.delete(workflowId);
    this.#cancelled.add(workflowId);
    this.#registry.releaseAfterExecution(execution.name, execution.revision, execution.realm);
  }

  [Symbol.dispose](): void {
    this.#disposal.disposeSync();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.#disposal.disposeAsync();
  }

  async #startOnRealm(
    parameters: {
      workflowId: string;
      workflowExecutionToken?: string;
      workflowType: string;
      input: unknown;
      checkpoint: ArrayBuffer | Uint8Array;
      executionStateOwnerId?: string;
      deadline?: number;
      headers?: [string, string][];
    },
    revision: string,
  ): Promise<void> {
    const name = parameters.workflowType;
    const config = this.#resolveConfig(name, revision);
    if (!config) {
      this.#emit(
        outboundFailure(
          parameters.workflowId,
          `No revision realm configuration for workflow type "${name}" revision "${revision}" (options.revisionRealmExecution.resolveRevisionRealmConfig returned undefined).`,
        ),
      );
      return;
    }
    this.#registry.ensurePool(name, revision, config);
    const executionToken = parameters.workflowExecutionToken ?? crypto.randomUUID();
    const outcome = await this.#registry.acquireForExecution(name, revision, executionToken);
    if (!outcome.ok) {
      this.#emit(
        outboundFailure(
          parameters.workflowId,
          `Could not acquire a revision realm for "${name}" revision "${revision}": ${outcome.reason}` +
            (outcome.error ? ` (${outcome.error})` : ''),
        ),
      );
      return;
    }
    if (this.#disposal.isDisposed) {
      this.#registry.releaseAfterExecution(name, revision, outcome.realm);
      return;
    }
    const execution: ActiveRealmExecution = {
      name,
      revision,
      realm: outcome.realm,
      executionToken,
      nextTurnId: 1,
    };
    this.#executions.set(parameters.workflowId, execution);
    const input = buildRunMessage(
      {
        workflowId: parameters.workflowId,
        ...(parameters.workflowExecutionToken !== undefined && {
          workflowExecutionToken: parameters.workflowExecutionToken,
        }),
        revision,
        workflowType: name,
        input: parameters.input,
        checkpoint: toArrayBuffer(parameters.checkpoint),
        ...(parameters.executionStateOwnerId !== undefined && {
          executionStateOwnerId: parameters.executionStateOwnerId,
        }),
        ...(parameters.deadline !== undefined && { deadline: parameters.deadline }),
        ...(parameters.headers !== undefined && { headers: parameters.headers }),
      },
      this.#turnContext(),
    );
    await this.#dispatch(parameters.workflowId, execution, input);
  }

  async #dispatch(
    workflowId: string,
    execution: ActiveRealmExecution,
    input: unknown,
  ): Promise<void> {
    const activation = execution.realm.activation;
    if (!activation) {
      this.#executions.delete(workflowId);
      // `WorkerRealm#activation` is only ever set (never cleared) by
      // `activate()`, which every `acquireForExecution` outcome this
      // strategy uses already called before returning `ok: true` — this
      // branch's realm is therefore always still `Ready` in practice (type
      // narrowing for a state `acquireForExecution` guarantees cannot
      // reach here yet). `releaseAfterExecution` is still the correct call
      // rather than `forgetCrashedRealm`: an un-activated `Ready` realm has
      // not had its own crash handling terminate its Worker the way
      // `forgetCrashedRealm`'s contract assumes, so releasing it drains (if
      // applicable) and reclaims the pool slot instead of leaking a live
      // Worker.
      this.#registry.releaseAfterExecution(execution.name, execution.revision, execution.realm);
      this.#emit(
        outboundFailure(workflowId, `Revision realm for workflow "${workflowId}" is not active.`),
      );
      return;
    }
    const envelope: RealmTurnEnvelope = {
      workflowRevision: activation.workflowRevision,
      realmGeneration: activation.realmGeneration,
      executionToken: activation.executionToken,
      turnId: execution.nextTurnId,
    };
    execution.nextTurnId += 1;
    try {
      const result = await execution.realm.dispatchTurn(envelope, input);
      const outbound = result as WorkerOutboundMessage;
      if (outbound.type === 'completed' || outbound.type === 'failed') {
        this.#executions.delete(workflowId);
        this.#registry.releaseAfterExecution(execution.name, execution.revision, execution.realm);
      }
      this.#emit(outbound);
    } catch (error) {
      // A cancel-triggered release rejects the pending turn on purpose (the
      // realm was drained/terminated out from under it) — that rejection is
      // expected and must not surface as a workflow failure the engine has
      // already recorded a cancellation for.
      if (this.#cancelled.delete(workflowId)) return;
      this.#executions.delete(workflowId);
      // The realm rejected the turn on its own instead of settling to a
      // `completed`/`failed` outbound message the success branch above
      // already releases for — reclaim its pool slot the same way
      // `WorkerFaultHandler.discardWorkerAndFailWorkflows` retires a
      // crashed Worker's slot in the generic Worker path, so a crashed
      // realm never sits in `RevisionRealmPool`'s `#realms` set forever
      // holding capacity a still-active revision can no longer use.
      // `releaseAfterExecution` (not `forgetCrashedRealm`) on purpose: a
      // genuine mid-turn Worker crash already moved the realm's own
      // lifecycle to a terminal state and already terminated its
      // underlying Worker (`#forceDown`), so `releaseAfterExecution`'s
      // `active`/`draining` checks are both false and it degrades to
      // exactly `forgetCrashedRealm`'s own effect — but a rejection from a
      // still-`active` realm (a protocol-level `realm-failure` message or
      // an envelope mismatch, the realm itself never crashed) instead
      // drains and terminates that still-live Worker rather than
      // abandoning it, which `forgetCrashedRealm`'s own contract ("its own
      // crash handling already did that") assumes already happened.
      this.#registry.releaseAfterExecution(execution.name, execution.revision, execution.realm);
      if (!this.#disposal.isDisposed) {
        this.#emit(
          outboundFailure(workflowId, error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  #turnContext(): WorkerInboundMessageContext {
    return {
      turnId: 0,
      maxProtocolMessageBytes: this.#maxProtocolMessageBytes,
      hasLogSink: false,
    };
  }

  #emit(message: WorkerOutboundMessage): void {
    const result = this.#messageHandler?.(message);
    if (result instanceof Promise) {
      void result.catch(() => {});
    }
  }
}
