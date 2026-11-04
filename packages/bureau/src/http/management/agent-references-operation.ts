/**
 * `bureau.agents.references` (COR-2009): what names an agent by its identifier, so a page can say
 * what stops finding the agent before its identifier changes, it is disabled, or it is deleted:
 * the schedules that run it, the workflow files with a step that calls it (a file that cannot be
 * read as a workflow is read as text), and the hooks scoped to it. It changes nothing.
 *
 * It reads every schedule, workflow file and hook of the deployment, whoever owns them, because a
 * change to the agent breaks them all; so it needs `bureau.agents:read` unless the caller owns the
 * deployment's agents, as `bureau.agents.catalog` does. An agent the catalog does not hold is
 * `NotFound`.
 *
 * @module agent-references-operation
 */

import { defineOperation, type OperationFault } from '@lostgradient/weft';
import { z } from 'zod';

import type { AgentReferences } from '../../agent-references.ts';
import { mayAccessAgents } from '../agent-access.ts';
import type { BureauOwnershipHost } from '../owner-predicate.ts';
import {
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** What `bureau.agents.references` reads from the handler's `host`. */
export type BureauAgentReferencesOperationHost = BureauOwnershipHost & {
  readonly agentReferences: {
    /** Whether the catalog holds an agent with this identifier, ready or not. */
    readonly has: (agentName: string) => boolean;
    /** What names the agent now. */
    readonly find: (agentName: string) => Promise<AgentReferences>;
  };
};

const referencesInput = z.object({
  agentName: z.string().min(1).describe('The identifier of the agent whose references to list.'),
});

const referencesOutput = z.object({
  agentName: z.string(),
  /** The schedules whose every fire runs the agent, each with its `name` (`null` when it has none). */
  schedules: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
  /** The workflow files with a step that calls the agent, each with its `title` (`null` when it gives none or cannot be read). */
  workflows: z.array(z.object({ id: z.string(), title: z.string().nullable() })),
  /** The hooks scoped to the agent, each with its `name` (`null` when it has none). */
  hooks: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
});

/** `bureau.agents.references`. */
export const agentsReferencesOperation = defineOperation<
  typeof referencesInput,
  typeof referencesOutput,
  BureauAgentReferencesOperationHost
>({
  name: 'bureau.agents.references',
  mcpExposable: false,
  summary: 'List what names an agent',
  description:
    'Returns what finds the agent `agentName` by its identifier, and so stops finding it when the identifier changes, the agent is disabled, or it is deleted: `schedules` (each schedule whose fires run the agent, with its `id` and `name`), `workflows` (each workflow file with a step that calls the agent, with its `id` and `title`; a file that cannot be read as a workflow counts when its text names the agent) and `hooks` (each hook scoped to the agent, with its `id` and `name`). A name or title is `null` when there is none. It changes nothing. Requires `bureau.agents:read` unless the caller owns the deployment’s agents; anyone else is refused with `Forbidden`. An agent the catalog does not hold is `NotFound`.',
  destructive: false,
  tags: ['Agents'],
  inputSchema: referencesInput,
  outputSchema: referencesOutput,
  producibleFaults: ['InvalidParams', 'Forbidden', 'NotFound'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    if (!mayAccessAgents(host.ownership, principal, 'bureau.agents:read')) {
      throw {
        code: 'Forbidden',
        message: 'Listing what names an agent requires bureau.agents:read',
        data: { reason: 'missing scope bureau.agents:read' },
      } satisfies OperationFault;
    }
    if (!host.agentReferences.has(input.agentName)) {
      throw resourceNotFound('agent', input.agentName);
    }
    const found = await host.agentReferences.find(input.agentName);
    return {
      agentName: found.agentName,
      schedules: found.schedules.map((schedule) => ({ ...schedule })),
      workflows: found.workflows.map((workflow) => ({ ...workflow })),
      hooks: found.hooks.map((hook) => ({ ...hook })),
    };
  },
});
