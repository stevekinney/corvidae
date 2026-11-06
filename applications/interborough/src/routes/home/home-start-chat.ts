/**
 * What Home's Start a chat card decides before it hands off to New chat: which agent it starts with
 * and the address it opens. Plain functions, so a test reads them without the card.
 */
import type { AgentSummary } from '../../lib/bureau-client.ts';

/**
 * The agent Home starts with: Assistant, which is scripted and needs no model, so Send works with no
 * provider connected. It is `assistant`, or a plugin's copy of it (`demo:assistant`). A host that
 * lists no Assistant starts with its first agent, and one with no agents starts with none.
 */
export function startingAgent(agents: readonly Pick<AgentSummary, 'name'>[]): string | undefined {
  return (
    agents.find((agent) => agent.name === 'assistant') ??
    agents.find((agent) => agent.name.endsWith(':assistant')) ??
    agents[0]
  )?.name;
}

/** The address Send opens: New chat with `agent`. The message is handed over apart from the address (`new-chat-handoff.ts`). */
export function newChatAddress(agent: string): string {
  return `/chats/new?${new URLSearchParams({ agent }).toString()}`;
}
