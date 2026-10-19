import type { ConversationSummary } from '@lostgradient/chat';

import { CHAT_COPY } from '../../app/copy.ts';
import type { AgentSummary, ChatContext } from '../../lib/bureau-client.ts';

/**
 * A session as `ChatConversationList` shows it. The fields map as the Bureau gives them: `id`,
 * `createdAt`, `updatedAt` and `messageCount` from the summary; the title falls back to the words
 * for an untitled chat; `lastMessageText` is the preview, left out when there is none; the agent
 * is its identifier with the display name the agent list gives (one list for the screen, not one
 * call per row); and the list is never unread or archived.
 */
export function sessionSummary(
  context: ChatContext,
  agents: ReadonlyMap<string, AgentSummary>,
): ConversationSummary {
  const displayName = agents.get(context.agentName)?.displayName ?? context.agentName;
  return {
    id: context.id,
    title: context.title ?? CHAT_COPY.untitled,
    status: 'active',
    messageCount: context.messageCount,
    unreadCount: 0,
    createdAt: context.createdAt,
    updatedAt: context.updatedAt,
    participantNames: [displayName],
    agent: { id: context.agentName, name: displayName },
    activity: context.activity,
    ...(context.lastMessagePreview === null ? {} : { lastMessageText: context.lastMessagePreview }),
  };
}

/** The agents by identifier, for the display names a list of sessions needs. */
export function agentsByName(agents: readonly AgentSummary[]): ReadonlyMap<string, AgentSummary> {
  return new Map(agents.map((agent) => [agent.name, agent]));
}
