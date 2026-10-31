/**
 * Which runs a hook started (COR-1940): the tag a `start-workflow` action puts on the workflow
 * instance it starts, and the walk from any run up to that instance. It is what keeps a hook from
 * chaining.
 *
 * ## The rule
 *
 * A `start-workflow` hook acts only on an event whose cause the Bureau can place, and never on one
 * about a run a hook started:
 *
 * - A `run` kind (`BureauEventOrigin` in `bureau-event-catalog.ts`) names a run in its payload
 *   ({@link EVENT_RUN_FIELDS}). The walk follows it to the workflow instance it belongs to, and
 *   the hook starts nothing if that instance carries a hook's tag or lies beneath one (an agent
 *   step, a child, a goal attempt). An event of a `run` kind that names no run is skipped too.
 * - An `external` kind is caused by something outside any run (a schedule's clock, a change to the
 *   definition files), so there is nothing to follow and the hook acts on it.
 * - An `unattributed` kind may be caused by a run and names none (`notification.created`, the
 *   session events, `diagnostic`). A `start-workflow` hook may not list one: `hooks.create` and
 *   `hooks.update` refuse it, and dispatch skips an event of one that a stored record lists anyway.
 *
 * The chain is therefore one start deep. What the rule cannot see is a start that carries no tag
 * (a workflow that starts another workflow some other way), and it sees a schedule only because the
 * schedule carries the origin (COR-1952):
 *
 * - A schedule that a hook-started run creates (a `bureau:workflows-create` or `bureau:workflows-update` with a
 *   `schedule` trigger, or a `schedules.create` the run makes) records the hook that started that
 *   run, in a Bureau record keyed by the schedule (`schedule-hook-origins.ts`).
 * - A run the schedule fires is an instance whose trigger, or a task whose origin, names the
 *   schedule. The walk reads the record for it, so the fire counts as a hook's run and so does
 *   everything beneath it. A schedule with no record (one an owner made) is not a hook's.
 * - The fires of a hook-started run's schedule therefore start no start-workflow hook, however short
 *   the interval, and the chain stays one start deep through them too. `schedule.missed` is the
 *   exception: it is an `external` kind that names no run, so a hook listing it still acts on a
 *   missed occurrence of such a schedule (it needs downtime, and starts nothing more by itself).
 *
 * @module hook-origin
 */

/** The payload fields that name the run an event is about, in the order they are read. */
export const EVENT_RUN_FIELDS: readonly string[] = ['runId', 'goalRunId', 'taskId'];

/** The run an event's payload names, or `undefined` when it names none. */
export function runOfPayload(payload: Readonly<Record<string, unknown>>): string | undefined {
  for (const field of EVENT_RUN_FIELDS) {
    const value = Object.hasOwn(payload, field) ? payload[field] : undefined;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/** The prefix of the Weft tag that marks a workflow instance a hook started; the hook's id follows. */
export const HOOK_ORIGIN_TAG_HEAD = 'hook-origin:';

/** The tag a `start-workflow` action starts its instance with. */
export function hookOriginTag(hookId: string): string {
  return `${HOOK_ORIGIN_TAG_HEAD}${hookId}`;
}

/** The hook a set of workflow tags names as the one that started the instance, or `undefined`. */
export function hookOfTags(tags: readonly string[] | undefined): string | undefined {
  const tag = tags?.find((candidate) => candidate.startsWith(HOOK_ORIGIN_TAG_HEAD));
  return tag === undefined ? undefined : tag.slice(HOOK_ORIGIN_TAG_HEAD.length);
}

/** The longest chain of parents followed from a run before the walk gives up. */
const MAXIMUM_DEPTH = 32;

/** What {@link createHookOriginLookup} reads. */
export interface HookOriginSources {
  /** The Weft tags of the workflow `runId` names, or `undefined` when there is none. */
  workflowTags(runId: string): Promise<readonly string[] | undefined>;
  /** The run `runId`'s task belongs to (a step's instance, a child's parent, an attempt's goal), or `null`. */
  parentOf(runId: string): Promise<string | null>;
  /** The schedule whose fire `runId` is, or `undefined` for a run no schedule fired. */
  scheduleOf(runId: string): Promise<string | undefined>;
  /** The hook that started the run that created schedule `scheduleId`, or `undefined` when none did. */
  hookOfSchedule(scheduleId: string): Promise<string | undefined>;
}

/**
 * Builds the lookup of the hook that started a run, directly or through the runs above it: the
 * hook's id, or `undefined` for a run no hook started. It throws when it cannot tell (a read
 * fails, or the chain is deeper than any real one), and the caller treats that as "started by a
 * hook" rather than let an unbounded chain through.
 */
export function createHookOriginLookup(
  sources: HookOriginSources,
): (runId: string) => Promise<string | undefined> {
  return async (runId) => {
    let current: string | null = runId;
    for (let depth = 0; depth < MAXIMUM_DEPTH && current !== null; depth++) {
      const hookId = hookOfTags(await sources.workflowTags(current));
      if (hookId !== undefined) return hookId;
      const scheduleId = await sources.scheduleOf(current);
      if (scheduleId !== undefined) {
        const scheduled = await sources.hookOfSchedule(scheduleId);
        if (scheduled !== undefined) return scheduled;
      }
      current = await sources.parentOf(current);
    }
    if (current !== null) throw new Error(`Run "${runId}" is nested deeper than ${MAXIMUM_DEPTH}`);
    return undefined;
  };
}
