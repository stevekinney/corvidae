/**
 * COR-851 — assembles `bureau.goals` from the pieces `createBureau` already has.
 *
 * Kept out of `createBureau` so that function gains one call rather than the
 * goal control plane's wiring: the store over Bureau's key-value store, the
 * validator catalog, the attempt forwarder, the workflow ports (bound into the
 * workflow the engine registered before any of this existed), and the control
 * plane over all of them.
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import {
  type CleanupAcknowledgement,
  createSessionStore,
  type DurableActiveRunContext,
  type FreshAttemptSourceResolver,
  type RunOptions,
  type SessionStore,
} from '@lostgradient/operative';
import { type ConditionalTextValueStore, MemoryStorage, textValueStore } from '@lostgradient/weft';

import type { GoalAttemptRun, GoalAttemptStart } from './bureau-catalog-dispatch';
import type { DurableEventHistory } from './durable-event-history';
import { createGoalConversations } from './goal-conversation';
import { createGoalEventRecorder, projectGoalHistory } from './goal-event-projection';
import { createAttemptForwarder } from './goal-forwarder';
import {
  createOwnedGoalEngine,
  createOwnedRunCanceller,
  GoalCorruptOwnershipRecordError,
  GoalOwnershipUnknownError,
  type RunRecordReader,
} from './goal-ownership';
import { createGoalPorts, type GoalWorkflowHost } from './goal-ports';
import { goalWorkflowId } from './goal-state';
import { createGoalStore } from './goal-store';
import type { BureauGoalRecoveryReport, BureauGoals, GoalEngine } from './goal-types';
import type { GoalValidatorCatalog } from './goal-validator-catalog';
import { createBureauGoals } from './goals';
import type { CancelDurableRunOutcome, DiagnosticSink } from './types';

export interface GoalsCompositionDependencies {
  /** Built by the caller before the durable engine, so a bad registration fails startup first. */
  readonly catalog: GoalValidatorCatalog;
  readonly kv: ConditionalTextValueStore | undefined;
  /** Where goal conversations live; absent when the bureau has no persistent store, as with `kv`. */
  readonly sessionStore: SessionStore | undefined;
  /** See `BureauOptions.resolveFreshAttemptSource`. */
  readonly resolveFreshAttemptSource: FreshAttemptSourceResolver | undefined;
  readonly runtimeServices: RuntimeServices;
  readonly host: GoalWorkflowHost;
  readonly getDurable: () => (DurableActiveRunContext & { engine: GoalEngine }) | undefined;
  readonly planAgent: (
    agentName: string,
  ) => { readonly durable: boolean; readonly agentVersion: string } | undefined;
  readonly startAttemptRun: (start: GoalAttemptStart) => GoalAttemptRun;
  readonly cancelRun: (runId: string) => Promise<CancelDurableRunOutcome>;
  /** Reads the recovery record that marks which goal attempt a run was started for. */
  readonly readRunRecord: RunRecordReader;
  /** Applies checkpoint retention to a terminal controller workflow; see `BureauGoalsDependencies`. */
  readonly cleanupController: (workflowId: string) => Promise<CleanupAcknowledgement>;
  readonly isClosing: () => boolean;
  readonly diagnose: DiagnosticSink;
  /** Where a goal's audit events are recorded; absent when the bureau has no persistent history. */
  readonly eventHistory?: Pick<DurableEventHistory, 'record'> | undefined;
}

export interface GoalsComposition {
  readonly goals: BureauGoals;
  /** Whether `workflowId` is the controller of a goal this bureau stores. */
  ownsWorkflow(workflowId: string): Promise<boolean>;
  /** The boot sweep. Never rejects. */
  recoverAtBoot(): Promise<BureauGoalRecoveryReport>;
  /** Resolves once every forwarded signal already being sent has been delivered. */
  drain(): Promise<void>;
}

export function composeBureauGoals(dependencies: GoalsCompositionDependencies): GoalsComposition {
  const { runtimeServices, host, diagnose, readRunRecord } = dependencies;
  // Everything but the start-attempt port, which must tell an absent id from a
  // foreign one, sees the engine through the goal's ownership checks: a
  // workflow or run the goal does not own does not exist to it.
  const getDurable = (): ReturnType<typeof dependencies.getDurable> => {
    const durable = dependencies.getDurable();
    return durable === undefined
      ? undefined
      : { ...durable, engine: createOwnedGoalEngine(durable.engine, readRunRecord) };
  };
  const cancelRun = createOwnedRunCanceller(dependencies.cancelRun, readRunRecord);
  const recordEvents =
    dependencies.eventHistory === undefined
      ? undefined
      : createGoalEventRecorder(dependencies.eventHistory, diagnose);
  const store = createGoalStore(dependencies.kv ?? textValueStore(new MemoryStorage()), {
    ...(recordEvents === undefined ? {} : { observe: recordEvents }),
    onObserverError: (error) =>
      diagnose({
        level: 'error',
        scope: 'goals',
        message: '[bureau] A goal event projection failed.',
        cause: error,
      }),
    onCorrupt: (key) =>
      diagnose({
        level: 'error',
        scope: 'goals',
        message: `[bureau] Ignoring an unreadable goal record at "${key}".`,
      }),
  });
  const { catalog } = dependencies;

  /**
   * The cost estimation an attempt's run was started with, for a goal with a
   * cost bound. It is read from the selection persisted with the run's recovery
   * record (see `goal-cost-estimation.ts`) and never resolved from the catalog,
   * which may by now hold another revision of the agent or none: pricing a run
   * that already ran with a different definition would record a cost it never
   * had. `undefined` means the run declared no estimator (or no run was started
   * under this id). A record that cannot be read, is not a valid record, or
   * carries no selection rejects, so the caller retries or reports it.
   */
  async function resolveCostEstimation(runId: string): Promise<RunOptions['costEstimation']> {
    const load = await readRunRecord(runId);
    // No record means no run was started under this id, so there is nothing to price.
    if (load.status === 'missing') return undefined;
    if (load.status === 'read-error') throw new GoalOwnershipUnknownError(runId, load.error);
    if (load.status === 'corrupt') throw new GoalCorruptOwnershipRecordError(runId);
    // The decoder requires the selection on every goal attempt's record, so a
    // record without one is not a goal attempt's: it has no estimator to read.
    if (load.record.goalAttempt === undefined || load.record.costEstimation === undefined) {
      throw new GoalCorruptOwnershipRecordError(runId);
    }
    return load.record.costEstimation ?? undefined;
  }

  const conversations = createGoalConversations({
    sessionStore:
      dependencies.sessionStore ??
      createSessionStore(textValueStore(new MemoryStorage()), { runtime: runtimeServices }),
    runtime: runtimeServices,
    getDurable,
    resolveFreshAttemptSource: dependencies.resolveFreshAttemptSource,
  });
  const forwarder = createAttemptForwarder({
    store,
    runtime: runtimeServices,
    getDurable,
    resolveCostEstimation,
    conversations,
    isClosing: dependencies.isClosing,
    diagnose,
  });
  const ports = createGoalPorts({
    store,
    catalog,
    runtime: runtimeServices,
    forwarder,
    conversations,
    // The raw engine: adopting a run needs to know whether the id is held at
    // all, which the owned view hides when the holder is foreign.
    getDurable: dependencies.getDurable,
    readRunRecord,
    planAgent: dependencies.planAgent,
    startAttemptRun: dependencies.startAttemptRun,
    cancelRun,
    resolveCostEstimation,
  });
  host.bind(ports);

  const goals = createBureauGoals({
    store,
    catalog,
    runtime: runtimeServices,
    clock: runtimeServices.clock,
    diagnose,
    getEngine: () => getDurable()?.engine,
    cancelRun,
    cleanupController: dependencies.cleanupController,
    forwarder,
    resolveFreshAttemptSource: dependencies.resolveFreshAttemptSource,
    startAttempt: (request) => ports.startAttempt(request),
    isClosing: dependencies.isClosing,
    planAgent: dependencies.planAgent,
  });

  return {
    goals,
    async ownsWorkflow(workflowId) {
      if (!workflowId.startsWith('goal:')) return false;
      const record = await store.get(workflowId.slice('goal:'.length));
      return record !== undefined && goalWorkflowId(record.goalRunId) === workflowId;
    },
    async recoverAtBoot() {
      // Replay every record's audit log into the event history. Each commit
      // stored its audit events in the record, so a projection that failed at
      // any point, at any depth in the log, is repaired here; the dedupe keys
      // make a replay of what is already recorded a no-op.
      if (recordEvents !== undefined) {
        await projectGoalHistory(await store.list(), recordEvents).catch((error: unknown) =>
          diagnose({
            level: 'error',
            scope: 'goals',
            message: '[bureau] Could not re-project goal events at boot.',
            cause: error,
          }),
        );
      }
      return goals.recover();
    },
    drain: () => forwarder.drain(),
  };
}
