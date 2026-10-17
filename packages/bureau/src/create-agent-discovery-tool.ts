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

/**
 * Creates a tool that lets an orchestrating agent discover the agents
 * registered on this bureau's catalog. `text`, when supplied,
 * case-insensitively substring-matches against an agent's name, its
 * `description`, and each of its `skillDescriptors`' name, description, and
 * tags. Each match is returned as `{ name, description, skillDescriptors }`;
 * the last two are omitted for an agent that declares none.
 */
export function createAgentDiscoveryTool<D extends AgentDefinitions>(
  catalog: BureauAgentCatalog<D>,
) {
  return createTool({
    name: 'discover-agents',
    description:
      'Discover available agents on this bureau by searching their names, descriptions, and skills.',
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
      const matches = catalog.entries().filter(({ name, agent }) => {
        if (!lowerText) {
          return true;
        }
        const searchable = [
          name,
          agent.description,
          ...(agent.skillDescriptors ?? []).flatMap((skill) => [
            skill.name,
            skill.description,
            ...skill.tags,
          ]),
        ];
        return searchable.some((value) => value?.toLowerCase().includes(lowerText));
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
