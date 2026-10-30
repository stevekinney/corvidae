/**
 * The Bureau's answer to "did a hook start this run?" (COR-1940, COR-1952), composed from the
 * three places it can be read: the Weft tags and input of the workflow instance a run is, the origin
 * of the task a run belongs to, and the record a schedule keeps of the hook behind its creator.
 *
 * @module run-hook-origins
 */

import type { ConditionalTextValueStore } from '@lostgradient/storage';

import type { BureauDiagnostic } from '../types.ts';
import { isTaskOrigin, type StoredTaskOrigin, taskOriginParentOf } from '../task-origin.ts';
import { createHookOriginLookup } from './hook-origin.ts';
import {
  createScheduleHookOrigins,
  type ScheduleHookOrigins,
  scheduleOfInstanceInput,
} from './schedule-hook-origins.ts';

/** What the lookup reads from the Bureau it belongs to. */
export interface RunHookOriginSources {
  /** The key-value store schedule origins are kept in, or `undefined` for a Bureau with none. */
  readonly kv: ConditionalTextValueStore | undefined;
  /** The Weft tags and input of the workflow instance `runId` names, or nothing when there is none. */
  readonly workflowOf: (
    runId: string,
  ) => Promise<
    { readonly tags?: readonly string[] | undefined; readonly input?: unknown } | null | undefined
  >;
  /** The origin the task `runId` names recorded, or `undefined` when it has none. */
  readonly taskOriginOf: (runId: string) => Promise<StoredTaskOrigin | undefined>;
  /** Reports what could not be read. */
  readonly diagnose: (diagnostic: BureauDiagnostic) => void;
}

/** What {@link createRunHookOrigins} composes. */
export interface RunHookOrigins {
  /** Where the origin of each schedule a hook-started run created is kept; `undefined` without a store. */
  readonly scheduleHookOrigins: ScheduleHookOrigins | undefined;
  /**
   * The hook that started a run, directly, through the runs above it, or through the schedule that
   * fired it, or `undefined` for a run no hook started. Throws when it cannot tell.
   */
  readonly startedByHook: (runId: string) => Promise<string | undefined>;
  /**
   * {@link RunHookOrigins.startedByHook} for a run that is making a call: a lookup that fails is
   * reported and answers `'unknown'`, a hook's own run, because the cost of a wrong guess is a
   * schedule that escapes the chain guard.
   */
  readonly hookOriginOfRun: (runId: string) => Promise<string | undefined>;
}

/** Composes the lookups of {@link RunHookOrigins} over `sources`. */
export function createRunHookOrigins(sources: RunHookOriginSources): RunHookOrigins {
  const scheduleHookOrigins =
    sources.kv === undefined ? undefined : createScheduleHookOrigins(sources.kv);
  const startedByHook = createHookOriginLookup({
    workflowTags: async (runId) => {
      const workflow = await sources.workflowOf(runId);
      return workflow?.tags;
    },
    parentOf: async (runId) => taskOriginParentOf(await sources.taskOriginOf(runId)),
    scheduleOf: async (runId) => {
      const origin = await sources.taskOriginOf(runId);
      if (origin !== undefined && isTaskOrigin(origin) && origin.kind === 'schedule') {
        return origin.scheduleId;
      }
      const workflow = await sources.workflowOf(runId);
      return scheduleOfInstanceInput(workflow?.input);
    },
    hookOfSchedule: async (scheduleId) => scheduleHookOrigins?.hookOfSchedule(scheduleId),
  });
  return {
    scheduleHookOrigins,
    startedByHook,
    async hookOriginOfRun(runId) {
      try {
        return await startedByHook(runId);
      } catch (cause) {
        sources.diagnose({
          level: 'warn',
          scope: 'hooks',
          message: `[bureau] Could not tell whether a hook started run "${runId}", so what it schedules is treated as a hook's:`,
          cause,
        });
        return 'unknown';
      }
    },
  };
}
