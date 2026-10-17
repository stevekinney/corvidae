import ChatComponent from './components/chat/index.ts';

export default ChatComponent;
export {
  deserializeChatComposerMention,
  parseChatComposerMentions,
  serializeChatComposerMention,
  type ChatComposerMention,
  type ChatComposerMentionParseResult,
  type ChatComposerMentionRange,
} from './components/chat-composer-popover/chat-composer-mention.ts';
export * from './components/chat/index.ts';
export {
  AGUIChatTransportError,
  AG_UI_UNSUPPORTED_EVENT_TYPES,
  createAGUIChatTransport,
  mapAGUIEventsToChatStream,
  type AGUIChatTransportErrorKind,
} from './session/ag-ui-transport.ts';
export {
  ChatRunFailureError,
  type ChatElicitationActivity,
  type ChatExecutionOwner,
  type ChatHistoryToken,
  type ChatRunAbortedNotice,
  type ChatSessionController,
  type ChatSessionControllerOptions,
  type ChatSessionHooks,
  type ChatSessionRequest,
  type ChatSessionTransport,
  type ChatSessionTransportResult,
  type ChatToolActivity,
} from './session/session-controller-support.ts';
export {
  createChatSession,
  createChatSessionController,
  createSessionController,
} from './session/session-controller.ts';
export {
  decodeChatStreamEvent,
  decodeChatStreamEvents,
  decodeStreamEvent,
  decodeStreamEvents,
  encodeChatStreamEvent,
  encodeStreamEvent,
  guardChatStreamEvents,
  type ChatSerializedRunError,
  type ChatStreamDecodeOptions,
  type ChatStreamEvent,
} from './session/stream-event-codec.ts';
