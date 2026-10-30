/**
 * Which schedules a hook-started run created (COR-1952): the record that lets the chain guard in
 * `hook-origin.ts` see a schedule's fires as runs a hook started.
 *
 * A `start-workflow` hook never acts on an event about a run a hook started. A schedule that such a
 * run creates would escape that, because each of its fires is a run no hook started. So the Bureau
 * keeps one record for it: the id of the hook that started the run that created (or changed) the
 * schedule. A fire, and everything beneath it, is then read as that hook's run.
 *
 * ## What is stored
 *
 * One text value per origin, `{"version":1,"hookId":"<hook id>"}`, under
 * `bureau-hook-schedule-origin:v1:<kind>:<id>`:
 *
 * - `workflow:<identifier>` for the schedule a workflow file owns. The file owns its schedule and
 *   replaces it under a new generation id, so the record is keyed by the workflow identifier and
 *   read for any generation of it.
 * - `schedule:<scheduleId>` for an agent schedule (`schedules.create`).
 *
 * A schedule with no record was made by an owner (or by a file or request no hook-started run made)
 * and its fires start hooks as before. A record of a kind or version this release does not know
 * reads as no record, never as a hook.
 *
 * @module schedule-hook-origins
 */

import type { ConditionalTextValueStore } from '@lostgradient/storage';

import { parseWorkflowScheduleId } from '../workflow-schedule.ts';

/** Every record this module keeps has a key starting with this. */
export const HOOK_SCHEDULE_ORIGIN_KEY_PREFIX = 'bureau-hook-schedule-origin:v1:';

/** The stored form of one record. */
interface StoredScheduleHookOrigin {
  readonly version: 1;
  readonly hookId: string;
}

/** Where the hook that started the run that created each schedule is kept. */
export interface ScheduleHookOrigins {
  /**
   * Records that the hook `hookId` started the run that wrote workflow `identifier`'s file, so
   * the schedule that file owns, under any generation, carries the hook's origin.
   */
  recordWorkflow(identifier: string, hookId: string): Promise<void>;
  /** Forgets the origin of workflow `identifier`: its file was created again by something no hook started. */
  clearWorkflow(identifier: string): Promise<void>;
  /** Records that the hook `hookId` started the run that created agent schedule `scheduleId`. */
  recordSchedule(scheduleId: string, hookId: string): Promise<void>;
  /** Forgets the origin of agent schedule `scheduleId`, for a schedule that was not created after all. */
  clearSchedule(scheduleId: string): Promise<void>;
  /**
   * The hook that started the run that created the schedule `scheduleId` names, or `undefined`
   * when none did. A workflow schedule id is read through its workflow's identifier.
   */
  hookOfSchedule(scheduleId: string): Promise<string | undefined>;
}

function workflowKey(identifier: string): string {
  return `${HOOK_SCHEDULE_ORIGIN_KEY_PREFIX}workflow:${identifier}`;
}

function scheduleKey(scheduleId: string): string {
  return `${HOOK_SCHEDULE_ORIGIN_KEY_PREFIX}schedule:${scheduleId}`;
}

function hookIdOf(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Partial<Record<keyof StoredScheduleHookOrigin, unknown>>;
  if (record.version !== 1) return undefined;
  return typeof record.hookId === 'string' && record.hookId !== '' ? record.hookId : undefined;
}

/** The schedule origins of a Bureau, kept in its key-value store. */
export function createScheduleHookOrigins(kv: ConditionalTextValueStore): ScheduleHookOrigins {
  const write = (key: string, hookId: string): Promise<void> =>
    kv.set(key, JSON.stringify({ version: 1, hookId } satisfies StoredScheduleHookOrigin));
  return {
    recordWorkflow: (identifier, hookId) => write(workflowKey(identifier), hookId),
    async clearWorkflow(identifier) {
      await kv.delete(workflowKey(identifier));
    },
    recordSchedule: (scheduleId, hookId) => write(scheduleKey(scheduleId), hookId),
    async clearSchedule(scheduleId) {
      await kv.delete(scheduleKey(scheduleId));
    },
    async hookOfSchedule(scheduleId) {
      const workflow = parseWorkflowScheduleId(scheduleId);
      return hookIdOf(
        await kv.get(
          workflow === undefined ? scheduleKey(scheduleId) : workflowKey(workflow.identifier),
        ),
      );
    },
  };
}

/**
 * The schedule a workflow instance's input names, or `undefined`: the trigger `{ kind: 'schedule',
 * scheduleId }` a workflow file's schedule starts its instance with, or the input of an agent
 * schedule's fire, which carries its `scheduleId` beside the `agentName` it runs.
 */
export function scheduleOfInstanceInput(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const record = input as Readonly<Record<string, unknown>>;
  const scheduleId = Object.hasOwn(record, 'scheduleId') ? record['scheduleId'] : undefined;
  if (typeof scheduleId !== 'string' || scheduleId === '') return undefined;
  const isTrigger = record['kind'] === 'schedule';
  const isAgentFire = typeof record['agentName'] === 'string';
  return isTrigger || isAgentFire ? scheduleId : undefined;
}
