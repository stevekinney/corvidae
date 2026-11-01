/**
 * Which agents use each executable skill. The Bureau lists skills without their users, so they are
 * read from each agent (`bureau.agents.definitions.get`): an agent defined in code names its skills
 * in `codeDefinition.skills`, and an agent file in `definition.allowedSkills`. A file's skill cards
 * (`skillDescriptors`) are descriptive and name nothing.
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
    agents.map(async (agent) => ({
      agent: agent.name,
      detail: await getAgentDefinition(agent.name, options),
    })),
  );
  const users = new Map<string, string[]>();
  for (const { agent, detail } of details) {
    const named = detail.codeDefinition?.skills ?? detail.definition?.allowedSkills ?? [];
    for (const skill of named) {
      const using = users.get(skill);
      if (using === undefined) users.set(skill, [agent]);
      else if (!using.includes(agent)) using.push(agent);
    }
  }
  return users;
}
