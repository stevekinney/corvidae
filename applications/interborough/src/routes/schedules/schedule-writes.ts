/**
 * Pause, resume, and cancel a schedule through the service that owns it (`lib/schedule-kinds.ts`).
 * A schedule is never written through the wrong one: the Bureau's agent schedule goes through
 * `bureau.schedules.*` with the revision the caller read, a workflow file's through
 * `bureau.workflows.pause` and `resume` with the hash of the file the caller read, and any other
 * through the engine, which has no stale check.
 */
import type { HttpClient, ScheduleSummary } from '@lostgradient/weft';

import {
  cancelAgentSchedule,
  listAgentScheduleMissed,
  pauseAgentSchedule,
  resumeAgentSchedule,
  runNowAgentSchedule,
  skipNextAgentSchedule,
  type MissedFire,
  type RunNowOutcome,
} from '../../lib/bureau-schedules.ts';
import { AGENT_RUN_TYPE, type ScheduleKind } from '../../lib/schedule-kinds.ts';
import { pauseWorkflowFile, resumeWorkflowFile } from '../../lib/workflow-files.ts';
import {
  cancelSchedule,
  listScheduleMissed,
  pauseSchedule,
  resumeSchedule,
  runNowSchedule,
  skipNextSchedule,
  type ScheduleControlClient,
} from './schedule-queries.ts';

/** A schedule as the page read it, and what owns it. */
export type ScheduleTarget = {
  readonly schedule: Pick<ScheduleSummary, 'id' | 'revision' | 'status' | 'nextFireAt'>;
  readonly kind: ScheduleKind;
};

/** What a kind of schedule can be asked to do. */
export type ScheduleActions = {
  readonly pause: boolean;
  readonly resume: boolean;
  readonly cancel: boolean;
  /** Skip the next fire: an active schedule an owner writes. */
  readonly skipNext: boolean;
  /** Start one run now: a schedule that is not cancelled, paused included. */
  readonly runNow: boolean;
  readonly edit: boolean;
  /** Where its cadence is edited when that is not here: the workflow's editor. */
  readonly editInWorkflow: boolean;
};

/**
 * The actions a schedule offers. A cancelled schedule offers none. A workflow file's schedule can
 * be paused and resumed only while its file is one the Bureau can use and has a hash to name; the
 * rest of what changes it is the file's. A kind that is not known offers nothing.
 */
export function actionsOf(target: ScheduleTarget): ScheduleActions {
  const none = {
    pause: false,
    resume: false,
    cancel: false,
    skipNext: false,
    runNow: false,
    edit: false,
    editInWorkflow: false,
  };
  if (target.schedule.status === 'cancelled') return none;
  const { status } = target.schedule;
  switch (target.kind.kind) {
    case 'agent-run':
    case 'code':
      return {
        pause: status === 'active',
        resume: status === 'paused',
        cancel: true,
        skipNext: status === 'active',
        runNow: true,
        edit: true,
        editInWorkflow: false,
      };
    case 'workflow-file': {
      const writable = target.kind.file.state === 'ready' && target.kind.file.hash !== null;
      return {
        pause: writable && status === 'active',
        resume: writable && status === 'paused',
        cancel: false,
        skipNext: false,
        runNow: false,
        edit: false,
        editInWorkflow: true,
      };
    }
    case 'unknown':
      return none;
  }
}

function fileHash(target: ScheduleTarget): string {
  if (target.kind.kind !== 'workflow-file' || target.kind.file.hash === null) {
    throw new Error('The workflow file has no hash to name, so it cannot be written.');
  }
  return target.kind.file.hash;
}

function refuse(target: ScheduleTarget, action: string): never {
  throw new Error(`A ${target.kind.kind} schedule cannot be ${action} from here.`);
}

export async function pauseTarget(client: HttpClient, target: ScheduleTarget): Promise<void> {
  switch (target.kind.kind) {
    case 'agent-run':
      await pauseAgentSchedule(target.schedule.id, target.schedule.revision);
      return;
    case 'workflow-file':
      await pauseWorkflowFile(target.kind.file.id, fileHash(target));
      return;
    case 'code':
      await assertUnchanged(client, target);
      await pauseSchedule(client, target.schedule.id);
      return;
    case 'unknown':
      return refuse(target, 'paused');
  }
}

export async function resumeTarget(client: HttpClient, target: ScheduleTarget): Promise<void> {
  switch (target.kind.kind) {
    case 'agent-run':
      await resumeAgentSchedule(target.schedule.id, target.schedule.revision);
      return;
    case 'workflow-file':
      await resumeWorkflowFile(target.kind.file.id, fileHash(target));
      return;
    case 'code':
      await assertUnchanged(client, target);
      await resumeSchedule(client, target.schedule.id);
      return;
    case 'unknown':
      return refuse(target, 'resumed');
  }
}

export async function cancelTarget(client: HttpClient, target: ScheduleTarget): Promise<void> {
  switch (target.kind.kind) {
    case 'agent-run':
      await cancelAgentSchedule(target.schedule.id, target.schedule.revision);
      return;
    case 'code':
      await assertUnchanged(client, target);
      await cancelSchedule(client, target.schedule.id);
      return;
    case 'workflow-file':
    case 'unknown':
      return refuse(target, 'cancelled');
  }
}

/**
 * A write that the schedule it was made for is no longer the one the person saw: the engine has no
 * revision to compare inside its own write, so the page reads the schedule again just before it
 * writes and refuses when its revision or status moved. This narrows the window to one round trip
 * and does not close it; the Bureau's schedules close it, because they compare inside the write.
 */
export class StaleScheduleError extends Error {
  readonly scheduleId: string;

  constructor(scheduleId: string) {
    super(`Schedule "${scheduleId}" changed since it was read.`);
    this.name = 'StaleScheduleError';
    this.scheduleId = scheduleId;
  }
}

/**
 * Refuses a write to an engine schedule that moved on after the page read it. A fire moves
 * `nextFireAt` and not the revision, so a write that names the run it means (a skip) also compares
 * `nextFireAt`: the person chose the run the page showed, not the one that is next by now.
 */
async function assertUnchanged(
  client: Pick<HttpClient, 'getSchedule'>,
  target: ScheduleTarget,
  options: { readonly nextFireAt?: boolean } = {},
): Promise<void> {
  const now = await client.getSchedule(target.schedule.id);
  if (
    now === null ||
    now.revision !== target.schedule.revision ||
    now.status !== target.schedule.status ||
    (options.nextFireAt === true && now.nextFireAt !== target.schedule.nextFireAt)
  ) {
    throw new StaleScheduleError(target.schedule.id);
  }
}

/** Skips the next fire of an active schedule, through the service that owns it. */
export async function skipNextTarget(client: HttpClient, target: ScheduleTarget): Promise<void> {
  switch (target.kind.kind) {
    case 'agent-run':
      await skipNextAgentSchedule(target.schedule.id, target.schedule.revision);
      return;
    case 'code':
      await assertUnchanged(client, target, { nextFireAt: true });
      await skipNextSchedule(client, target.schedule.id);
      return;
    case 'workflow-file':
    case 'unknown':
      return refuse(target, 'skipped');
  }
}

/** Starts one run of the schedule now, through the service that owns it. */
export async function runNowTarget(
  client: ScheduleControlClient,
  target: ScheduleTarget,
): Promise<RunNowOutcome> {
  switch (target.kind.kind) {
    case 'agent-run':
      return runNowAgentSchedule(target.schedule.id);
    case 'code':
      return runNowSchedule(client, target.schedule.id);
    case 'workflow-file':
    case 'unknown':
      return refuse(target, 'run now');
  }
}

/**
 * The fires a schedule missed. A schedule that runs an agent is read through the Bureau, which
 * checks its owner; any other is read from the engine, which only reads it. Which it is follows from
 * the type it starts, so the read does not wait for the Bureau to say whose the schedule is.
 */
export function missedOf(
  client: ScheduleControlClient,
  schedule: Pick<ScheduleSummary, 'id' | 'workflowType'>,
): Promise<readonly MissedFire[]> {
  return schedule.workflowType === AGENT_RUN_TYPE
    ? listAgentScheduleMissed(schedule.id)
    : listScheduleMissed(client, schedule.id);
}
