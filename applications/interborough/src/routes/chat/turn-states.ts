import type { ChatTurnState, ConversationHistory, Message } from '@lostgradient/chat';

import type { ChatReconnect } from './chat-session.svelte.ts';

export function turnStateOf(
  message: Message,
  facts: { readonly reconnect: ChatReconnect | undefined; readonly lastAssistantId: string | undefined; readonly now: number },
): ChatTurnState | undefined {
  if (message.role !== 'assistant' || message.id !== facts.lastAssistantId) return undefined;
  const { reconnect } = facts;
  if (reconnect === undefined || !reconnect.runDropped) return undefined;
  return {
    kind: 'reconnecting',
    attempt: reconnect.attempt,
    attempts: reconnect.attempts,
    nextTryIn: Math.max(0, Math.ceil((reconnect.nextTryAt - facts.now) / 1000)),
    wait: Math.max(1, Math.ceil(reconnect.wait / 1000)),
  };
}

export function lastAssistantId(conversation: ConversationHistory): string | undefined {
  for (let index = conversation.ids.length - 1; index >= 0; index -= 1) {
    const id = conversation.ids[index];
    if (id === undefined || !Object.hasOwn(conversation.messages, id)) continue;
    if (conversation.messages[id]?.role === 'assistant') return id;
  }
  return undefined;
}
