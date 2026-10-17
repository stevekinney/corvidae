import type {
  AssistantMessage,
  ContentPart,
  DeveloperMessage,
  Message,
  ReasoningMessage,
  SystemMessage,
  ToolCall,
  ToolMessage,
  UserMessage,
} from '@ag-ui/core';

/**
 * An AG-UI 1.0 message: the element type of a `MESSAGES_SNAPSHOT` event's
 * `messages` array. The type comes from the pinned `@ag-ui/core` package, so it
 * cannot drift from the protocol.
 */
export type AGUIMessage = Message;
export type AGUIDeveloperMessage = DeveloperMessage;
export type AGUISystemMessage = SystemMessage;
export type AGUIUserMessage = UserMessage;
export type AGUIAssistantMessage = AssistantMessage;
export type AGUIToolMessage = ToolMessage;
export type AGUIReasoningMessage = ReasoningMessage;
export type AGUIToolCall = ToolCall;
export type AGUIContentPart = ContentPart;
