import type { ConversationHistory as Conversation, Message } from '../types';
import { getOwn, setOwn } from './type-helpers';

export function getOrderedMessages(conversation: Conversation): Message[] {
  const ordered: Message[] = [];
  for (const id of conversation.ids) {
    const message = getOwn(conversation.messages, id);
    if (message) {
      ordered.push(message);
    }
  }
  return ordered;
}

export function toIdRecord<T extends { id: string }>(items: readonly T[]): Record<string, T> {
  const record: Record<string, T> = {};
  for (const item of items) {
    setOwn(record, item.id, item);
  }
  return record;
}
