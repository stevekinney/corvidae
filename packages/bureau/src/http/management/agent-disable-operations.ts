/**
 * `bureau.agents.disable` and `bureau.agents.enable` (COR-2429, rows 38y and 40d of COR-2020): turn
 * an agent off and on again without deleting it. A built-in agent can be disabled but never
 * deleted; its chats stay, read-only, until it is enabled. The disabled agents are one durable gate
 * (`agent-disabled-store.ts`) that the catalog's lookup of an agent by name consults, so no chat,
 * run, schedule, workflow step or hook starts on a disabled agent, while its page, chats, memory,
 * versions and overrides can still be read. Access follows the agent definition operations:
 * `bureau.agents:write`, unless the caller owns the deployment's agents; anyone else is answered
 * `NotFound`.
 *
 * @module agent-disable-operations
 */

import { defineOperation } from '@lostgradient/backchannel';
import { z } from 'zod';

import { AGENT_IDENTIFIER_MAX_LENGTH } from '../../agent-file.ts';
import { auditTrailAgentOwnerId } from '../../audit-trail.ts';
import { ownerOfPrincipal } from '../owner-predicate.ts';
import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';
import {
  type BureauAgentDefinitionsOperationHost,
  requireAccess,
} from './agent-definitions-operations.ts';
import { dryRunField, dryRunResult, orDryRun } from './dry-run.ts';
import type { BureauDryRunHost } from './dry-run-references.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

const input = z.object({
  id: z
    .string()
    .min(1)
    .max(AGENT_IDENTIFIER_MAX_LENGTH)
    .describe('The identifier of the agent: a built-in agent, a plugin’s, or an agent file.'),
});

const output = z.object({
  id: z.string(),
  /** Whether the agent is disabled now. */
  disabled: z.boolean(),
});

/** Records the change on the audit trail, naming the agent and who changed it. */
async function auditToggle(
  host: BureauAgentDefinitionsOperationHost,
  principal: Parameters<typeof ownerOfPrincipal>[0],
  type: 'agent.disabled' | 'agent.enabled',
  id: string,
): Promise<void> {
  const actor = ownerOfPrincipal(principal);
  await host.agentDefinitions.audit({
    runId: auditTrailAgentOwnerId(id),
    type,
    detail: { id, agentName: id },
    ...(actor === undefined ? {} : { principal: actor }),
  });
}

const disableInput = input.extend({ dryRun: dryRunField });
const disableAnswer = orDryRun(output);

export const agentsDisableOperation = defineOperation<
  typeof disableInput,
  typeof disableAnswer,
  BureauAgentDefinitionsOperationHost & BureauDryRunHost
>({
  name: 'bureau.agents.disable',
  authorize: authorizeWorkspaceOperation('bureau.agents.disable'),
  mcpExposable: false,
  supportsDryRun: true,
  summary: 'Disable an agent until it is enabled again',
  description:
    'Disables the agent `id` (a built-in agent the host defines, the agent of a running plugin, `plugin:name`, or an agent file) durably, without deleting anything, and returns `disabled: true`. A disabled agent is listed with state `disabled` by `bureau.agents.definitions.list` and `.get`, and can still be read: its definition, versions, overrides, chats and memory. No new chat, run, schedule, workflow step or hook can start on it, because every lookup of an agent by name consults the one gate this operation writes: `bureau.agents.list` leaves it out, a run that names it is refused as an unknown agent, and it opts into no A2A. `bureau.agents.enable` brings it back as it was. Disabling an agent that is already disabled changes nothing. The change is appended to the audit trail as `agent.disabled`. An identifier that is no agent, and the agent of a disabled plugin (state `unavailable`, which runs nothing already), is `NotFound`. Requires `bureau.agents:write` unless the caller owns the deployment’s agents; anyone else is answered `NotFound`. With `dryRun: true` nothing is disabled and no audit entry is written: the answer is `{ dryRun: true, target, effects }`, whose `schedules`, `goals` and `open-chats` effects count the schedules, unfinished goals and unarchived chats that name the agent and so could no longer start on it, and an identifier the real call would not find answers `NotFound` as well.',
  destructive: true,
  tags: ['Agents'],
  inputSchema: disableInput,
  outputSchema: disableAnswer,
  producibleFaults: ['InvalidParams', 'NotFound'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input: request, host, principal }) => {
    const definitions = requireAccess(host, principal, 'bureau.agents:write', request.id);
    if (request.dryRun === true) {
      // The check `disable` makes before it writes, and nothing else.
      if (!definitions.agents.canDisable(request.id)) throw resourceNotFound('agent', request.id);
      return dryRunResult(
        { kind: 'agent', id: request.id },
        await host.dryRun.agentEffects(request.id),
      );
    }
    const toggled = await definitions.agents.disable(request.id, {
      disabledBy: ownerOfPrincipal(principal) ?? 'local',
    });
    if (toggled === undefined) throw resourceNotFound('agent', request.id);
    // Only the call that wrote the record audits it: of two disables at once, one (COR-2429).
    if (toggled.changed) await auditToggle(host, principal, 'agent.disabled', request.id);
    return { id: request.id, disabled: true };
  },
});

export const agentsEnableOperation = defineOperation<
  typeof input,
  typeof output,
  BureauAgentDefinitionsOperationHost
>({
  name: 'bureau.agents.enable',
  authorize: authorizeWorkspaceOperation('bureau.agents.enable'),
  mcpExposable: false,
  summary: 'Enable an agent a person disabled',
  description:
    'Enables the agent `id` that `bureau.agents.disable` disabled, so chats, runs, schedules, workflow steps and hooks find it again, and returns `disabled: false`. Enabling an agent that is not disabled changes nothing. The change is appended to the audit trail as `agent.enabled`. An identifier that is no agent is `NotFound`. Requires `bureau.agents:write` unless the caller owns the deployment’s agents; anyone else is answered `NotFound`.',
  destructive: false,
  tags: ['Agents'],
  inputSchema: input,
  outputSchema: output,
  producibleFaults: ['InvalidParams', 'NotFound'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input: request, host, principal }) => {
    const definitions = requireAccess(host, principal, 'bureau.agents:write', request.id);
    const toggled = await definitions.agents.enable(request.id);
    if (toggled === undefined) throw resourceNotFound('agent', request.id);
    if (toggled.changed) await auditToggle(host, principal, 'agent.enabled', request.id);
    return { id: request.id, disabled: false };
  },
});

/** The disable and enable operations, in the order the handler serves them. */
export const bureauAgentDisableOperations = [
  agentsDisableOperation,
  agentsEnableOperation,
] as const;
