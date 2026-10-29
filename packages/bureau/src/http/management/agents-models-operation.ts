/**
 * `bureau.agents.models`: the models an agent allows a session of it to be switched to, and the
 * model its next step would use with no override (COR-1559).
 *
 * The answer follows the agent's own declaration (`agent-models.ts`). A file agent is selectable:
 * its `model` is the default and its `models` list, or the deployment's catalog without one,
 * says what else it allows. A code-defined agent is selectable when its profile is, fixed when
 * one model is attached, and neither routed nor opaque ones offer a choice. Any authenticated
 * caller may ask about a published agent. An agent the deployment does not publish exists only for
 * a caller who may read agent definitions, the rule `bureau.agents.list` applies; to anyone else it
 * is `NotFound`, as an agent that does not exist is.
 *
 * @module agents-models-operation
 */

import { defineOperation } from '@lostgradient/weft';
import { z } from 'zod';

import type { AgentModels } from '../../agent-models.ts';
import { mayDiscloseUnpublishedAgents } from '../agent-access.ts';
import type { BureauOwnershipHost } from '../owner-predicate.ts';
import type { BureauDeploymentOperationHost } from './deployment-operations.ts';
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
  BureauAgentModelsOperationHost & BureauDeploymentOperationHost & BureauOwnershipHost
>({
  name: 'bureau.agents.models',
  mcpExposable: false,
  summary: 'List the models an agent allows',
  description:
    'Returns the models a session of `agentName` can be switched to through `bureau.contexts.steer`: `selectable`, `models` (each with `provider`, `model` and `displayName`, the provider-native model name, since the deployment’s catalog holds no label of its own) and `default`, the catalog row the agent’s next step would use with no override, or `null` when that is not known. A persisted agent (an agent file) is selectable: its frontmatter `model` is the default, its `models` list, filtered to the models the deployment’s catalog holds, says what is allowed, and without a list the whole catalog is. A code-defined agent with `allowedCandidates` (or a selectable profile naming none, which allows the whole catalog) is selectable the same way. A fixed agent is not selectable and lists its one model; a routed or opaque agent is not selectable and lists none. Any authenticated caller may ask about a published agent. An agent the deployment does not publish exists only for a caller who owns the deployment’s agents or holds `bureau.agents:read`, as in `bureau.agents.list`; to anyone else it answers `NotFound`, as an agent that does not exist does.',
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
    // An unpublished agent's name and models reach only a caller who may see it in
    // `bureau.agents.list`; to anyone else it is indistinguishable from an agent that does not exist.
    const listed = host.deployment
      .publishedAgents()
      .find((agent) => agent.name === input.agentName);
    const visible =
      listed !== undefined &&
      (listed.publishState === 'published' ||
        mayDiscloseUnpublishedAgents(host.ownership, principal));
    const described = visible ? host.agentModels.describe(input.agentName) : undefined;
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
