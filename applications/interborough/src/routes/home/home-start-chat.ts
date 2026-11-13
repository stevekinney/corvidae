/**
 * What Home's Start a chat card decides before it hands off to New chat: which agent it starts with
 * and the address it opens. Plain functions, so a test reads them without the card.
 */
import { isOfferedInChat } from '../../lib/agent-visibility.ts';
import type { AgentSummary } from '../../lib/bureau-client.ts';

/**
 * The Assistant a host lists, or `undefined`: `assistant`, or a plugin's copy of it
 * (`demo:assistant`). Assistant is scripted and needs no model, but a host only has one where a
 * plugin contributes it (the demo plugin, off by default) or the host registers one, so a page that
 * offers Assistant asks first.
 */
export function findAssistant(agents: readonly Pick<AgentSummary, 'name'>[]): string | undefined {
  return (
    agents.find((agent) => agent.name === 'assistant') ??
    agents.find((agent) => agent.name.endsWith(':assistant'))
  )?.name;
}

/**
 * The agent Home starts with: Assistant, which is scripted and needs no model, so Send works with no
 * provider connected. It is `assistant`, or a plugin's copy of it (`demo:assistant`). A host that
 * lists no Assistant starts with its first agent, and one with no agents starts with none. An agent
 * a plugin hides from Chat is never the one Home starts with.
 */
export function startingAgent(
  agents: readonly Pick<AgentSummary, 'name' | 'visibility'>[],
): string | undefined {
  const offered = agents.filter((agent) => isOfferedInChat(agent));
  return findAssistant(offered) ?? offered[0]?.name;
}

/**
 * The agents Home's select offers: every listed agent but a hidden one, unless the card is already
 * with it (`selected`), so the select keeps showing the value it holds.
 */
export function startChatAgents<T extends Pick<AgentSummary, 'name' | 'visibility'>>(
  agents: readonly T[],
  selected: string | undefined,
): T[] {
  return agents.filter((agent) => isOfferedInChat(agent, selected));
}

/** The address Send opens: New chat with `agent`. The message is handed over apart from the address (`new-chat-handoff.ts`). */
export function newChatAddress(agent: string): string {
  return `/chats/new?${new URLSearchParams({ agent }).toString()}`;
}
