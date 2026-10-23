import type { AgentSummary } from '../../lib/bureau-client.ts';

/** The most prompts an agent's card offers. */
export const MAXIMUM_EXAMPLE_PROMPTS = 3;

/**
 * The prompts an agent's card offers: the agent's own `examples`, with empty ones left out, and no
 * more than {@link MAXIMUM_EXAMPLE_PROMPTS}. An agent that suggests none offers none.
 */
export function examplePrompts(agent: Pick<AgentSummary, 'examples'>): readonly string[] {
  return (agent.examples ?? [])
    .map((prompt) => prompt.trim())
    .filter((prompt) => prompt !== '')
    .slice(0, MAXIMUM_EXAMPLE_PROMPTS);
}

/**
 * The agents a new chat can start with: the published ones, in the Bureau's order. A withdrawn or
 * unpublished agent cannot take a chat, so it is not offered.
 */
export function startableAgents(agents: readonly AgentSummary[]): readonly AgentSummary[] {
  return agents.filter((agent) => agent.publishState === 'published');
}
