/**
 * Which agents use each executable skill. The Bureau lists skills without their users, and only an
 * agent defined in code names skills (`codeDefinition.skills`, from `bureau.agents.definitions.get`),
 * so the users are read from those agents. An agent file lists none: its skill cards are descriptive.
 */
import { getAgentDefinition } from './agent-definitions.ts';
import { listAgents } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal };

/** The identifiers of the agents that name each skill, by the skill's name. A skill no agent names is absent. */
export async function listSkillUsers(
  options?: Options,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const agents = await listAgents(options);
  const details = await Promise.all(
    agents
      .filter((agent) => agent.kind === 'code')
      .map(async (agent) => ({
        agent: agent.name,
        detail: await getAgentDefinition(agent.name, options),
      })),
  );
  const users = new Map<string, string[]>();
  for (const { agent, detail } of details) {
    for (const skill of detail.codeDefinition?.skills ?? []) {
      const named = users.get(skill);
      if (named === undefined) users.set(skill, [agent]);
      else if (!named.includes(agent)) named.push(agent);
    }
  }
  return users;
}
