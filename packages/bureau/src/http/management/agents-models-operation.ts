/**
 * `bureau.agents.models`: the models an agent allows a session of it to be switched to, and the
 * model its next step would use with no override (COR-1559).
 *
 * The answer follows the agent's own declaration (`agent-models.ts`). A file agent is selectable:
 * its `model` is the default and its `models` list, or the deployment's catalog without one,
 * says what else it allows. A code-defined agent is selectable when its profile is, fixed when
 * one model is attached, and neither routed nor opaque ones offer a choice. Any authenticated
 * caller may ask about an agent `bureau.agents.list` lists to it; any other name is `NotFound`, so
 * a caller without `bureau.agents:read` cannot learn of an agent that does not opt into A2A.
 *
 * @module agents-models-operation
 */

import { defineOperation } from '@lostgradient/weft';
import { z } from 'zod';

import type { AgentModels } from '../../agent-models.ts';
import { agentsVisibleTo, type BureauDeploymentOperationHost } from './deployment-operations.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What `bureau.agents.models` reads from the handler's `host`. */
export type BureauAgentModelsOperationHost = {
  readonly agentModels: {
    /** What the named agent allows, or `undefined` when the Bureau has no such agent. */
    describe(agentName: string): AgentModels | undefined;
  };
};

const modelChoiceSchema = z.object({
  provider: z.string(),
  model: z.string(),
  /** The deployment's catalog holds no label of its own, so this is the provider-native model name. */
  displayName: z.string(),
});

const agentsModelsInput = z.object({
  agentName: z.string().min(1).describe('The name of the agent whose allowed models to list.'),
});

const agentsModelsOutput = z.object({
  /** Whether a session of the agent can be switched between models. */
  selectable: z.boolean(),
  models: z.array(modelChoiceSchema),
  /** The catalog row the agent’s next step would use with no override, or `null` when not known. */
  default: modelChoiceSchema.pick({ provider: true, model: true }).nullable(),
});

export const agentsModelsOperation = defineOperation<
  typeof agentsModelsInput,
  typeof agentsModelsOutput,
  BureauAgentModelsOperationHost & BureauDeploymentOperationHost
>({
  name: 'bureau.agents.models',
  mcpExposable: false,
  summary: 'List the models an agent allows',
  description:
    'Returns the models a session of `agentName` can be switched to through `bureau.contexts.steer`: `selectable`, `models` (each with `provider`, `model` and `displayName`, the provider-native model name, since the deployment’s catalog holds no label of its own) and `default`, the catalog row the agent’s next step would use with no override, or `null` when that is not known. A persisted agent (an agent file) is selectable: its frontmatter `model` is the default, its `models` list, filtered to the models the deployment’s catalog holds, says what is allowed, and without a list the whole catalog is. A code-defined agent with `allowedCandidates` (or a selectable profile naming none, which allows the whole catalog) is selectable the same way. A fixed agent is not selectable and lists its one model; a routed or opaque agent is not selectable and lists none. Any authenticated caller may ask about an agent `bureau.agents.list` lists to it (every ready agent with `bureau.agents:read`, only the ones that opt into A2A without it); any other name answers `NotFound`.',
  destructive: false,
  tags: ['Agents'],
  inputSchema: agentsModelsInput,
  outputSchema: agentsModelsOutput,
  producibleFaults: ['InvalidParams', 'NotFound'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    // Only an agent listed to this caller (ready, and opted into A2A for a caller without
    // `bureau.agents:read`) has models to describe.
    const listed = agentsVisibleTo(principal, host.deployment.agents()).find(
      (agent) => agent.name === input.agentName,
    );
    const described = listed === undefined ? undefined : host.agentModels.describe(input.agentName);
    if (described === undefined) throw resourceNotFound('agent', input.agentName);
    return {
      selectable: described.selectable,
      models: described.models.map((choice) => ({ ...choice })),
      default:
        described.default === null
          ? null
          : { provider: described.default.provider, model: described.default.model },
    };
  },
});
