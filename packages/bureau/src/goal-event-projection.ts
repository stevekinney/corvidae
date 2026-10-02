/**
 * COR-851 — the durable audit projection of a goal.
 *
 * COR-638's table marks seven goal events "live + durable audit" and one,
 * `goal.recovered`, durable only. A durable goal has no live emitter, so this
 * file derives them from the one thing that is always true: the committed
 * `GoalState`. Every goal-store write funnels through the store's observer,
 * which hands the post-write record here.
 *
 * ## What an event may carry
 *
 * Ids, names, versions, statuses, reasons, and a SHA-256 digest of validator
 * feedback. Never evidence, raw feedback, the objective, `failureDetail`, or
 * `ValidatorError.cause`: those stay on the record behind `bureau.goals.get`,
 * which authorizes the caller. A `goal.failed` event carries the error's
 * `kind`, `code`, and `message` only.
 *
 * ## Idempotence
 *
 * Each draft names a `dedupeKey`, and `DurableEventHistory.record` commits the
 * marker in the same batch as the append, so recording the same draft twice is
 * a read of the first. The key is `${goalRunId}:${transitionSeq}`; the event
 * `kind` is part of the marker, so one transition that implies two events (a
 * validation and the terminal decision it produced) still records both. That
 * makes the projection safe to run again from anywhere:
 *
 * - a workflow activity replayed after a crash re-commits its transition, the
 *   store answers `duplicate`, and the observer runs again;
 * - boot recovery re-projects every record's creation and current transition,
 *   which closes the window between the latest write and its projection;
 * - the host's own cancellation commit and a controller's commit of the same
 *   transition both project, and only one event results.
 *
 * `goal.recovered` is the exception that proves the key: a controller restart
 * advances `controllerRestarts` but never `transitionSeq`, so its key also
 * carries the restart ordinal.
 *
 * `emittedAtMs` is the commit's own timestamp, never the moment a replay
 * happens to run, so a re-projection cannot misdate an event.
 */

import { sha256HexSync } from '@lostgradient/cryptography';
import type { ProjectedValidatorOutcome } from '@lostgradient/operative';

import type { DurableEventHistory } from './durable-event-history';
import type { GoalState } from './goal-state';
import type { GoalStoreObservation } from './goal-store';
import type { DiagnosticSink } from './types';

export type GoalObservation = GoalStoreObservation;

/** One event to record under the goal's `{ kind: 'goal' }` owner. */
export interface GoalEventDraft {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly dedupeKey: string;
  readonly emittedAtMs?: number | undefined;
}

type Outcome = ProjectedValidatorOutcome['kind'];

function timestampOf(iso: string): number | undefined {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** The error a failed goal names, without `cause`: validator internals never reach an event. */
function validatorErrorOf(
  outcome: ProjectedValidatorOutcome | undefined,
): { kind: string; code: string; message: string } | undefined {
  if (outcome === undefined) return undefined;
  if (outcome.kind !== 'error' && outcome.kind !== 'unavailable') return undefined;
  const { kind, code, message } = outcome.error;
  return { kind, code, message };
}

const keyFor = (record: GoalState): string => `${record.goalRunId}:${record.transitionSeq}`;

function startedEvent(record: GoalState): GoalEventDraft {
  return {
    kind: 'goal.started',
    payload: {
      goalRunId: record.goalRunId,
      goalIdentity: { name: record.identity.name, version: record.identity.version },
    },
    dedupeKey: `${record.goalRunId}:0`,
    emittedAtMs: timestampOf(record.createdAt),
  };
}

function attemptStartedEvent(record: GoalState): GoalEventDraft[] {
  const attempt = record.attempts.at(-1);
  if (attempt === undefined) return [];
  return [
    {
      kind: 'goal.attempt.started',
      payload: {
        goalRunId: record.goalRunId,
        attemptId: attempt.attemptId,
        attemptIndex: attempt.attemptIndex,
        runId: attempt.runId,
      },
      dedupeKey: keyFor(record),
      emittedAtMs: timestampOf(record.currentTransition.at),
    },
  ];
}

function attemptValidatedEvent(record: GoalState): GoalEventDraft[] {
  const attempt = record.attempts.at(-1);
  const validation = attempt?.validation;
  if (attempt === undefined || validation === undefined) return [];
  const outcome = validation.outcome;
  const outcomeKind: Outcome = outcome.kind;
  return [
    {
      kind: 'goal.attempt.validated',
      payload: {
        goalRunId: record.goalRunId,
        attemptId: attempt.attemptId,
        validatorIdentity: {
          name: validation.identity.name,
          version: validation.identity.version,
        },
        outcomeKind,
        ...(outcome.kind === 'fail' ? { feedbackDigest: sha256HexSync(outcome.feedback) } : {}),
      },
      dedupeKey: keyFor(record),
      emittedAtMs: timestampOf(validation.completedAt),
    },
  ];
}

function terminalEvent(record: GoalState): GoalEventDraft[] {
  const reason = record.terminalReason;
  if (reason === undefined) return [];
  const base = { goalRunId: record.goalRunId, terminalReason: reason };
  const draft = (kind: string, payload: Readonly<Record<string, unknown>>): GoalEventDraft[] => [
    {
      kind,
      payload,
      dedupeKey: keyFor(record),
      emittedAtMs: timestampOf(record.currentTransition.at),
    },
  ];
  switch (record.status) {
    case 'succeeded':
      return draft('goal.succeeded', base);
    case 'exhausted':
      return draft('goal.exhausted', base);
    case 'canceled':
      return draft('goal.canceled', base);
    case 'failed': {
      const validatorError = validatorErrorOf(record.attempts.at(-1)?.validation?.outcome);
      return draft('goal.failed', {
        ...base,
        ...(validatorError === undefined || reason !== 'validator-infrastructure-error'
          ? {}
          : { validatorError }),
      });
    }
    default:
      return [];
  }
}

function transitionEvents(record: GoalState): GoalEventDraft[] {
  const { from, to } = record.currentTransition;
  const events: GoalEventDraft[] = [];
  if (to === 'running') events.push(...attemptStartedEvent(record));
  // The validator's verdict commits together with the decision it produced.
  if (from === 'evaluating') events.push(...attemptValidatedEvent(record));
  events.push(...terminalEvent(record));
  return events;
}

/** The events a goal write implies. Pure; a transition with none (`evaluating`, `retrying`) yields `[]`. */
export function projectGoalObservation(observation: GoalObservation): GoalEventDraft[] {
  const { record } = observation;
  switch (observation.kind) {
    case 'created':
      return [startedEvent(record)];
    case 'transitioned':
      return transitionEvents(record);
    case 'controller-restarted':
      return [
        {
          kind: 'goal.recovered',
          payload: {
            goalRunId: record.goalRunId,
            controllerRestarts: record.controllerRestarts,
            status: record.status,
            transitionSeq: record.transitionSeq,
          },
          dedupeKey: `${keyFor(record)}:restart-${record.controllerRestarts}`,
          emittedAtMs: timestampOf(record.updatedAt),
        },
      ];
  }
}

/**
 * The goal store's observer: records every projected event, in order. A failed
 * write is diagnosed and swallowed, because the record is the truth and a lost
 * projection is repaired by `projectGoalHistory` at the next boot; failing the
 * commit over an audit write would stall the goal instead.
 */
export function createGoalEventRecorder(
  history: Pick<DurableEventHistory, 'record'>,
  diagnose: DiagnosticSink,
): (observation: GoalObservation) => Promise<void> {
  return async (observation) => {
    const owner = { kind: 'goal' as const, id: observation.record.goalRunId };
    for (const draft of projectGoalObservation(observation)) {
      try {
        await history.record(owner, draft.kind, draft.payload, {
          dedupeKey: draft.dedupeKey,
          ...(draft.emittedAtMs === undefined ? {} : { emittedAtMs: draft.emittedAtMs }),
        });
      } catch (error) {
        diagnose({
          level: 'error',
          scope: 'goals',
          message: `[bureau] Could not record ${draft.kind} for goal "${owner.id}" in the durable event history: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
        });
      }
    }
  };
}

/**
 * Projects what each record says happened at its creation and in its current
 * transition. Idempotent, so boot recovery runs it over every goal.
 */
export async function projectGoalHistory(
  records: readonly GoalState[],
  record: (observation: GoalObservation) => Promise<void>,
): Promise<void> {
  for (const goal of records) {
    await record({ kind: 'created', record: goal });
    if (goal.transitionSeq > 0) await record({ kind: 'transitioned', record: goal });
  }
}
