/**
 * The wire shape of a built-in agent's saved overrides (COR-2009), shared by
 * `bureau.agents.overrides.*` and the versions operations, which list and restore a built-in
 * agent's versions as they do a file agent's.
 *
 * On the wire every override key is present, `null` when it is not overridden and the agent's
 * own value applies. A save sends the whole set: a key left out or `null` is not overridden.
 *
 * @module agent-overrides-wire
 */

import type { Principal } from '@lostgradient/weft';
import { z } from 'zod';

import {
  agentContributionIdsSchema,
  agentCostBudgetSchema,
  agentDefaultEffortSchema,
  agentStepLimitSchema,
  agentToolApprovalSchema,
  agentToolBudgetSchema,
} from '../../agent-file.ts';
import {
  AGENT_OVERRIDE_KEYS,
  type AgentOverrides,
  type AgentOverrideVersionRecord,
} from '../../agent-override-store.ts';
import { auditTrailAgentOwnerId } from '../../audit-trail.ts';
import { ownerOfPrincipal } from '../owner-predicate.ts';
import type { BureauAgentDefinitionsOperationHost } from './agent-definitions-operations.ts';

/** A built-in agent's overrides as the wire shows them: every key, `null` when not overridden. */
export const agentOverridesOutputSchema = z.object({
  /** The instructions in place of the agent's own. */
  instructions: z.string().nullable(),
  /** The tools the agent may use, by catalog name; the Access tab's allowed set. */
  tools: z.array(z.string()).nullable(),
  /** When each tool asks a person first, by tool name. */
  toolApproval: agentToolApprovalSchema.nullable(),
  /** The plugin guardrails (`plugin:name`) a run applies. */
  guardrails: agentContributionIdsSchema.nullable(),
  /** What one run, and one chat, may spend. */
  costBudget: agentCostBudgetSchema.nullable(),
  /** What one run's tools may use. */
  toolBudget: agentToolBudgetSchema.nullable(),
  /** The model a chat starts on, `<provider>/<model>`. */
  model: z.string().nullable(),
  /** The models a chat may be switched to. */
  models: z.array(z.string()).nullable(),
  /** The reasoning effort a chat starts at. */
  defaultEffort: agentDefaultEffortSchema.nullable(),
  /** The most steps one run may take. */
  stepLimit: z.number().int().nullable(),
});

/** What a save sends: any override key, `null` or left out when it is not overridden. */
export const agentOverridesInputSchema = z.strictObject({
  instructions: z.string().min(1).nullable().optional(),
  tools: z.array(z.string().min(1)).nullable().optional(),
  toolApproval: agentToolApprovalSchema.nullable().optional(),
  guardrails: agentContributionIdsSchema.nullable().optional(),
  costBudget: agentCostBudgetSchema.nullable().optional(),
  toolBudget: agentToolBudgetSchema.nullable().optional(),
  model: z.string().min(1).nullable().optional(),
  models: z.array(z.string().min(1)).nullable().optional(),
  defaultEffort: agentDefaultEffortSchema.nullable().optional(),
  stepLimit: agentStepLimitSchema.nullable().optional(),
});

/** `overrides` as the wire shows them, every key present. */
export function overridesView(
  overrides: AgentOverrides,
): z.infer<typeof agentOverridesOutputSchema> {
  const view: Record<string, unknown> = {};
  for (const key of AGENT_OVERRIDE_KEYS) {
    view[key] = overrides[key] === undefined ? null : structuredClone(overrides[key]);
  }
  return view as z.infer<typeof agentOverridesOutputSchema>;
}

/** The overrides a save sent, without the keys it leaves to the agent. */
export function overridesOf(input: z.infer<typeof agentOverridesInputSchema>): AgentOverrides {
  const overrides: Record<string, unknown> = {};
  for (const key of AGENT_OVERRIDE_KEYS) {
    const value = input[key];
    if (value !== null && value !== undefined) overrides[key] = value;
  }
  return overrides;
}

/** A built-in agent's version in the shape `bureau.agents.versions.list` gives every version. */
export function overrideVersionView(record: AgentOverrideVersionRecord) {
  return {
    revision: record.version,
    hash: record.hash,
    savedAt: record.savedAt,
    savedBy: record.savedBy,
    owner: record.owner,
    definition: null,
    overrides: overridesView(record.overrides),
    referenceDigests: null,
    changedKeys: [...record.changedKeys],
  };
}

/** The tools in `next` and not in `previous`, joined by commas, or `undefined` when there are none. */
function joinedDifference(
  next: readonly string[],
  previous: readonly string[],
): string | undefined {
  const before = new Set(previous);
  const added = next.filter((tool) => !before.has(tool));
  return added.length === 0 ? undefined : added.join(',');
}

/**
 * Appends the audit entry of a save or restore of built-in agent `id`'s overrides that made a new
 * version: `agent.updated`, filed under the agent and attributed to the caller, naming the version
 * it made and the one it replaced, the keys that changed, and the tools it allowed or took away
 * (against the agent's own tools where a version does not override them). A save that changed
 * nothing is not audited.
 */
export async function auditOverrideWrite(
  host: BureauAgentDefinitionsOperationHost,
  principal: Principal,
  result: { readonly id: string; readonly hash: string },
  previousHash: string,
): Promise<void> {
  if (result.hash === previousHash) return;
  const agents = host.agentDefinitions.agents;
  const versions = await agents.overrides.versions(result.id).catch(() => [] as const);
  const index = versions.findIndex((version) => version.hash === result.hash);
  const current = versions[index];
  const previous = index === -1 ? undefined : versions[index + 1];
  const detail = await agents.detail(result.id);
  const ownTools = detail?.codeDefinition?.tools ?? [];
  const toolsNow = current?.overrides.tools ?? ownTools;
  const toolsBefore = previous?.overrides.tools ?? ownTools;
  const toolsAdded = joinedDifference(toolsNow, toolsBefore);
  const toolsRemoved = joinedDifference(toolsBefore, toolsNow);
  const actor = ownerOfPrincipal(principal);
  await host.agentDefinitions.audit({
    runId: auditTrailAgentOwnerId(result.id),
    type: 'agent.updated',
    detail: {
      id: result.id,
      hash: result.hash,
      previousHash,
      agentName: result.id,
      ...(current === undefined ? {} : { revision: current.version }),
      ...(previous === undefined ? {} : { previousRevision: previous.version }),
      ...(current === undefined || current.changedKeys.length === 0
        ? {}
        : { changedKeys: current.changedKeys.join(',') }),
      ...(toolsAdded === undefined ? {} : { toolsAdded }),
      ...(toolsRemoved === undefined ? {} : { toolsRemoved }),
    },
    ...(actor === undefined ? {} : { principal: actor }),
  });
}
