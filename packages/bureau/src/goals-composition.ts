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
  type AgentRun,
  type DurableActiveRunContext,
  hasDefinitionResolver,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  type RunOptions,
} from '@lostgradient/operative';
import { type ConditionalTextValueStore, MemoryStorage, textValueStore } from '@lostgradient/weft';

import type { AgentDefinitions, BureauAgentCatalog } from './agent-catalog';
import type { GoalAttemptStart } from './bureau-catalog-dispatch';
import type { DurableEventHistory } from './durable-event-history';
import { createGoalEventRecorder, projectGoalHistory } from './goal-event-projection';
import { createAttemptForwarder } from './goal-forwarder';
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
  readonly runtimeServices: RuntimeServices;
  readonly host: GoalWorkflowHost;
  readonly agentCatalog: Pick<BureauAgentCatalog<AgentDefinitions>, 'find'>;
  readonly getDurable: () => (DurableActiveRunContext & { engine: GoalEngine }) | undefined;
  readonly planAgent: (
    agentName: string,
  ) => { readonly durable: boolean; readonly agentVersion: string } | undefined;
  readonly startAttemptRun: (start: GoalAttemptStart) => AgentRun<unknown, boolean>;
  readonly cancelRun: (runId: string) => Promise<CancelDurableRunOutcome>;
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
  const { runtimeServices, host, agentCatalog, getDurable, diagnose } = dependencies;
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

  /** The cost estimation the agent's own run options declare, for a goal with a cost bound. */
  async function resolveCostEstimation(
    agentName: string,
    prompt: string,
    principal: string | undefined,
  ): Promise<RunOptions['costEstimation'] | undefined> {
    const agent = agentCatalog.find(agentName);
    if (agent === undefined || !hasDefinitionResolver(agent)) return undefined;
    const options = await agent[OPERATIVE_RESOLVE_RUN_OPTIONS](prompt, {
      agentName,
      ...(principal === undefined ? {} : { principal }),
    });
    return options.costEstimation;
  }

  const forwarder = createAttemptForwarder({
    store,
    runtime: runtimeServices,
    getDurable,
    resolveCostEstimation,
    isClosing: dependencies.isClosing,
    diagnose,
  });
  const ports = createGoalPorts({
    store,
    catalog,
    runtime: runtimeServices,
    forwarder,
    getDurable,
    planAgent: dependencies.planAgent,
    startAttemptRun: dependencies.startAttemptRun,
    cancelRun: dependencies.cancelRun,
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
    cancelRun: dependencies.cancelRun,
    forwarder,
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
      // Close the window between a write and its projection before anything
      // else can change a record: a crash there left a transition unrecorded.
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
