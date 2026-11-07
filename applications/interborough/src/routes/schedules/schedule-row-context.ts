/**
 * What the Schedules list reads besides the schedules themselves: the agents the Bureau lists (to
 * name each and to know which need a model), what needs attention (who missed runs, whether a
 * provider is connected), the workflow types the engine can run (to tell a workflow whose file
 * cannot load from one that was deleted), and the agents a workflow ran in its last saved version
 * (a file that cannot load has no steps of its own to say). Each is read on its own and left out
 * when it does not answer, so a row says only what is known: no source's failure holds the list.
 */
import type { HttpClient } from '@lostgradient/weft';

import { getAgentDefinition, getAgentOverrideModel } from '../../lib/agent-definitions.ts';
import type { ScheduleAttention } from '../../lib/bureau-attention.ts';
import { readScheduleAttention } from '../../lib/bureau-attention.ts';
import { listAgents, type AgentSummary } from '../../lib/bureau-client.ts';
import { listDefinitions } from '../../lib/workflow-catalog.ts';
import { getLatestSavedSteps } from '../../lib/workflow-files.ts';
import { agentsOfSteps } from './schedule-row-model.ts';

/** The sources a row is made from beyond the schedule and its overlay, each `undefined` until it answers. */
export type ScheduleRowSources = {
  readonly agents: readonly AgentSummary[] | undefined;
  readonly attention: ScheduleAttention | undefined;
  readonly definitionNames: ReadonlySet<string> | undefined;
};

/** Reads the agents, what needs attention, and the engine's workflow types. */
export async function loadScheduleRowSources(
  client: HttpClient,
  options?: { readonly signal?: AbortSignal },
): Promise<ScheduleRowSources> {
  const [agents, attention, definitions] = await Promise.allSettled([
    listAgents(options),
    readScheduleAttention(options),
    listDefinitions(client),
  ]);
  return {
    agents: agents.status === 'fulfilled' ? agents.value : undefined,
    attention: attention.status === 'fulfilled' ? attention.value : undefined,
    definitionNames:
      definitions.status === 'fulfilled'
        ? new Set(definitions.value.map((definition) => definition.name))
        : undefined,
  };
}

/**
 * The agents each of these workflows ran in its last saved version, for the workflows whose file
 * cannot load or is gone. A workflow with no saved version, or whose history could not be read, has
 * no entry.
 */
export async function loadWorkflowAgents(
  workflowTypes: readonly string[],
  options?: { readonly signal?: AbortSignal },
): Promise<ReadonlyMap<string, readonly string[]>> {
  const settled = await Promise.allSettled(
    workflowTypes.map(async (type) => [type, await getLatestSavedSteps(type, options)] as const),
  );
  const agents = new Map<string, readonly string[]>();
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    const [type, steps] = result.value;
    if (steps !== undefined) agents.set(type, agentsOfSteps(steps));
  }
  return agents;
}

/**
 * Which of these agents name a model, so a schedule that runs one waits for a provider. Assistant
 * and Echo are scripted and name none. An agent whose definition cannot be read is left out, so a
 * schedule is never said to be blocked by a provider on a guess.
 */
export async function loadModelAgents(
  agentIds: readonly string[],
  options?: { readonly signal?: AbortSignal },
): Promise<ReadonlySet<string>> {
  const settled = await Promise.allSettled(
    agentIds.map(async (id) => {
      const detail = await getAgentDefinition(id, options);
      const model = detail.definition?.model ?? detail.codeDefinition?.model;
      if (model !== undefined && model !== null && model !== '') return [id, true] as const;
      if (detail.source !== 'code') return [id, false] as const;
      // A built-in agent's definition names no model while no provider serves it; the model a
      // person chose for it is in its overrides.
      const chosen = await getAgentOverrideModel(id, options).catch(() => null);
      return [id, chosen !== null && chosen !== ''] as const;
    }),
  );
  const named = new Set<string>();
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value[1]) named.add(result.value[0]);
  }
  return named;
}
