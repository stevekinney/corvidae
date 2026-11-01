/**
 * The Bureau's answer to "did a hook start this run?" (COR-1940, COR-1952), composed from the
 * three places it can be read: the Weft tags and input of the workflow instance a run is, the origin
 * of the task a run belongs to, and the record a schedule keeps of the hook behind its creator.
 *
 * @module run-hook-origins
 */

import type { ConditionalTextValueStore } from '@lostgradient/storage';

import { bureauNameOf } from '../namespaced-identifier.ts';
import type { BureauDiagnostic } from '../types.ts';
import { isTaskOrigin, type StoredTaskOrigin, taskOriginParentOf } from '../task-origin.ts';
import { createHookOriginLookup } from './hook-origin.ts';
import type { HookRunSubjects } from './hook-scope.ts';
import {
  createScheduleHookOrigins,
  type ScheduleHookOrigins,
  scheduleOfInstanceInput,
} from './schedule-hook-origins.ts';

/** What the lookup reads from the Bureau it belongs to. */
export interface RunHookOriginSources {
  /** The key-value store schedule origins are kept in, or `undefined` for a Bureau with none. */
  readonly kv: ConditionalTextValueStore | undefined;
  /** The Weft type, tags and input of the workflow instance `runId` names, or nothing when there is none. */
  readonly workflowOf: (runId: string) => Promise<
    | {
        readonly type?: string | undefined;
        readonly tags?: readonly string[] | undefined;
        readonly input?: unknown;
      }
    | null
    | undefined
  >;
  /** The origin the task `runId` names recorded, or `undefined` when it has none. */
  readonly taskOriginOf: (runId: string) => Promise<StoredTaskOrigin | undefined>;
  /** The agent the task `runId` names ran, or `undefined` when it names none. */
  readonly agentOf: (runId: string) => Promise<string | null | undefined>;
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
  /**
   * What a hook's scope reads about a run (COR-1978): its own agent, and the workflows and schedules
   * of the run and every run above it. Throws when the walk cannot finish.
   */
  readonly subjectsOfRun: (runId: string) => Promise<HookRunSubjects>;
}

/** The longest chain of parents a run's subjects are read through, as the chain guard's walk. */
const MAXIMUM_SUBJECT_DEPTH = 32;

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
    async subjectsOfRun(runId) {
      const workflows = new Set<string>();
      const schedules = new Set<string>();
      let current: string | null = runId;
      for (let depth = 0; depth < MAXIMUM_SUBJECT_DEPTH && current !== null; depth++) {
        const workflow = await sources.workflowOf(current);
        if (workflow?.type !== undefined) workflows.add(bureauNameOf(workflow.type));
        const origin = await sources.taskOriginOf(current);
        const fired =
          origin !== undefined && isTaskOrigin(origin) && origin.kind === 'schedule'
            ? origin.scheduleId
            : scheduleOfInstanceInput(workflow?.input);
        if (fired !== undefined) schedules.add(fired);
        current = taskOriginParentOf(origin);
      }
      if (current !== null) {
        throw new Error(`Run "${runId}" is nested deeper than ${MAXIMUM_SUBJECT_DEPTH}`);
      }
      const agent = await sources.agentOf(runId);
      return { agent: agent ?? undefined, workflows: [...workflows], schedules: [...schedules] };
    },
  };
}
