/**
 * The typed agent discovery tool (AB-22) — moved here from operative,
 * rebuilt against `BureauAgentCatalog<D>` instead of the deleted
 * `AgentRegistry`. Exposes descriptive metadata only: each agent's name, plus
 * the optional `description` and `skillDescriptors` (COR-1301) its definition
 * carries. It reads fields already on the catalog's `RunnableAgent` objects
 * and never resolves a lazy agent.
 */

import { createTool } from 'armorer';
import { z } from 'zod';

import type { AgentDefinitions, BureauAgentCatalog } from './agent-catalog';

/** What discovery reads of one agent: the same fields whether the agent is code-defined or a file. */
type DiscoverableAgent = {
  readonly name: string;
  readonly agent: {
    readonly description?: string | undefined;
    readonly skillDescriptors?: readonly unknown[] | undefined;
  };
};

/**
 * Creates a tool that lets an orchestrating agent discover the agents
 * registered on this bureau's catalog. A Bureau offers it to agents itself as
 * `bureau:discover-agents`, through its built-in plugin (COR-1890); this function
 * builds the same tool over any catalog, for a supervisor. `text`, when supplied,
 * case-insensitively substring-matches against an agent's name, its
 * `description`, and each of its `skillDescriptors`' name, description, and
 * tags. Each match is returned as `{ name, description, skillDescriptors }`;
 * the last two are omitted for an agent that declares none.
 *
 * It covers every agent the deployment has: the code-defined agents, then the ready file agents
 * (a file agent's name is its identifier, `plugin:name` for one a plugin ships). A file that is
 * `invalid` cannot run and is left out. Every agent is listed to every caller; per-agent access
 * control is COR-1853.
 */
export function createAgentDiscoveryTool<D extends AgentDefinitions>(
  catalog: Pick<BureauAgentCatalog<D>, 'entries' | 'list' | 'find'>,
) {
  return createTool({
    name: 'discover-agents',
    version: '1.0.0',
    description:
      'Discover available agents on this bureau by searching their names, descriptions, and skills.',
    // Read-only, so an agent file that lists it runs it without asking (COR-1890).
    metadata: { readOnly: true, shortDescription: 'Find the agents on this Bureau.' },
    input: z.object({
      text: z
        .string()
        .optional()
        .describe(
          "Search text to match (case-insensitively) against agent names and descriptions, and each skill's name, description, and tags.",
        ),
    }),
    execute: ({ text }) => {
      const lowerText = text?.toLowerCase();
      const agents: DiscoverableAgent[] = catalog.entries();
      const taken = new Set(agents.map(({ name }) => name));
      // `list` carries no skill descriptors, so a file agent is read from the catalog by identifier.
      for (const listing of catalog.list()) {
        if (listing.source !== 'file' || listing.state !== 'ready' || taken.has(listing.id))
          continue;
        const agent = catalog.find(listing.id);
        if (agent !== undefined) agents.push({ name: listing.id, agent });
      }
      const matches = agents.filter(({ name, agent }) => {
        if (!lowerText) {
          return true;
        }
        // Defensive reads: a hand-written or untyped agent can hold a
        // malformed descriptor, which must not fail discovery for the
        // whole catalog.
        const skills = Array.isArray(agent.skillDescriptors) ? agent.skillDescriptors : [];
        const searchable = [
          name,
          agent.description,
          ...skills.flatMap((skill) => [
            skill?.name,
            skill?.description,
            ...(Array.isArray(skill?.tags) ? skill.tags : []),
          ]),
        ];
        return searchable.some(
          (value) => typeof value === 'string' && value.toLowerCase().includes(lowerText),
        );
      });
      return Promise.resolve(
        JSON.stringify(
          matches.map(({ name, agent }) => ({
            name,
            ...(agent.description === undefined ? {} : { description: agent.description }),
            ...(agent.skillDescriptors === undefined
              ? {}
              : { skillDescriptors: agent.skillDescriptors }),
          })),
        ),
      );
    },
  });
}
