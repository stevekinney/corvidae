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
  pauseAgentSchedule,
  resumeAgentSchedule,
} from '../../lib/bureau-schedules.ts';
import type { ScheduleKind } from '../../lib/schedule-kinds.ts';
import { pauseWorkflowFile, resumeWorkflowFile } from '../../lib/workflow-files.ts';
import { cancelSchedule, pauseSchedule, resumeSchedule } from './schedule-queries.ts';

/** A schedule as the page read it, and what owns it. */
export type ScheduleTarget = {
  readonly schedule: Pick<ScheduleSummary, 'id' | 'revision' | 'status'>;
  readonly kind: ScheduleKind;
};

/** What a kind of schedule can be asked to do. */
export type ScheduleActions = {
  readonly pause: boolean;
  readonly resume: boolean;
  readonly cancel: boolean;
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
  const none = { pause: false, resume: false, cancel: false, edit: false, editInWorkflow: false };
  if (target.schedule.status === 'cancelled') return none;
  const { status } = target.schedule;
  switch (target.kind.kind) {
    case 'agent-run':
    case 'code':
      return {
        pause: status === 'active',
        resume: status === 'paused',
        cancel: true,
        edit: true,
        editInWorkflow: false,
      };
    case 'workflow-file': {
      const writable = target.kind.file.state === 'ready' && target.kind.file.hash !== null;
      return {
        pause: writable && status === 'active',
        resume: writable && status === 'paused',
        cancel: false,
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
      await cancelSchedule(client, target.schedule.id);
      return;
    case 'workflow-file':
    case 'unknown':
      return refuse(target, 'cancelled');
  }
}
