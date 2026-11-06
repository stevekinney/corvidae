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

/**
 * The address Send opens: New chat with `agent`, and the typed `message` for New chat to send as
 * the chat's first message. A message that is only blank is not one, so New chat opens empty.
 */
export function newChatAddress(agent: string, message: string): string {
  const search = new URLSearchParams({ agent });
  const text = message.trim();
  if (text !== '') search.set('message', text);
  return `/chats/new?${search.toString()}`;
}
