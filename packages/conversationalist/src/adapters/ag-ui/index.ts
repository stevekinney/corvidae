import type { ConversationHistory as Conversation } from '../../types';
import { appendAGUIMessages, fromAGUIMessages } from './inbound';
import { toAGUIMessages } from './outbound';
import type { AGUIMessage } from './types';

export const agUiConversationAdapter = {
  export(conversation: Conversation): AGUIMessage[] {
    return toAGUIMessages(conversation);
  },
  import(messages: ReadonlyArray<AGUIMessage>): Conversation {
    return fromAGUIMessages(messages);
  },
  append(conversation: Conversation, messages: ReadonlyArray<AGUIMessage>): Conversation {
    return appendAGUIMessages(conversation, messages);
  },
} as const;
