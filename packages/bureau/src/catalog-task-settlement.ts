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
 * What it filters: the hook also publishes a recovered child run and a recovered goal attempt, and
 * neither is a task. A run the child topology holds, and a goal attempt, is never given a record
 * here; a record that exists is settled whatever kind of run it is.
 *
 * @module catalog-task-settlement
 */
import type { CatalogRunSettlement } from './catalog-run-settlement';
import type { CatalogRunRecoveryLoad } from './runtime-composition';
import { TASK_ARTIFACT_TEXT_LIMIT, type TaskRegistry } from './task-registry';
import type { AgentInput } from '@lostgradient/operative';

/** What the settler reads from the Bureau around it. */
export interface CatalogTaskSettlerDependencies {
  readonly tasks: Pick<TaskRegistry, 'recordSettled' | 'recordAdmission'>;
  readonly loadRecoveryRecord: (runId: string) => Promise<CatalogRunRecoveryLoad>;
  /** When the durable run was created (ISO 8601), or `undefined` when the engine has no record of it. */
  readonly durableCreatedAt: (runId: string) => Promise<string | undefined>;
  /**
   * Whether the run is a child run: one the child topology holds, or, failing that, one whose
   * identifier is not a catalog run's (`agent-run-`). A child run is not a task.
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
    if (await isChildRun(settlement.runId)) return;
    const loaded = await loadRecoveryRecord(settlement.runId);
    if (loaded.status !== 'found' || loaded.record.goalAttempt !== undefined) return;
    const createdAt = await durableCreatedAt(settlement.runId);
    await tasks.recordAdmission({
      taskId: settlement.runId,
      contextId: loaded.record.contextId ?? settlement.runId,
      incarnation: '',
      agentName: loaded.record.agentName,
      owner: ownerOf(loaded.record.principal),
      message: originatingMessage(loaded.record.input),
      ...(createdAt === undefined ? {} : { createdAt }),
    });
    await tasks.recordSettled(settlement.runId, taskSettlement);
  };
}
