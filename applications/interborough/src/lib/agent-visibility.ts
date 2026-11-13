/**
 * Whether Chat offers an agent. A plugin may mark an agent `visibility: 'hidden'` (COR-2233): it is
 * still listed and still runs from a workflow, a child or a direct start, but Chat does not offer it
 * in a picker or choose it as a default. One predicate answers it for every place Chat offers or
 * defaults an agent.
 */
import type { AgentSummary } from './bureau-client.ts';

/**
 * `false` for a hidden agent. The agent a chat is already with (`current`) is still offered, so a
 * picker keeps showing the value it holds.
 */
export function isOfferedInChat(
  agent: Pick<AgentSummary, 'name' | 'visibility'>,
  current?: string,
): boolean {
  return agent.visibility !== 'hidden' || agent.name === current;
}
