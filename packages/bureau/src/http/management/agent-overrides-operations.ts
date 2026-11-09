import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';

/**
 * `bureau.agents.overrides.get` and `bureau.agents.overrides.update` (COR-2009): what a person
 * changed on a built-in agent, a code agent the host defines. Such an agent has no file, so its
 * Access and Settings tabs save overrides over what it states about itself, and every save is a
 * numbered version that `bureau.agents.versions.list` lists and `bureau.agents.versions.restore`
 * restores, as for a file agent. Access follows the agent definition operations: reading needs
 * `bureau.agents:read` and saving `bureau.agents:write`, unless the caller owns the deployment's
 * agents; anyone else is answered `NotFound`.
 *
 * @module agent-overrides-operations
 */

import { defineOperation } from '@lostgradient/weft';
import { z } from 'zod';

import { AGENT_IDENTIFIER_MAX_LENGTH } from '../../agent-file.ts';
import { ownerOfPrincipal } from '../owner-predicate.ts';
import {
  type BureauAgentDefinitionsOperationHost,
  faultOf,
  requireAccess,
} from './agent-definitions-operations.ts';
import {
  agentOverridesInputSchema,
  agentOverridesOutputSchema,
  auditOverrideWrite,
  overridesOf,
  overridesView,
} from './agent-overrides-wire.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

const agentIdentifier = z
  .string()
  .min(1)
  .max(AGENT_IDENTIFIER_MAX_LENGTH)
  .describe('The identifier of the built-in agent.');

const getInput = z.object({ id: agentIdentifier });
const getOutput = z.object({
  id: z.string(),
  /** The hash of the overrides in force, which a save names as its `expectedHash`. */
  hash: z.string(),
  /** The newest version, or `null` for an agent nobody changed. */
  version: z.number().int().positive().nullable(),
  overrides: agentOverridesOutputSchema,
  /**
   * The tools the agent states itself, by name, before any override: what it may use when
   * `overrides.tools` is `null`, and the set the Access tab shows a removed tool from so it can be
   * added back. The agent detail's `codeDefinition.tools` is the effective list instead.
   */
  ownTools: z.array(z.string()),
});

export const agentOverridesGetOperation = defineOperation<
  typeof getInput,
  typeof getOutput,
  BureauAgentDefinitionsOperationHost
>({
  name: 'bureau.agents.overrides.get',
  authorize: authorizeWorkspaceOperation('bureau.agents.overrides.get'),
  mcpExposable: false,
  summary: 'Read the saved overrides of a built-in agent',
  description:
    'Returns what a person changed on the built-in agent `id` (a code agent the host defines, not a plugin’s): its `overrides`, each key `null` when it is not overridden and the agent’s own value applies (`instructions`, the `tools` it may use, `approvals`, `guardrails`, `costBudget`, `toolBudget`, `model`, `models`, `effort`, `stepLimit`), the `version` they were saved as (`null` for an agent nobody changed, which has no versions), its `ownTools` (the tools the agent states itself, by name, before any override, which `codeDefinition.tools` on `bureau.agents.definitions.get` does not show once `tools` is overridden, so a removed tool can be added back), and their `hash`, which `bureau.agents.overrides.update` and `bureau.agents.versions.restore` take as `expectedHash`. An identifier that is no built-in agent is `NotFound`. Requires `bureau.agents:read` unless the caller owns the deployment’s agents; anyone else is answered `NotFound`.',
  destructive: false,
  tags: ['Agents'],
  inputSchema: getInput,
  outputSchema: getOutput,
  producibleFaults: ['InvalidParams', 'NotFound'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const definitions = requireAccess(host, principal, 'bureau.agents:read', input.id);
    const state = await definitions.agents.overrides.get(input.id);
    if (state === undefined) throw resourceNotFound('agent', input.id);
    return {
      id: input.id,
      hash: state.hash,
      version: state.version,
      overrides: overridesView(state.overrides),
      ownTools: [...definitions.agents.overrides.ownTools(input.id)],
    };
  },
});

const updateInput = z.object({
  id: agentIdentifier,
  expectedHash: z
    .string()
    .min(1)
    .describe(
      'The `hash` of the overrides the caller read; overrides that changed since are a `StaleRevision` fault and nothing is written.',
    ),
  overrides: agentOverridesInputSchema.describe(
    'The whole set of overrides to save; a key left out or `null` is not overridden, and the agent’s own value applies.',
  ),
});
const updateOutput = z.object({
  id: z.string(),
  hash: z.string(),
  /** The version now in force; `null` only when nothing was ever saved. */
  version: z.number().int().positive().nullable(),
});

export const agentOverridesUpdateOperation = defineOperation<
  typeof updateInput,
  typeof updateOutput,
  BureauAgentDefinitionsOperationHost
>({
  name: 'bureau.agents.overrides.update',
  authorize: authorizeWorkspaceOperation('bureau.agents.overrides.update'),
  mcpExposable: false,
  summary: 'Save the overrides of a built-in agent as a new version',
  description:
    'Saves `overrides` as the next version of the built-in agent `id`, if the overrides in force still hash to `expectedHash`, and returns the new `hash` and `version`. The set replaces the one in force: a key left out or `null` is no longer overridden. Overrides equal to those in force write nothing and return the same hash and version. Every save that made a version is appended to the audit trail as `agent.updated`, naming the version made and the one before it. A plugin’s agent or an agent file takes no overrides and is `Unprocessable` (`agent-file-read-only`); an identifier that is no agent is `NotFound`; overrides that changed since are `StaleRevision` with `currentRevision`; a tool the deployment does not hold (`unknown-tool`), an Asks entry on a tool the agent may not use (`unknown-approval-tool`), and a model the catalog lacks (`unknown-model`) or the model policy forbids (`model-policy-denied`) are `Unprocessable`; each writes nothing. Requires `bureau.agents:write` unless the caller owns the deployment’s agents; anyone else is answered `NotFound`.',
  destructive: true,
  tags: ['Agents'],
  inputSchema: updateInput,
  outputSchema: updateOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'StaleRevision', 'Unprocessable'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const definitions = requireAccess(host, principal, 'bureau.agents:write', input.id);
    try {
      const result = await definitions.agents.overrides.save(
        input.id,
        overridesOf(input.overrides),
        { expectedHash: input.expectedHash, savedBy: ownerOfPrincipal(principal) },
      );
      await auditOverrideWrite(host, principal, result, input.expectedHash);
      return result;
    } catch (error) {
      return faultOf(error, input.id, input.expectedHash);
    }
  },
});

/** The built-in agent override operations, in the order the handler serves them. */
export const bureauAgentOverridesOperations = [
  agentOverridesGetOperation,
  agentOverridesUpdateOperation,
] as const;
