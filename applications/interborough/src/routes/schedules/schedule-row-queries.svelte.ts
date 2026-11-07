/**
 * The rows of the schedules a page shows, made from everything the Bureau and the engine say of them
 * so far: the agents (named, and whether each needs a model), what needs attention (a provider
 * connected or not), the workflow types the engine can run, and the agents a workflow whose file
 * cannot load ran in its last saved version. A schedule's page reads the same sources the list does
 * (the cache holds one entry for each), so it names a schedule, says why it will not start, and
 * counts its missed runs as its row does. Called while a component initialises, because it creates
 * queries.
 */
import type { ScheduleSummary } from '@lostgradient/weft';

import { createQuery, keepPreviousData } from '@tanstack/svelte-query';

import { getClient } from '../../lib/client.ts';
import { queryKeys } from '../../lib/query.ts';
import type { ScheduleOverlay } from '../../lib/schedule-kinds.ts';
import {
  loadModelAgents,
  loadScheduleRowSources,
  loadWorkflowAgents,
} from './schedule-row-context.ts';
import {
  scheduleRowOf,
  typesNeedingSavedSteps,
  type ScheduleRow,
  type ScheduleRowContext,
} from './schedule-row-model.ts';

/** What a page tells the queries: the schedules to make rows of, what the Bureau said of them, and the clock. */
export type ScheduleRowQueryInputs = {
  readonly schedules: () => readonly ScheduleSummary[];
  readonly overlay: () => ScheduleOverlay | undefined;
  /** The clock the next fire is counted from. */
  readonly now: () => number;
};

/** One row for each schedule, from the sources as far as they have answered. */
export function createScheduleRowQueries(inputs: ScheduleRowQueryInputs) {
  const client = getClient();

  const sources = createQuery(() => ({
    queryKey: queryKeys.schedules.rowContext(),
    queryFn: ({ signal }) => loadScheduleRowSources(client, { signal }),
    retry: false,
  }));

  // The workflows whose file cannot load or is gone have no steps of their own to say which agent
  // they run, so the last saved version does.
  const savedStepTypes = $derived(
    typesNeedingSavedSteps(inputs.schedules(), {
      overlay: inputs.overlay(),
      definitionNames: sources.data?.definitionNames,
    }),
  );
  const workflowAgents = createQuery(() => ({
    queryKey: queryKeys.schedules.workflowAgents(savedStepTypes),
    queryFn: ({ signal }) => loadWorkflowAgents(savedStepTypes, { signal }),
    enabled: savedStepTypes.length > 0,
    // The agents read so far stay while the next set loads, so a row never loses a reason it had.
    placeholderData: keepPreviousData,
    retry: false,
  }));

  function rowsOf(modelAgents: ReadonlySet<string> | undefined): ScheduleRow[] {
    const context: ScheduleRowContext = {
      overlay: inputs.overlay(),
      agents: sources.data?.agents,
      attention: sources.data?.attention,
      definitionNames: sources.data?.definitionNames,
      modelAgents,
      workflowAgents: workflowAgents.data ?? new Map(),
      now: inputs.now(),
    };
    return inputs.schedules().map((schedule) => scheduleRowOf(schedule, context));
  }

  // Which of the agents the rows name need a model is read from their definitions, so the rows are
  // made twice: once to learn the agents, and again with what is known of them.
  const usedAgentIds = $derived(
    [...new Set(rowsOf(undefined).flatMap((row) => row.agentIds))].toSorted(),
  );
  const modelAgents = createQuery(() => ({
    queryKey: queryKeys.schedules.modelAgents(usedAgentIds),
    queryFn: ({ signal }) => loadModelAgents(usedAgentIds, { signal }),
    enabled: usedAgentIds.length > 0,
    placeholderData: keepPreviousData,
    retry: false,
  }));

  return {
    /** One row for each schedule the page gave. */
    get rows(): ScheduleRow[] {
      return rowsOf(modelAgents.data);
    },
    /** The agents the Bureau lists, which name an agent a person reads. */
    get agents() {
      return sources.data?.agents;
    },
  };
}
