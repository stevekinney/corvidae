/**
 * The schedules Bureau holds because their workflow file stopped parsing (COR-2009, owner decision
 * of Nov 3).
 *
 * A workflow file that stops parsing keeps the schedule its last good version made: the schedule is
 * not cancelled, it reports that the workflow can't load, and it starts nothing until the file
 * parses again. Bureau holds it by pausing it in the engine, which keeps its `nextFireAt` and starts
 * no run and logs no missed fire, and resumes it when the file parses again (the reconcile's own
 * resume, from the time it resumes). Weft's `paused` alone cannot tell a hold from a last good file
 * that said `paused: true`, so a hold is recorded here, before the pause is written: a schedule held
 * this way was active, and it reads as active, with its blocker, while the hold lasts.
 *
 * ## Keys
 *
 * `bureau-workflow-schedule-hold:v1:<identifier>` holds a {@link WorkflowScheduleHold} as JSON: the
 * schedule that was held and when. A record whose file parses again, is gone, or names another
 * schedule than the workflow's live one means nothing, and the next reconcile removes it.
 *
 * @module workflow-schedule-holds
 */

import { MemoryStorage, type TextValueStore, textValueStore } from '@lostgradient/storage';

/** Where the hold records live. */
export const WORKFLOW_SCHEDULE_HOLD_KEY_PREFIX = 'bureau-workflow-schedule-hold:v1:';

/** One held schedule: which one, and when it was held. */
export interface WorkflowScheduleHold {
  /** The record's format; `1`. */
  readonly schemaVersion: 1;
  /** The schedule Bureau paused for the file problem. */
  readonly scheduleId: string;
  /** When it was held, as an ISO 8601 instant. */
  readonly heldAt: string;
}

/** The hold records of one Bureau. */
export interface WorkflowScheduleHolds {
  /** Records that schedule `scheduleId` of workflow `identifier` is held, replacing any record. */
  readonly hold: (identifier: string, scheduleId: string) => Promise<void>;
  /** The hold recorded for workflow `identifier`, or `undefined`. */
  readonly held: (identifier: string) => Promise<WorkflowScheduleHold | undefined>;
  /** Removes the hold recorded for workflow `identifier`, if there is one. */
  readonly release: (identifier: string) => Promise<void>;
}

/** What {@link createWorkflowScheduleHolds} is built on. */
export interface WorkflowScheduleHoldsOptions {
  /** Where the records live; a memory store when absent, which a restart forgets. */
  readonly store?: TextValueStore | undefined;
  /** The current time as an ISO 8601 instant, for {@link WorkflowScheduleHold.heldAt}. */
  readonly nowISO: () => string;
}

function keyOf(identifier: string): string {
  return `${WORKFLOW_SCHEDULE_HOLD_KEY_PREFIX}${identifier}`;
}

function parseHold(text: string | null | undefined): WorkflowScheduleHold | undefined {
  if (text === null || text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Partial<WorkflowScheduleHold>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.scheduleId !== 'string' ||
    typeof record.heldAt !== 'string'
  ) {
    return undefined;
  }
  return { schemaVersion: 1, scheduleId: record.scheduleId, heldAt: record.heldAt };
}

/** The hold records kept in `options.store`. */
export function createWorkflowScheduleHolds(
  options: WorkflowScheduleHoldsOptions,
): WorkflowScheduleHolds {
  const store = options.store ?? textValueStore(new MemoryStorage());
  return {
    async hold(identifier, scheduleId) {
      const record: WorkflowScheduleHold = {
        schemaVersion: 1,
        scheduleId,
        heldAt: options.nowISO(),
      };
      await store.set(keyOf(identifier), JSON.stringify(record));
    },
    async held(identifier) {
      return parseHold(await store.get(keyOf(identifier)));
    },
    async release(identifier) {
      await store.delete(keyOf(identifier));
    },
  };
}
