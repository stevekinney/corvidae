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
 * The chain is therefore one start deep. What the rule cannot see is a start that carries no tag: a
 * run that creates a schedule, whose later fires are runs no hook started, or a workflow that
 * starts another workflow some other way.
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
      current = await sources.parentOf(current);
    }
    if (current !== null) throw new Error(`Run "${runId}" is nested deeper than ${MAXIMUM_DEPTH}`);
    return undefined;
  };
}
