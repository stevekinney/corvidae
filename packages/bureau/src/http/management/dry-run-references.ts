/**
 * What deleting or disabling an agent, or deleting a workflow, reaches besides the thing itself:
 * the counts a dry run reports as its `effects`. The reads are the Bureau's own listings; none of
 * them writes a record (a task listing, which records a snapshot, is never used here).
 *
 * @module dry-run-references
 */

import type { OperationFault } from '@lostgradient/backchannel';

import { isTerminalGoalStatus } from '../../goal-state.ts';
import type { Bureau } from '../../bureau-types/facade.ts';
import { parseWorkflowScheduleId } from '../../workflow-schedule.ts';
import { type DryRunEffect, effect, effectAtLeast } from './dry-run.ts';

/** What the dry run of an agent's or a workflow's removal reads from the handler's `host`. */
export type BureauDryRunHost = {
  readonly dryRun: {
    /** What deleting or disabling the agent `agentName` reaches: its schedules, goals and open chats. */
    readonly agentEffects: (agentName: string) => Promise<readonly DryRunEffect[]>;
    /** What deleting the workflow `id` reaches: its schedules and its running instances. */
    readonly workflowEffects: (id: string) => Promise<readonly DryRunEffect[]>;
  };
};

/** How many records one read of a listing takes. */
const PAGE = 100;

/** The most records one count reads before it reports a floor. */
const MAXIMUM_COUNTED = 10_000;

/** The parts of a Bureau the effects are read from. */
type Source = {
  readonly schedules: Pick<Bureau['schedules'], 'list' | 'agentName'>;
  readonly goals: Pick<Bureau['goals'], 'list'>;
  readonly contexts: Pick<Bureau['contexts'], 'list'>;
  readonly workflows: Pick<NonNullable<Bureau['workflows']>, 'runCounts'> | undefined;
};

/** One read of a listing: the records at `offset`, and whether the listing goes on after them. */
type Page<Item> = { readonly items: readonly Item[]; readonly more: boolean } | undefined;

/**
 * Counts the records `matches` accepts across the pages `read` returns, stopping once
 * {@link MAXIMUM_COUNTED} records have been read; a count that stopped there is a floor.
 */
async function countMatching<Item>(
  kind: DryRunEffect['kind'],
  read: (offset: number) => Promise<Page<Item>>,
  matches: (item: Item) => boolean | Promise<boolean>,
): Promise<DryRunEffect> {
  let count = 0;
  for (let offset = 0; offset < MAXIMUM_COUNTED; offset += PAGE) {
    const page = await read(offset);
    if (page === undefined) return effect(kind, count);
    for (const item of page.items) if (await matches(item)) count += 1;
    if (!page.more) return effect(kind, count);
  }
  return effectAtLeast(kind, count);
}

/** The schedules the Bureau keeps, a page at a time. */
function schedulePages(
  bureau: Source,
): (offset: number) => Promise<Page<{ id: string; status: string }>> {
  return async (offset) => {
    const page = await bureau.schedules.list({ limit: PAGE, offset });
    if (page === undefined) return undefined;
    return {
      items: page.items,
      more: page.items.length > 0 && offset + page.items.length < page.total,
    };
  };
}

/** The effects a dry run reports, computed from `bureau`'s own listings. */
export function dryRunEffectsOf(bureau: Source): BureauDryRunHost['dryRun'] {
  return {
    async agentEffects(agentName) {
      const schedules = await countMatching(
        'schedules',
        schedulePages(bureau),
        async (summary) =>
          summary.status !== 'cancelled' &&
          (await bureau.schedules.agentName(summary.id)) === agentName,
      );
      const everyGoal = await bureau.goals.list();
      const goals = everyGoal.filter(
        (goal) => !isTerminalGoalStatus(goal.status) && goal.objective.agentName === agentName,
      ).length;
      const chats = await countMatching(
        'open-chats',
        async (offset) => {
          const sessions = await bureau.contexts.list({
            agentName,
            archived: 'exclude',
            limit: PAGE,
            offset,
          });
          return { items: sessions, more: sessions.length === PAGE };
        },
        () => true,
      );
      return [schedules, effect('goals', goals), chats];
    },
    async workflowEffects(id) {
      const schedules = await countMatching(
        'schedules',
        schedulePages(bureau),
        (summary) =>
          summary.status !== 'cancelled' && parseWorkflowScheduleId(summary.id)?.identifier === id,
      );
      const counts = await bureau.workflows?.runCounts(id);
      if (counts === undefined || counts === null) {
        throw {
          code: 'Unavailable',
          message: `The instances of workflow "${id}" cannot be counted right now`,
          data: { reason: 'workflow-run-counts-unavailable' },
        } satisfies OperationFault;
      }
      return [schedules, effect('running-instances', counts.active)];
    },
  };
}
