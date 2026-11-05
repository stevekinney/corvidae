import type { ConversationHistory as Conversation } from '../../types';
import type { AGUIExportOptions } from './created-at';
import { appendAGUIMessages, fromAGUIMessages } from './inbound';
import { toAGUIMessages } from './outbound';
import type { AGUIMessage } from './types';

export const agUiConversationAdapter = {
  export(conversation: Conversation, options?: AGUIExportOptions): AGUIMessage[] {
    return toAGUIMessages(conversation, options);
  },
  import(messages: ReadonlyArray<AGUIMessage>): Conversation {
    return fromAGUIMessages(messages);
  },
  append(conversation: Conversation, messages: ReadonlyArray<AGUIMessage>): Conversation {
    return appendAGUIMessages(conversation, messages);
  },
} as const;
