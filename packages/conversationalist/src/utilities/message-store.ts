import type { ConversationHistory as Conversation, Message } from '../types';
import { getOwn } from './type-helpers';

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
    // Assignment would turn the id `__proto__` into "set the prototype" and drop the item.
    Object.defineProperty(record, item.id, {
      value: item,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return record;
}
