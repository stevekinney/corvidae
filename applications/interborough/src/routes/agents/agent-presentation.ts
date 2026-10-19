import { CHAT_COPY } from '../../app/copy.ts';
import type { AgentSummary } from '../../lib/bureau-client.ts';

/** Whether a chat can be started with the agent: only a published agent is offered. */
export function canChat(agent: AgentSummary): boolean {
  return agent.publishState === 'published';
}

/** The words for an agent's publish state. */
export function publishLabel(agent: AgentSummary): string {
  return agent.publishState === 'published'
    ? CHAT_COPY.agentPublished
    : CHAT_COPY.agentNotPublished;
}

/** The path that opens a new chat with `agent`. */
export function newChatPath(agent: string): string {
  return `/chat/new?agent=${encodeURIComponent(agent)}`;
}
