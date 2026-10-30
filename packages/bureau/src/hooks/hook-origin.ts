/**
 * Which runs a hook started (COR-1940): the tag a `start-workflow` action puts on the workflow
 * instance it starts, and the walk from any run up to that instance. It is what keeps a hook from
 * chaining: a run a hook started, or any run beneath it (an agent step, a child), raises events
 * that no `start-workflow` hook acts on, so the chain is one start deep however the events loop.
 *
 * @module hook-origin
 */

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
