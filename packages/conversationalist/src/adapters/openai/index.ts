import type { ConversationHistory as Conversation } from '../../types';
import { appendOpenAIMessages, fromOpenAIMessages } from './inbound';
import { toOpenAIMessages, toOpenAIMessagesGrouped } from './outbound';
import type { OpenAIConversationExportOptions, OpenAIExport, OpenAIMessage } from './types';

export const openAIConversationAdapter = {
  export(conversation: Conversation, options: OpenAIConversationExportOptions = {}): OpenAIExport {
    return options.groupToolCalls === false
      ? toOpenAIMessages(conversation, options)
      : toOpenAIMessagesGrouped(conversation, options);
  },
  import(messages: ReadonlyArray<OpenAIMessage>): Conversation {
    return fromOpenAIMessages(messages);
  },
  append(conversation: Conversation, messages: ReadonlyArray<OpenAIMessage>): Conversation {
    return appendOpenAIMessages(conversation, messages);
  },
} as const;
