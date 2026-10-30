/**
 * COR-1481 — the task registry's subscriber to the catalog-run settlement hook
 * (`catalog-run-settlement.ts`): when a catalog run ends, its task is settled.
 *
 * A run recovered after a restart can end with no task record: its admission write was lost in
 * the crash, or it ended before boot reconciliation looked for it. A recovered run was in flight
 * at this boot, so a record written for it cannot bring back a task that retention removed; it is
 * written from the run's catalog recovery record, dated from the durable run, and then settled.
 * A fresh dispatch whose own admission write failed has no such record to write from and is left
 * unrecorded, as the failure was diagnosed when it happened.
 *
 * What it filters: the hook also publishes a recovered child run, a recovered goal attempt, and a
 * recovered workflow step's run. Each is a task exactly when its claim stores a `taskOrigin`
 * (COR-1868): the record is written from that origin, so the run settles the task its start
 * admitted, or the one a crash lost. A run claimed before the field existed (a child, an attempt,
 * a step) is never given a record here and stays a non-task for its whole life; a record that
 * exists is settled whatever kind of run it is.
 *
 * @module catalog-task-settlement
 */
import type { CatalogRunSettlement } from './catalog-run-settlement';
import type { CatalogRunRecoveryLoad, CatalogRunRecoveryRecord } from './runtime-composition';
import type { StoredTaskOrigin } from './task-origin';
import { TASK_ARTIFACT_TEXT_LIMIT, type TaskAdmission, type TaskRegistry } from './task-registry';
import type { AgentInput } from '@lostgradient/operative';

/** What a subordinate task's record is written from: the run's claim, and its stored origin. */
export interface SubordinateClaim {
  readonly agentName: CatalogRunRecoveryRecord['agentName'];
  readonly principal?: string | undefined;
  readonly input: CatalogRunRecoveryRecord['input'];
  readonly contextId?: string | undefined;
  readonly taskOrigin: StoredTaskOrigin;
}

/**
 * The record of a child run, a goal attempt or a workflow step's task, in one place: the live
 * admission after the start, the backfill of a record a crash lost, and the boot's reconciliation
 * all write what this returns, so none can drift from another. The origin is the one the claim
 * stores, never a recomputed one; the run is its own context; the date is the durable run's.
 */
export function subordinateTaskAdmission(
  runId: string,
  claim: SubordinateClaim,
  options: {
    readonly ownerOf: (principal: string | undefined) => string;
    readonly originatingMessage: (input: AgentInput) => string | undefined;
    readonly createdAt: string | undefined;
  },
): TaskAdmission {
  return {
    taskId: runId,
    contextId: claim.contextId ?? runId,
    incarnation: '',
    agentName: claim.agentName,
    owner: options.ownerOf(claim.principal),
    origin: claim.taskOrigin,
    message: options.originatingMessage(claim.input),
    ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
  };
}

/** What the settler reads from the Bureau around it. */
export interface CatalogTaskSettlerDependencies {
  readonly tasks: Pick<TaskRegistry, 'recordSettled' | 'recordAdmission'>;
  readonly loadRecoveryRecord: (runId: string) => Promise<CatalogRunRecoveryLoad>;
  /** When the durable run was created (ISO 8601), or `undefined` when the engine has no record of it. */
  readonly durableCreatedAt: (runId: string) => Promise<string | undefined>;
  /**
   * Whether a run whose claim stores no `taskOrigin` is a child run: one the child topology
   * holds, or, failing that, one whose identifier is not a catalog run's (`agent-run-`). Such a
   * run was claimed before COR-1868 and is not a task.
   */
  readonly isChildRun: (runId: string) => Promise<boolean>;
  readonly now: () => string;
  readonly ownerOf: (principal: string | undefined) => string;
  readonly originatingMessage: (input: AgentInput) => string | undefined;
}

/** The hook listener that settles a catalog run's task, writing the record first when a recovered run has none. */
export function createCatalogTaskSettler({
  tasks,
  loadRecoveryRecord,
  durableCreatedAt,
  isChildRun,
  now,
  ownerOf,
  originatingMessage,
}: CatalogTaskSettlerDependencies): (settlement: CatalogRunSettlement) => Promise<void> {
  return async (settlement) => {
    const content = settlement.status === 'completed' ? (settlement.content ?? '') : '';
    const taskSettlement = {
      at: now(),
      status: settlement.status,
      finishReason: settlement.finishReason,
      message: settlement.message,
      ...(content === ''
        ? {}
        : {
            answer: {
              text: content.slice(0, TASK_ARTIFACT_TEXT_LIMIT),
              truncated: content.length > TASK_ARTIFACT_TEXT_LIMIT,
            },
          }),
    };
    if (await tasks.recordSettled(settlement.runId, taskSettlement)) return;
    if (!settlement.recovered) return;
    const loaded = await loadRecoveryRecord(settlement.runId);
    // A subordinate run's claim says what its task is: admit it from that, once (a record that
    // exists makes the write a no-op), and settle it.
    if (loaded.status === 'found' && loaded.record.taskOrigin !== undefined) {
      await tasks.recordAdmission(
        subordinateTaskAdmission(
          settlement.runId,
          { ...loaded.record, taskOrigin: loaded.record.taskOrigin },
          { ownerOf, originatingMessage, createdAt: await durableCreatedAt(settlement.runId) },
        ),
      );
      await tasks.recordSettled(settlement.runId, taskSettlement);
      return;
    }
    if (await isChildRun(settlement.runId)) return;
    if (
      loaded.status !== 'found' ||
      loaded.record.goalAttempt !== undefined ||
      loaded.record.workflowStep !== undefined
    ) {
      return;
    }
    const createdAt = await durableCreatedAt(settlement.runId);
    await tasks.recordAdmission({
      taskId: settlement.runId,
      contextId: loaded.record.contextId ?? settlement.runId,
      incarnation: '',
      agentName: loaded.record.agentName,
      owner: ownerOf(loaded.record.principal),
      // The run's original start is gone with its record: nothing names a surface for it.
      origin: { kind: 'api' },
      message: originatingMessage(loaded.record.input),
      ...(createdAt === undefined ? {} : { createdAt }),
    });
    await tasks.recordSettled(settlement.runId, taskSettlement);
  };
}
