/**
 * Which agents a model provider serves, so a person disconnecting it sees what loses its model
 * first. An agent names its model as `<provider>/<model>`, in `model` and in the `models` a session
 * may be switched to; a file agent states them in its definition and a code agent in its own
 * statement of itself (`bureau.agents.definitions.get`). The list of agents carries neither, so each
 * agent is read, as `skill-users.ts` does for skills. An agent whose file does not parse names
 * nothing the Bureau can read and is left out.
 */
import { getAgentDefinition } from './agent-definitions.ts';
import { listAgents } from './bureau-client.ts';

type Options = { readonly signal?: AbortSignal };

/** An agent that names a model of a provider. */
export type ProviderAgent = {
  /** The agent's identifier, which its page is addressed by. */
  readonly id: string;
  /** The name the agent is shown by. */
  readonly displayName: string;
};

/** The provider a `<provider>/<model>` name belongs to, or `undefined` for a name without a slash. */
function providerOf(model: string): string | undefined {
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : undefined;
}

/**
 * The agents that name a model of `provider`, in the Bureau's order. Rejects when the agents cannot
 * be read, so the caller can say the list is unknown instead of showing an empty one.
 */
export async function listProviderAgents(
  provider: string,
  options?: Options,
): Promise<readonly ProviderAgent[]> {
  const agents = await listAgents(options);
  const details = await Promise.all(
    agents.map(async (agent) => ({
      agent,
      detail: await getAgentDefinition(agent.name, options),
    })),
  );
  const found: ProviderAgent[] = [];
  for (const { agent, detail } of details) {
    const named = [
      detail.definition?.model,
      ...(detail.definition?.models ?? []),
      detail.codeDefinition?.model,
      ...(detail.codeDefinition?.models ?? []),
    ];
    if (
      named.some((model) => model !== null && model !== undefined && providerOf(model) === provider)
    ) {
      found.push({ id: agent.name, displayName: agent.displayName });
    }
  }
  return found;
}
